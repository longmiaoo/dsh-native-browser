import { BrowserError, errorCode, checkAbort, type ActionResult } from '../../contracts/src/index.js';

export type PagePurpose = 'temporary' | 'deliverable' | 'handoff';
type Page = { tab: string; instanceId: string; leaseId: string; scope: string; purpose: PagePurpose; live: boolean };
type Task = { pages: Map<string, Page>; phase: string; action: string; startedAt: number; updatedAt: number;
  error?: string; attention?: string; lastResult?: Pick<ActionResult, 'outcome' | 'dispatch' | 'postcondition'>;
  pending: number; finishing?: Promise<unknown> };

function recovery(error: unknown): string {
  const code = errorCode(error);
  if (['CONNECTION_LOST', 'PROTOCOL_MISMATCH'].includes(code)) return 'check-connection';
  if (['LEASE_REVOKED', 'USER_STOPPED', 'CANCELLED', 'LEASE_BUSY'].includes(code)) return 'wait-control';
  if (['STALE_TARGET', 'AMBIGUOUS_TARGET', 'NOT_ACTIONABLE'].includes(code)) return 'refresh-target';
  if (['POLICY_DENIED', 'UNSUPPORTED_CAPABILITY'].includes(code)) return 'respect-policy';
  return 'verify-result';
}

/** Host-owned metadata only: no page text, credentials, URLs or tool arguments. */
export class BrowserTasks {
  private readonly tasks = new Map<string, Task>();
  private get(id: string): Task {
    let task = this.tasks.get(id);
    if (!task) {
      if (this.tasks.size >= 128) throw new BrowserError('QUEUE_FULL', 'Browser task status capacity reached');
      task = { pages: new Map(), phase: 'idle', action: '', startedAt: Date.now(), updatedAt: Date.now(), pending: 0 };
      this.tasks.set(id, task);
    }
    return task;
  }
  begin(id: string, action: string) {
    const task = this.get(id);
    if (task.finishing) throw new BrowserError('LEASE_BUSY', 'Browser task is finishing; wait for cleanup');
    if (action === 'open' && task.pages.size >= 64) throw new BrowserError('QUEUE_FULL', 'Browser task page capacity reached');
    task.pending++; task.phase = 'running'; task.action = action; task.updatedAt = Date.now(); delete task.error;
    return (error?: unknown, value?: unknown) => {
      task.pending--; task.updatedAt = Date.now();
      if (error) { task.error = errorCode(error); task.attention = recovery(error); }
      else if ((action === 'act' || action === 'batch') && value && typeof value === 'object') {
        const result = value as ActionResult;
        if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(result.outcome)
          && ['notDispatched', 'dispatched', 'observed'].includes(result.dispatch)
          && ['passed', 'failed', 'unverified'].includes(result.postcondition)) {
          // Keep only the bounded receipt, never page data, input or raw errors.
          task.lastResult = { outcome: result.outcome, dispatch: result.dispatch, postcondition: result.postcondition };
          if (result.outcome !== 'succeeded' || result.postcondition !== 'passed') {
            // Once input may have reached the page, its business result still
            // needs verification. A fenced, undispatched action can instead
            // explain the connection/control/target boundary that rejected it.
            task.attention = result.dispatch === 'notDispatched' && result.code
              ? recovery(new BrowserError(result.code, 'Browser action was not dispatched')) : 'verify-result';
          }
          else delete task.attention;
        }
      }
      // A read returning successfully is not proof that an earlier input worked.
      // Late settlement must not revive a handed-off/completed task either.
      if (task.phase === 'running' && task.pending === 0) task.phase = task.attention ? 'attention' : 'ready';
    };
  }
  opened(id: string, scope: string, lease: { tab: string; instanceId: string; leaseId: string }) {
    const task = this.get(id);
    task.pages.set(lease.tab, { ...lease, scope, purpose: 'temporary', live: true });
  }
  claimed(id: string, scope: string, lease: { tab: string; leaseId: string }) {
    const page = this.get(id).pages.get(lease.tab);
    // A fresh explicit claim can restore cleanup authority; no automatic claim.
    if (page) { page.scope = scope; page.leaseId = lease.leaseId; page.live = true; }
  }
  mark(id: string, scope: string, leaseId: string, purpose: PagePurpose) {
    const task = this.get(id), page = [...task.pages.values()].find(p => p.leaseId === leaseId && p.scope === scope && p.live);
    if (!page) throw new BrowserError('POLICY_DENIED', 'Only a currently controlled task-created page can be marked');
    page.purpose = purpose; task.updatedAt = Date.now();
  }
  revoked(leaseId: string) {
    for (const task of this.tasks.values()) for (const page of task.pages.values()) if (page.leaseId === leaseId) page.live = false;
  }
  handoff(id: string, leaseId: string) {
    const task = this.tasks.get(id);
    if (task) for (const page of task.pages.values()) if (page.leaseId === leaseId) page.purpose = 'handoff';
  }
  closed(id: string, leaseId: string) {
    const task = this.tasks.get(id);
    if (task) for (const [tab, page] of task.pages) if (page.leaseId === leaseId) task.pages.delete(tab);
  }
  interrupted(id: string) {
    const task = this.tasks.get(id); if (!task) return;
    if (task.phase !== 'completed') task.phase = 'handed-off'; task.updatedAt = Date.now();
    for (const page of task.pages.values()) page.live = false;
  }
  status(id: string) {
    const task = this.tasks.get(id);
    if (!task) return { phase: 'idle', action: '', pages: [], pending: 0 };
    return { phase: task.phase, action: task.action, startedAt: task.startedAt, updatedAt: task.updatedAt,
      pending: task.pending, ...(task.error ? { error: task.error } : {}),
      ...(task.attention ? { attention: task.attention } : {}),
      ...(task.lastResult ? { lastResult: { ...task.lastResult } } : {}),
      pages: [...task.pages.values()].map(p => ({ leaseId: p.leaseId, purpose: p.purpose, controlled: p.live })) };
  }
  async finish(id: string, scope: string, close: (leaseId: string, signal: AbortSignal) => Promise<void>, signal: AbortSignal,
    pendingAllowance = 0, release: () => Promise<void> = async () => {}) {
    const task = this.get(id);
    if (task.finishing) return task.finishing;
    if (task.pending > pendingAllowance) throw new BrowserError('LEASE_BUSY', 'Browser actions are still running; cleanup was not started');
    task.phase = 'finishing'; task.updatedAt = Date.now();
    const work = async () => {
      let closed = 0, retained = 0, skipped = 0;
      for (const [tab, page] of task.pages) {
        checkAbort(signal);
        if (page.purpose !== 'temporary') { retained++; continue; }
        if (!page.live || page.scope !== scope) { skipped++; continue; }
        try {
          await close(page.leaseId, signal); task.pages.delete(tab); closed++;
        } catch (error) {
          checkAbort(signal); skipped++; page.live = false; task.error = errorCode(error);
        }
      }
      await release(); checkAbort(signal);
      task.phase = skipped ? 'attention' : 'completed'; task.updatedAt = Date.now();
      return { closed, retained, skipped, status: this.status(id) };
    };
    task.finishing = work();
    try { return await task.finishing; }
    catch (error) { task.phase = 'attention'; task.error = errorCode(error); task.updatedAt = Date.now(); throw error; }
    finally { delete task.finishing; }
  }
  delete(id: string) { this.tasks.delete(id); }
  clear() { this.tasks.clear(); }
}
