import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BrowserError, browserKeys, elementStates, checkAbort, originOf, type BatchRequest, type Screenshot } from '../../contracts/src/index.js';
import { actionRequest, batchRequest, observeOptions, pageReadOptions, record, string, visualBox } from '../../contracts/src/validation.js';
import { connectBroker, type BrokerConnection } from '../../broker/src/client.js';
import { runtimeRenewalCapability } from '../../contracts/src/wire.js';
import { defaultDirectory } from '../../broker/src/local-state.js';
import type { RpcPeer } from '../../transport-native/src/rpc.js';
import { ScreenshotRegistry } from '../../vision-adapter/src/screenshots.js';
import { visualActionFromScreenshot } from '../../vision-adapter/src/grounding.js';
import { createSetupController } from './setup.js';
import { registerHostRoutes } from './host-routes.js';
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from './approval-policy.js';
import { BrowserTasks, type PagePurpose } from './tasks.js';
import { LeaseKeepAlive } from './lease-keepalive.js';

export const name = 'dsh-native-browser';
export const inject = ['tools', 'connection'];
export const TOOL_NAMESPACE = 'native_browser';
export const projectStatus = Object.freeze({ phase: 'development-preview', browser: 'chrome', toolsRegistered: true, toolNamespace: TOOL_NAMESPACE });

interface Execution { name: string; callId: string; signal: AbortSignal; agent?: { session: { id: string } } }
interface Context {
  tools: { register(definition: any): void };
  on(event: string, listener: (...args: any[]) => any): void;
  effect(callback: () => () => void | Promise<void>): void;
  get?(service: string): any;
}
type Config = { runtimeDirectory?: string; approvalMode?: ApprovalMode; trustedOrigins?: string[]; legacyToolNames?: boolean };
type TurnScope = { sessionId: string; wireSessionId: string; controller: AbortController; keeper?: LeaseKeepAlive };
type PendingCapture = { scope: TurnScope; leaseId: string; controller: AbortController; peer?: RpcPeer };
type BatchApproval = { scope: TurnScope; request: BatchRequest; exec: Execution; peer: RpcPeer; signal: AbortSignal; next: number };
const schemaString = { type: 'string' };
const fileActionKinds: ReadonlySet<string> = new Set(['upload', 'choose', 'download']);
const toolName = (shortName: string) => `${TOOL_NAMESPACE}_${shortName}`;

/** Uses the public raw ToolDefinition seam. No DSH internal module imports. */
export function apply(ctx: Context, config: Config = {}): void {
  const approvalMode = config.approvalMode ?? DEFAULT_APPROVAL_MODE;
  const legacyToolNames = config.legacyToolNames ?? false;
  if (!['per-action', 'per-lease', 'trusted', 'personal'].includes(approvalMode)) {
    throw new BrowserError('INVALID_REQUEST', 'approvalMode must be per-action, per-lease, trusted or personal');
  }
  if (config.trustedOrigins !== undefined && (!Array.isArray(config.trustedOrigins) || config.trustedOrigins.length > 64)) {
    throw new BrowserError('INVALID_REQUEST', 'trustedOrigins must be an array of at most 64 exact origins');
  }
  const trustedOrigins = new Set((config.trustedOrigins ?? []).map(value => originOf(string(value, 8192))));
  if (approvalMode === 'trusted' && trustedOrigins.size === 0) {
    throw new BrowserError('INVALID_REQUEST', 'trusted approval mode requires at least one exact trustedOrigins entry');
  }
  if (approvalMode === 'personal' && trustedOrigins.size !== 0) {
    throw new BrowserError('INVALID_REQUEST', 'personal approval mode requires a personal Broker, not trustedOrigins');
  }
  if (typeof legacyToolNames !== 'boolean') throw new BrowserError('INVALID_REQUEST', 'legacyToolNames must be a boolean');
  // Private recovery capability survives a Broker reconnect, never grants a lease or reaches the model.
  const journalKey = randomBytes(32).toString('hex');
  let connection: Promise<BrokerConnection> | undefined;
  let disposed = false;
  const sessions = new Map<string, TurnScope>();
  const tasks = new BrowserTasks();
  // Once the UI selects a conversation, releasing its predecessor must also
  // fence NEW claims from the predecessor's still-running model loop.
  let foregroundSessionId: string | null | undefined;
  const foregroundDenial = (sessionId: string | undefined) => foregroundSessionId !== undefined && foregroundSessionId !== sessionId
    ? foregroundSessionId === null
      ? 'No active DSH conversation is synchronized from the client. This request was blocked before contacting Chrome; this is NOT a busy tab lease. Select this conversation in the DSH client and restore foreground synchronization. Do not tell the user to close browser tabs, release a supposed old lease, or bypass through Bash/CDP.'
      : 'Browser control moved to another DSH conversation. This conversation is in the background: stop browser work and do not reclaim, reopen tabs, or switch to Bash/CDP. Wait for the user to select this conversation again, then obtain a fresh lease.' : undefined;
  const executions = new WeakMap<Execution, TurnScope>();
  const registeredTools = new Set<string>();
  const screenshots = new ScreenshotRegistry();
  const captures = new Set<PendingCapture>();
  const batchApprovals = new Map<string, BatchApproval>();
  const revokeCaptureLease = (owner: string, leaseId: string) => {
    screenshots.revokeLease(owner, leaseId);
    for (const capture of captures) if (capture.scope.wireSessionId === owner && capture.leaseId === leaseId) {
      capture.controller.abort(new BrowserError('LEASE_REVOKED', 'Screenshot control was released before publication'));
    }
  };
  // Capture ownership BEFORE approval. The execution object is the public DSH
  // object shared by pre-execute and the registered body, even across async asks.
  const bind = (exec: Execution): TurnScope => {
    let scope = executions.get(exec);
    if (scope) return scope;
    const sessionId = string(exec.agent?.session.id);
    scope = sessions.get(sessionId);
    if (!scope) {
      scope = { sessionId, wireSessionId: randomUUID(), controller: new AbortController() };
      sessions.set(sessionId, scope);
    }
    executions.set(exec, scope);
    return scope;
  };
  const executionScope = (exec: Execution) => {
    if (disposed) throw new BrowserError('CONNECTION_LOST', 'Plugin disposed');
    const denial = foregroundDenial(exec.agent?.session.id);
    if (denial) throw new BrowserError('LEASE_REVOKED', denial);
    const scope = executions.get(exec);
    if (!scope || scope.sessionId !== exec.agent?.session.id) {
      throw new BrowserError('POLICY_DENIED', 'Browser execution did not pass its owning approval boundary');
    }
    const signal = AbortSignal.any([exec.signal, scope.controller.signal]);
    checkAbort(signal);
    return { scope, signal };
  };
  const peer = async () => {
    if (disposed) throw new BrowserError('CONNECTION_LOST', 'Plugin disposed');
    if (!connection) {
      const attempt = connectBroker(config.runtimeDirectory ?? defaultDirectory(), journalKey, { requirePersonal: approvalMode === 'personal' });
      connection = attempt;
      void attempt.then(value => {
        value.handle(async (method, raw, remoteSignal) => {
          if (method !== 'browser.approveBatchStep') throw new BrowserError('POLICY_DENIED', 'Unexpected Broker request');
          const p = record(raw), pending = batchApprovals.get(string(p.approvalId, 128));
          if (Object.keys(p).some(key => !['approvalId', 'index'].includes(key)) || !pending || pending.peer !== value
            || connection !== attempt || !Number.isInteger(p.index) || p.index !== pending.next || pending.next >= pending.request.steps.length)
            throw new BrowserError('POLICY_DENIED', 'No matching active batch approval');
          const signal = AbortSignal.any([pending.signal, remoteSignal, pending.scope.controller.signal]);
          checkAbort(signal);
          const index = pending.next++; // A lost/duplicate approval request cannot consume another grant.
          if (approvalMode !== 'per-action') return { allowed: true };
          const approval = ctx.get?.('approval');
          if (typeof approval?.request !== 'function') return { allowed: false };
          const step = pending.request.steps[index]!;
          const digest = createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 16);
          // The existing Host callId exposes immutable full batch arguments. Avoid
          // duplicating input text/page data into the approval reason's audit log.
          const decision = await approval.request({ agent: pending.exec.agent, toolName: pending.exec.name, callId: pending.exec.callId,
            reason: `Approve only step ${index + 1}/${pending.request.steps.length}: ${step.action.kind}. Review that exact step in this call's batch arguments (digest ${digest}). Later steps require separate approval; completed effects cannot be rolled back.`, signal });
          checkAbort(signal);
          if (decision === 'cancelled') throw new BrowserError('CANCELLED', 'Batch step approval was cancelled');
          return { allowed: decision === 'allowed-once' };
        });
        value.onEvent((event, raw) => {
          if (connection !== attempt || event !== 'browser.lease-revoked') return;
          const data = record(raw);
          if (Object.keys(data).length !== 2) throw new BrowserError('INVALID_REQUEST', 'Invalid lease revocation');
          revokeCaptureLease(string(data.sessionId), string(data.leaseId));
          tasks.revoked(string(data.leaseId));
          for (const scope of sessions.values()) if (scope.wireSessionId === data.sessionId) scope.keeper?.forget(string(data.leaseId));
        });
        value.onCloseEvent(() => {
          for (const capture of captures) if (capture.peer === value) {
            capture.controller.abort(new BrowserError('CONNECTION_LOST', 'Screenshot Broker connection ended'));
          }
          // A successor connection cannot be cleared by an obsolete peer.
          if (connection === attempt) {
            connection = undefined; screenshots.clear();
            for (const scope of sessions.values()) { scope.keeper?.stop(); delete scope.keeper; }
          }
        });
        if (disposed) value.close();
      }, () => { if (connection === attempt) connection = undefined; });
    }
    return connection;
  };
  const run = async (method: string, params: Record<string, unknown>, exec: Execution) => {
    const { scope, signal } = executionScope(exec);
    const channel = await peer();
    checkAbort(signal);
    return channel.call(method, { ...params, sessionId: scope.wireSessionId }, signal);
  };
  const maintain = async (scope: TurnScope, lease: { leaseId: string; expiresAt: number }) => {
    if (approvalMode !== 'personal') return;
    const channel = await peer();
    checkAbort(scope.controller.signal);
    if (!channel.brokerCapabilities.includes(runtimeRenewalCapability)) return;
    if (!scope.keeper) scope.keeper = new LeaseKeepAlive(async (leaseId, signal) => {
      const denial = foregroundDenial(scope.sessionId);
      if (disposed || denial || sessions.get(scope.sessionId) !== scope) throw new BrowserError('LEASE_REVOKED', denial ?? 'Browser task ended');
      const value = record(await channel.call('browser.renew', { leaseId, sessionId: scope.wireSessionId }, signal));
      return { expiresAt: Number(value.expiresAt) };
    }, scope.controller.signal);
    scope.keeper.track(lease.leaseId, lease.expiresAt);
  };
  const publicLease = (raw: unknown) => {
    const lease = record(raw), leaseId = string(lease.id);
    if (typeof lease.expiresAt !== 'number' || !Number.isFinite(lease.expiresAt)) {
      throw new BrowserError('INTERNAL_ERROR', 'Broker returned an invalid lease expiry');
    }
    // The provider token and wire-session owner are internal capabilities. Besides
    // reducing exposure, a single explicit leaseId prevents models from confusing
    // the provider token with the public ID expected by every subsequent tool.
    const scope = lease.scope === undefined ? 'origin' : lease.scope;
    if (scope !== 'origin' && scope !== 'tab') throw new BrowserError('INTERNAL_ERROR', 'Broker returned an invalid lease scope');
    return { leaseId, id: leaseId, tab: string(lease.tab), instanceId: string(lease.instanceId),
      origin: string(lease.origin), scope, expiresAt: lease.expiresAt };
  };
  const claim = async (args: Record<string, unknown>, exec: Execution) => {
    const instanceId = string(args.instanceId), tab = string(args.tab);
    if (approvalMode === 'trusted') {
      const listed = await run('browser.tabs', { instanceId }, exec);
      if (!Array.isArray(listed) || listed.length > 10_000) throw new BrowserError('INTERNAL_ERROR', 'Broker returned an invalid tab list');
      const candidate = listed.find(raw => {
        try { const value = record(raw); return string(value.id) === tab && string(value.instanceId) === instanceId; }
        catch { return false; }
      });
      if (!candidate || !trustedOrigins.has(originOf(string(record(candidate).url, 8192)))) {
        throw new BrowserError('POLICY_DENIED', 'Trusted mode only controls tabs on an exact configured trusted origin');
      }
    }
    const raw = await run('browser.claim', { instanceId, tab }, exec);
    const lease = publicLease(raw);
    if (approvalMode === 'personal' && lease.scope !== 'tab') {
      await run('browser.release', { leaseId: lease.leaseId }, exec).catch(() => {});
      throw new BrowserError('POLICY_DENIED', 'Personal approval mode requires a Broker started with --access-mode=personal');
    }
    if (approvalMode === 'trusted' && !trustedOrigins.has(originOf(lease.origin))) {
      // Close a tab that changed origins between inventory and grant before the
      // capability can be returned to the model.
      await run('browser.release', { leaseId: lease.leaseId }, exec).catch(() => {});
      throw new BrowserError('POLICY_DENIED', 'Claimed tab left the configured trusted origin');
    }
    tasks.claimed(string(exec.agent?.session.id), executionScope(exec).scope.wireSessionId, lease);
    await maintain(executionScope(exec).scope, lease);
    return lease;
  };
  const releaseScope = (sessionId: string, message: string) => {
    const scope = sessions.get(sessionId);
    if (!scope) return false;
    // Abort synchronously before the asynchronous Broker release. Any command
    // already dispatched remains non-replayable; commands still waiting at an
    // approval, socket, queue or provider fence cannot cross this boundary.
    scope.controller.abort(new BrowserError('LEASE_REVOKED', message));
    screenshots.revokeOwner(scope.wireSessionId);
    sessions.delete(sessionId);
    tasks.interrupted(sessionId);
    void connection?.then(p => p.call('browser.releaseSession', { sessionId: scope.wireSessionId }, AbortSignal.timeout(3000))).catch(() => {});
    return true;
  };
  const releaseBackgroundScopes = (foregroundSessionId: string | null) => {
    let released = 0;
    for (const sessionId of [...sessions.keys()]) {
      if (sessionId !== foregroundSessionId && releaseScope(sessionId, 'Browser control moved to another foreground DSH conversation')) released++;
    }
    return released;
  };
  /** Local-file actions are approved individually in EVERY mode: a page can steer the
   * model toward a sensitive path, so personal/per-lease/trusted grants never cover them.
   * per-action already asked in tools/pre-execute for this exact call. Fails closed. */
  async function approveFileAction(action: ReturnType<typeof actionRequest>['action'], exec: Execution): Promise<void> {
    if (action.kind !== 'upload' && action.kind !== 'choose' && action.kind !== 'download') return;
    if (approvalMode === 'per-action') return;
    const approval = ctx.get?.('approval');
    if (typeof approval?.request !== 'function') {
      throw new BrowserError('POLICY_DENIED', 'File upload and download require the DSH approval service; none is available');
    }
    const files = action.kind === 'download' ? [] : action.files;
    const listed = files.slice(0, 10).map(file => `  ${file}`).join('\n');
    const reason = action.kind === 'download'
      ? 'Allow this page to download a file? Chrome saves it to its own download folder and the saved path is returned to the assistant.'
      : `Allow the assistant to give ${files.length} local file(s) to this web page?\n${listed}${files.length > 10 ? `\n  …and ${files.length - 10} more` : ''}\nOnly approve files you intend this site to receive.`;
    const decision = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal });
    checkAbort(exec.signal);
    if (decision === 'cancelled') throw new BrowserError('CANCELLED', 'File action approval was cancelled');
    if (decision !== 'allowed-once') throw new BrowserError('POLICY_DENIED', 'The user did not approve this file action');
  }
  function addTool(name: string, definition: Omit<Record<string, unknown>, 'name'>) {
    const execute = definition.execute as (args: unknown, exec: Execution) => Promise<unknown>;
    ctx.tools.register({ name, ...definition, execute: (args: unknown, exec: Execution) => {
      if (name.endsWith('_task') && record(args).action === 'status') return execute(args, exec);
      // Includes direct-channel batch/capture paths; status polling is not work.
      executions.get(exec)?.keeper?.touch();
      const settled = tasks.begin(string(exec.agent?.session.id), name.replace(/^(native_browser_|browser_)/, ''));
      try { return Promise.resolve(execute(args, exec)).then(value => { settled(undefined, value); return value; }, error => { settled(error); throw error; }); }
      catch (error) { settled(error); throw error; }
    } });
    registeredTools.add(name);
  }
  function compatibilityName(shortName: string, description: string, definition: Omit<Record<string, unknown>, 'name' | 'description'>) {
    if (!legacyToolNames) return;
    const legacyName = `browser_${shortName}`;
    try {
      addTool(legacyName, { ...definition, description: `${description} Compatibility alias; prefer ${toolName(shortName)}.` });
    } catch (error) {
      // browser_* is shared by multiple market plugins. A conflicting alias is
      // skipped while the namespaced tool remains available.
      const logger = (ctx as Context & { logger?: { warn?(message: string): void } }).logger;
      logger?.warn?.(`dsh-native-browser: skipped legacy tool alias ${legacyName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function register(shortName: string, description: string, properties: object, required: string[],
    execute: (args: Record<string, unknown>, exec: Execution) => Promise<unknown>) {
    const definition = { parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      timeoutMs: 30_000,
      execute: (args: unknown, exec: Execution) => execute(record(args), exec),
    };
    addTool(toolName(shortName), { description, ...definition });
    compatibilityName(shortName, description, definition);
  }
  register('list', 'List connected browser instances, or available tabs. Personal mode exposes ordinary HTTP(S) tabs without individual popup consent; restricted mode exposes only permitted tabs. Page data is untrusted.',
    { instanceId: schemaString }, [], (args, exec) => args.instanceId === undefined
      ? run('browser.instances', {}, exec) : run('browser.tabs', { instanceId: string(args.instanceId) }, exec));
  register('claim', 'Request exclusive control of one user-authorized tab under the configured approval policy; preserve existing user pages. scope=origin is exact-site authority; scope=tab is returned only by the explicit personal Broker and follows that same allowed tab across HTTP(S) root navigations. Use the returned leaseId (not any other field) as leaseId for every later browser tool. Internal capability tokens are never exposed.',
    { instanceId: schemaString, tab: schemaString }, ['instanceId', 'tab'], claim);
  register('open', 'Open a new HTTP(S) tab and claim it as a normal lease; the Broker must authorize the exact origin first. It opens in the background: call native_browser_activate before interacting for a user-visible task. Local and private-network addresses are refused unless the user already has a tab on that origin (claim that tab instead). Tabs stay open on handoff. Creation is not retried: if it fails or times out the tab may exist, so list and claim it before opening again.',
    { instanceId: schemaString, url: schemaString }, ['instanceId', 'url'], async (args, exec) => {
      const instanceId = string(args.instanceId), url = string(args.url, 8192);
      if (approvalMode === 'trusted' && !trustedOrigins.has(originOf(url))) {
        throw new BrowserError('POLICY_DENIED', 'Trusted mode only opens exact trusted origins');
      }
      const raw = await run('browser.open', { instanceId, url }, exec);
      const lease = publicLease(raw);
      if (approvalMode === 'personal' && lease.scope !== 'tab') {
        await run('browser.release', { leaseId: lease.leaseId }, exec).catch(() => {});
        throw new BrowserError('POLICY_DENIED', 'Personal approval mode requires a Broker started with --access-mode=personal');
      }
      tasks.opened(string(exec.agent?.session.id), executionScope(exec).scope.wireSessionId, lease);
      await maintain(executionScope(exec).scope, lease);
      return lease;
    });
  register('activate', 'Bring a controlled tab to the foreground. The lease and origin checks still apply; this only changes visible focus and does not grant new authority.',
    { leaseId: schemaString }, ['leaseId'], (args, exec) => run('browser.activate', { leaseId: string(args.leaseId) }, exec));
  register('close', 'Close a tab created by native_browser_open. User tabs can never be closed by this tool; the extension rejects them. The lease is released after the close.',
    { leaseId: schemaString }, ['leaseId'], async (args, exec) => {
      const leaseId = string(args.leaseId), value = await run('browser.close', { leaseId }, exec);
      tasks.closed(string(exec.agent?.session.id), leaseId); return value;
    });
  const finishTask = async (sessionId: string, scope: TurnScope, signal: AbortSignal, pendingAllowance = 0) => {
    if (tasks.status(sessionId).pending <= pendingAllowance) { scope.keeper?.stop(); delete scope.keeper; }
    // Reserve cleanup synchronously before connection setup yields. Otherwise a
    // fresh tool can enter between turn completion and the cleanup reservation.
    return tasks.finish(sessionId, scope.wireSessionId, async (leaseId, currentSignal) => {
      const channel = await peer(); checkAbort(currentSignal);
      await channel.call('browser.close', { leaseId, sessionId: scope.wireSessionId }, currentSignal);
      revokeCaptureLease(scope.wireSessionId, leaseId);
    }, signal, pendingAllowance, async () => {
      const channel = await peer(); checkAbort(signal);
      await channel.call('browser.releaseSession', { sessionId: scope.wireSessionId }, signal);
      scope.keeper?.stop(); delete scope.keeper;
    });
  };
  register('task', 'Manage browser task lifecycle. status reports progress without page content. mark sets a controlled task-created page to temporary, deliverable (a live result the user needs) or handoff (waiting for login/input or unfinished work); mark before ending the turn and do not mark routine search or intermediate pages as deliverable. finish completes the work, closes still-controlled temporary task pages and releases control; revoked pages are skipped and reported, failed closes are not retried. Personal mode also cleans unmarked temporary pages after a confirmed completed turn; interruptions and conversation switches never close pages. User pages always stay open.',
    { action: { type: 'string', enum: ['status', 'mark', 'finish'] }, leaseId: schemaString,
      purpose: { type: 'string', enum: ['temporary', 'deliverable', 'handoff'] } }, ['action'], async (args, exec) => {
      const sessionId = string(exec.agent?.session.id), { scope, signal } = executionScope(exec);
      if (args.action === 'status') return tasks.status(sessionId);
      if (args.action === 'mark') {
        if (!['temporary', 'deliverable', 'handoff'].includes(String(args.purpose))) throw new BrowserError('INVALID_REQUEST', 'Invalid page purpose');
        await run('browser.validateLease', { leaseId: string(args.leaseId) }, exec);
        tasks.mark(sessionId, scope.wireSessionId, string(args.leaseId), args.purpose as PagePurpose);
        return tasks.status(sessionId);
      }
      if (args.action === 'finish') return finishTask(sessionId, scope, signal, 1);
      throw new BrowserError('INVALID_REQUEST', 'Invalid task action');
    });
  register('release_all', 'Release every browser lease owned by this DSH session while leaving all tabs open; screenshots are revoked. For completed work use native_browser_task action=finish instead, so temporary pages are cleaned before releasing control. Use release_all only when the user wants all current pages kept.',
    {}, [], async (_args, exec) => {
      const { scope } = executionScope(exec);
      screenshots.revokeOwner(scope.wireSessionId);
      scope.keeper?.stop(); delete scope.keeper;
      for (const capture of [...captures]) if (capture.scope === scope) {
        capture.controller.abort(new BrowserError('LEASE_REVOKED', 'Browser control was released'));
      }
      return run('browser.releaseSession', {}, exec);
    });
  register('observe', 'Read bounded, untrusted AX text, controls and named regions of the leased tab. Omit cursor for a full view; pass the returned cursor for changes against that exact base (delta = node upsert/remove, order, text splice). resyncRequired means the base, document or scope changed; truncated means incomplete. Use the current documentEpoch and refs. rootRef reads only that known subtree. query finds an EXACT case-sensitive accessible name (optional role) beyond the default bounds; it returns candidates and never picks one, so disambiguate duplicates from context. Repeat rootRef/query/frame on every cursor call; query results and subtrees are not whole pages. A node with editable:true is an editing host usable with fill/append/press; kind=region refs are read roots and scroll targets only. frame:{frameId,documentEpoch} reads one same-origin child discovered by native_browser_frames (all ancestors must share the lease origin; changed epochs need fresh discovery). It can combine with query or with a rootRef observed in that child, and a bad root fails instead of widening. Frame refs work only with act frame (child clicks) and read_page with the same frame. Regex, substring and cross-frame search are unsupported.',
    { leaseId: schemaString, cursor: schemaString, rootRef: schemaString,
      frame: { type: 'object', properties: { frameId: { type: 'string', minLength: 1, maxLength: 128 },
        documentEpoch: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['frameId', 'documentEpoch'], additionalProperties: false },
      query: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 1000 },
        role: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z][A-Za-z0-9]*$' } }, required: ['name'], additionalProperties: false } },
    ['leaseId'], (args, exec) => run('browser.observe', {
      leaseId: string(args.leaseId), ...observeOptions(args),
    }, exec));
  register('read_page', 'Read the next bounded live AX window of the document or a known rootRef. Omit continuation to start, then repeat the exact rootRef (and frame) with page.continuation. Tokens are single-use, expire after two minutes and grant no authority; no token means traversal ended; page.incomplete means content was omitted even at the end. A window is not a snapshot or delta: accumulate windows yourself and never replace a full-page baseline with one. Navigation, Stop, scope change, expiry, token reuse or a structure change on the active path fail closed. Only current DOM is traversed; virtualized items need approved scrolling. Narrow rootRef on capacity errors. frame:{frameId,documentEpoch} reads one discovered same-origin child (optionally with its own rootRef) using the child\'s epoch and refs, with no fallback to the root. No scrolling, cross-origin access, query mixing or input. Refs can age out of the cache; re-observe before acting.',
    { leaseId: schemaString, rootRef: schemaString, continuation: schemaString,
      frame: { type: 'object', properties: { frameId: { type: 'string', minLength: 1, maxLength: 128 },
        documentEpoch: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['frameId', 'documentEpoch'], additionalProperties: false } }, ['leaseId'], (args, exec) =>
      run('browser.readPage', { leaseId: string(args.leaseId), options: pageReadOptions({
        ...(args.frame === undefined ? {} : { frame: args.frame }),
        ...(args.rootRef === undefined ? {} : { rootRef: args.rootRef }),
        ...(args.continuation === undefined ? {} : { continuation: args.continuation }) }) }, exec));
  register('frames', 'Discover bounded frame structure of the leased tab: opaque frame IDs, parents, document epochs and origins only; no child text, titles, URLs, CDP sessions or contexts. contextStatus=known is not permission to access it; originRelation is relative to the root; truncated/unavailable means incomplete. Frame IDs are not node refs. Same-origin children can be read with observe/read_page frame and clicked with act frame using fresh child refs; discovery alone grants no input or cross-origin screenshot.',
    { leaseId: schemaString }, ['leaseId'], (args, exec) => run('browser.frames', { leaseId: string(args.leaseId) }, exec));
  const expected = { oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'value' }, value: schemaString }, required: ['kind', 'value'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'url' }, url: schemaString }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'text' }, text: schemaString }, required: ['kind', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'state' }, ref: { type: 'string', minLength: 1, maxLength: 128 },
      state: { type: 'string', enum: elementStates } }, required: ['kind', 'ref', 'state'], additionalProperties: false },
  ] };
  const action = { oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'check' }, ref: schemaString, checked: { type: 'boolean' },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'ref', 'checked'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'click' }, ref: schemaString, expected }, required: ['kind', 'ref'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'fill' }, ref: schemaString, text: schemaString, expected }, required: ['kind', 'ref', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'append' }, ref: schemaString, text: { type: 'string', maxLength: 10000 }, expected }, required: ['kind', 'ref', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'press' }, ref: schemaString,
      key: { type: 'string', enum: browserKeys }, shift: { type: 'boolean' }, expected }, required: ['kind', 'ref', 'key'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'navigate' }, url: schemaString, expected: { oneOf: expected.oneOf.slice(1, 3) } }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'scroll' }, ref: schemaString,
      deltaX: { type: 'integer', minimum: -10000, maximum: 10000 }, deltaY: { type: 'integer', minimum: -10000, maximum: 10000 },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'deltaX', 'deltaY'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'wheel' }, ref: schemaString,
      deltaX: { type: 'integer', minimum: -10000, maximum: 10000 }, deltaY: { type: 'integer', minimum: -10000, maximum: 10000 },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'ref', 'deltaX', 'deltaY'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'upload' }, ref: schemaString,
      files: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 4096 } },
      expected: { oneOf: expected.oneOf.slice(2, 4) } }, required: ['kind', 'ref', 'files'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'choose' }, ref: schemaString,
      files: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 4096 } },
      expected: { oneOf: expected.oneOf.slice(2, 4) } }, required: ['kind', 'ref', 'files'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'download' }, ref: schemaString,
      expected: { oneOf: expected.oneOf.slice(2, 4) } }, required: ['kind', 'ref'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'visual-click' }, screenshotId: schemaString,
      target: { type: 'string', minLength: 1, maxLength: 500 },
      box: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } },
        required: ['x1', 'y1', 'x2', 'y2'], additionalProperties: false },
      expected: { oneOf: expected.oneOf.slice(2, 4) } },
    required: ['kind', 'screenshotId', 'target', 'box'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'dialog' }, accept: { type: 'boolean' },
      promptText: { type: 'string', maxLength: 1000 }, expected: { oneOf: expected.oneOf.slice(2, 4) } },
    required: ['kind', 'accept'], additionalProperties: false },
  ] };
  register('act', 'Perform one browser action on a leased tab: click, fill, append, press, scroll, wheel, check, upload, choose, download, dialog, visual-click or navigate. Use fresh node refs from the latest observe, the current documentEpoch and a unique requestId; reusing a requestId with a different payload is rejected.\nInput: fill replaces all text (may drop rich formatting) in an input, textarea or editing host (editable:true nodes). append adds only the suffix at the end and keeps the prefix (max 10000 UTF-16 units combined, respects maxlength). Password fields, IME and protected editors are unsupported. check sets a checkbox/switch to a boolean, or selects a native radio with checked:true only. press acts on a focused control (Enter/Space may submit); no browser/OS shortcuts. scroll changes DOM scroll offsets of the document (no ref) or a ref, and no movement stays unknown. wheel sends one real wheel sample at a verified point on a control/region ref; verify it with a text/URL expectation.\nNavigation: stays on the lease origin unless the lease has scope=tab (explicit personal Broker). Local and private-network addresses cannot be reached from a public page.\nFiles: upload and choose take absolute local paths of existing, non-hidden regular files inside the Broker\'s allowed folders (default Downloads, Desktop, Documents); otherwise POLICY_DENIED, so ask the user to move the file instead of trying other paths. upload targets a connected, enabled <input type=file>; choose clicks a file-chooser trigger. download clicks a trigger and returns the filename, absolute path and size; you never pick the destination. Upload, choose and download each need user approval per call in every approval mode and are not allowed in batch.\nDialogs and vision: dialog answers one pending alert/confirm/prompt/beforeunload (accept true/false; promptText max 1000, only when accepting a prompt). A click that opens a dialog may time out; call dialog, then observe. visual-click uses a screenshotId from native_browser_screenshot plus an image-pixel box; the provider rechecks epoch, scroll and hit target before clicking.\nExpectations (expected): value, url, text, or {kind:state,ref,state} with state attached/detached/visible/hidden/enabled/disabled/checked/unchecked on an already observed node; the schema lists which kinds each action accepts. State is the final condition, not proof of a transition or causation, and cannot cross navigation. Without an expectation the outcome is often unknown.\nOutcomes: unknown means do NOT retry with a new requestId; regain approved control and observe first. RECOVERY_REQUIRED is historical metadata, not current success or restored control.\nFrame: optional {frameId,documentEpoch} targets one same-origin child from native_browser_frames (top-level documentEpoch must equal the child epoch). Only click with an optional child-text expectation is supported there; the result is a fresh view of that child, not the root page.',
    { requestId: schemaString, leaseId: schemaString, documentEpoch: schemaString, action, timeoutMs: { type: 'integer' },
      frame:{type:'object',properties:{frameId:{type:'string',minLength:1,maxLength:128},documentEpoch:{type:'string',minLength:1,maxLength:512}},required:['frameId','documentEpoch'],additionalProperties:false} },
    ['requestId', 'leaseId', 'documentEpoch', 'action'], (args, exec) => {
      const raw = record(args), action = record(raw.action);
      let request = raw;
      if (action.kind === 'visual-click') {
        const { scope } = executionScope(exec);
        const ref = screenshots.get(scope.wireSessionId, string(action.screenshotId));
        if (ref.leaseId !== string(raw.leaseId)) throw new BrowserError('STALE_TARGET', 'Screenshot belongs to another lease');
        request = { ...raw, action: { ...visualActionFromScreenshot(ref, visualBox(action.box), string(action.target, 500)),
          ...(action.expected === undefined ? {} : { expected: action.expected }) } };
      }
      const parsed = actionRequest(request);
      if (!fileActionKinds.has(parsed.action.kind)) return run('browser.act', { request: parsed }, exec);
      return approveFileAction(parsed.action, exec).then(() => run('browser.act', { request: parsed }, exec));
    });
  register('batch', 'Perform 1-8 explicit actions in order under one shared deadline (default and max 30000 ms). Each step has the same shape as native_browser_act and is approved separately; each rechecks lease, origin, target, actionability and postcondition. Not a script or transaction: completed side effects are never rolled back. Use only current refs from the initial document. Navigation is allowed only as the last step. A replaced document stops the remaining steps, and so does any failed, cancelled, unknown or unverified step, so give click/press/wheel an expectation to let the batch continue. Upload, choose and download are not allowed. The result lists attempted/notRun steps with metadata and only the last attempted observation. The requestId covers the WHOLE batch: reuse deduplicates it, and never mint a new one to resume. RECOVERY_REQUIRED is historical metadata, not a resumable plan or restored authority. No model JavaScript, new-ref variables or cross-origin authority expansion.',
    { requestId: { type: 'string', minLength: 1, maxLength: 128 }, leaseId: schemaString, documentEpoch: schemaString,
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
      steps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { action,
        timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, required: ['action'], additionalProperties: false } } },
    ['requestId', 'leaseId', 'documentEpoch', 'steps'], async (args, exec) => {
      const request = batchRequest(args), { scope, signal: owningSignal } = executionScope(exec);
      if (batchApprovals.size >= 8) throw new BrowserError('QUEUE_FULL', 'Too many active batch approval contexts');
      const deadline = new AbortController(), approvalId = randomUUID();
      const timer = setTimeout(() => deadline.abort(new BrowserError('DEADLINE_EXCEEDED', 'Batch deadline exceeded')), request.timeoutMs ?? 30000);
      timer.unref();
      const signal = AbortSignal.any([owningSignal, deadline.signal]);
      try {
        const channel = await peer(); checkAbort(signal);
        // Recheck after connection setup because concurrent executions may have entered meanwhile.
        if (batchApprovals.size >= 8) throw new BrowserError('QUEUE_FULL', 'Too many active batch approval contexts');
        batchApprovals.set(approvalId, { scope, request, exec, peer: channel, signal, next: 0 });
        return await channel.call('browser.batch', { request, approvalId, sessionId: scope.wireSessionId }, signal);
      } finally { clearTimeout(timer); batchApprovals.delete(approvalId); }
    });
  register('handoff', 'Release control and leave the page open for the user. Never closes user tabs.',
    { leaseId: schemaString }, ['leaseId'], (args, exec) => {
      const leaseId = string(args.leaseId), { scope } = executionScope(exec);
      revokeCaptureLease(scope.wireSessionId, leaseId);
      tasks.handoff(string(exec.agent?.session.id), leaseId);
      scope.keeper?.forget(leaseId);
      return run('browser.release', { leaseId }, exec);
    });
  const screenshotDefinition = {
    description: 'Capture the authorized tab viewport as a Host-owned image attachment. Multimodal sessions can view it directly; text-only sessions can use an optional vision tool such as dsh-vision-router, which requires Vision mode and separately authorized image-backend routing. Use the returned screenshot.id and an image-pixel target box with native_browser_act visual-click; the adapter maps the box to the CSS viewport and the provider rechecks document epoch, scroll, hit target and overlap before clicking. This plugin does not dispatch a vision model itself.',
    parameters: { type: 'object', properties: { leaseId: schemaString }, required: ['leaseId'], additionalProperties: false },
    output: { schema: {}, render: (_args: unknown, value: any) => [
      { type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: value.attachment },
    ] },
    timeoutMs: 30_000,
    async execute(raw: unknown, exec: Execution) {
      const { scope, signal: owningSignal } = executionScope(exec);
      const attachments = ctx.get?.('attachments');
      if (typeof attachments?.saveImage !== 'function' || typeof attachments?.readImage !== 'function') {
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'DSH canonical attachment service is unavailable');
      }
      const leaseId = string(record(raw).leaseId);
      if (captures.size >= 8) throw new BrowserError('QUEUE_FULL', 'Too many pending screenshot publications');
      const capture: PendingCapture = { scope, leaseId, controller: new AbortController() };
      const signal = AbortSignal.any([owningSignal, capture.controller.signal]);
      captures.add(capture);
      try {
        const channel = await peer(); capture.peer = channel;
        checkAbort(signal);
        const params = { leaseId, sessionId: scope.wireSessionId };
        const shot = await channel.call('browser.capture', params, signal) as Screenshot;
        checkAbort(signal);
        const attachment = await attachments.saveImage({ data: Buffer.from(shot.data, 'base64'), mediaType: shot.mimeType, name: 'Browser viewport' });
        checkAbort(signal);
        // Host normalization can change bytes and dimensions. Hash the exact image
        // a visual tool will read, never the pre-normalization browser JPEG.
        const canonical = await attachments.readImage(attachment, signal);
        checkAbort(signal);
        // Reuse the SAME connection: reconnect never restores this image's lease.
        // Notification is an early cancellation hint, not the sole authority check.
        const validity = record(await channel.call('browser.validateLease', params, signal));
        if (validity.valid !== true || Object.keys(validity).length !== 1) throw new BrowserError('LEASE_REVOKED', 'Screenshot authority could not be confirmed');
        checkAbort(signal);
        const screenshot = screenshots.register(scope.wireSessionId, leaseId, shot, {
          attachmentId: string(attachment.attachmentId, 128), width: attachment.width, height: attachment.height,
          bytes: canonical.data,
        });
        return { attachment, tab: shot.tab, documentEpoch: shot.documentEpoch, capturedAt: shot.capturedAt,
          redaction: shot.redaction,
          viewport: screenshot.viewport, coordinateSpace: screenshot.coordinateSpace,
          imageToViewport: screenshot.imageToViewport, screenshot };
      } finally { captures.delete(capture); }
    },
  } as const;
  addTool(toolName('screenshot'), screenshotDefinition);
  compatibilityName('screenshot', screenshotDefinition.description, screenshotDefinition);

  const connectionService = ctx.get?.('connection');
  if (typeof connectionService?.fetch?.register !== 'function' && typeof connectionService?.rpc?.handle !== 'function') {
    throw new BrowserError('UNSUPPORTED_CAPABILITY', 'DSH Connection RPC is required for foreground conversation handoff');
  }
  const clientRevisions = new Map<string, number>();
  const setup = createSetupController(config.runtimeDirectory, undefined, approvalMode);
  let latestIssuedAt = 0;
  ctx.effect(() => registerHostRoutes(connectionService, async (endpoint: string, raw: unknown, signal: AbortSignal) => {
    checkAbort(signal);
    if (disposed) throw new BrowserError('CONNECTION_LOST', 'Plugin disposed');
    if (endpoint.startsWith('setup.')) return setup(endpoint, raw, signal);
    if (endpoint === 'task.status' || endpoint === 'task.stop' || endpoint === 'task.finish') {
      const p = record(raw);
      if (Object.keys(p).length !== 1 || typeof p.sessionId !== 'string' || !p.sessionId || p.sessionId.length > 1024)
        throw new BrowserError('INVALID_REQUEST', 'Task controls require one sessionId');
      if (endpoint === 'task.status') return { ok: true, value: tasks.status(p.sessionId) };
      if (foregroundDenial(p.sessionId)) throw new BrowserError('POLICY_DENIED', 'Select this conversation before controlling its browser task');
      if (endpoint === 'task.stop') { releaseScope(p.sessionId, 'Browser work stopped by the user'); return { ok: true, value: tasks.status(p.sessionId) }; }
      const scope = sessions.get(p.sessionId);
      if (!scope) return { ok: true, value: tasks.status(p.sessionId) };
      return { ok: true, value: await finishTask(p.sessionId, scope, AbortSignal.any([signal, scope.controller.signal, AbortSignal.timeout(15000)])) };
    }
    if (endpoint !== 'foreground') return { ok: false, error: { code: 'gateway/not-found', message: 'Unknown browser endpoint', details: {} } };
    const p = record(raw);
    if (Object.keys(p).some(key => !['clientId', 'revision', 'issuedAt', 'sessionId'].includes(key))
      || typeof p.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.clientId)
      || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1
      || !Number.isSafeInteger(p.issuedAt) || Math.abs(Date.now() - Number(p.issuedAt)) > 5 * 60_000
      || !(p.sessionId === null || (typeof p.sessionId === 'string' && p.sessionId.length >= 1 && p.sessionId.length <= 1024))) {
      return { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid foreground conversation update', details: {} } };
    }
    const clientId = p.clientId, revision = Number(p.revision), issuedAt = Number(p.issuedAt);
    const previousRevision = clientRevisions.get(clientId) ?? 0;
    if (revision <= previousRevision || issuedAt < latestIssuedAt) {
      return { ok: true, value: { accepted: false, released: 0 } };
    }
    clientRevisions.delete(clientId); clientRevisions.set(clientId, revision);
    while (clientRevisions.size > 64) clientRevisions.delete(clientRevisions.keys().next().value!);
    latestIssuedAt = Math.max(latestIssuedAt, issuedAt);
    foregroundSessionId = p.sessionId as string | null;
    const released = releaseBackgroundScopes(p.sessionId as string | null);
    return { ok: true, value: { accepted: true, released } };
  }));

  ctx.on('tools/pre-execute', (exec: Execution, next: () => unknown) => {
    const shortName = exec.name.startsWith(`${TOOL_NAMESPACE}_`) ? exec.name.slice(TOOL_NAMESPACE.length + 1)
      : exec.name.startsWith('browser_') ? exec.name.slice('browser_'.length) : undefined;
    if (!shortName || !registeredTools.has(exec.name)) return next();
    if (!exec.agent?.session.id) return { kind: 'deny', reason: 'Browser tools require an owning DSH session.' };
    if (disposed) return { kind: 'deny', reason: 'Browser plugin has been disposed.' };
    const denial = foregroundDenial(exec.agent.session.id);
    if (denial) return { kind: 'deny', reason: denial };
    bind(exec);
    if ((approvalMode === 'per-action' && ['claim', 'open', 'close', 'act', 'screenshot', 'task'].includes(shortName))
      || (approvalMode === 'per-lease' && ['claim', 'open'].includes(shortName))) {
      return { kind: 'ask', reason: 'Allow this browser control action on the selected signed-in page?' };
    }
    return next();
  });
  // Personal mode keeps a short-lived lease across turns in the same conversation.
  // Foreground switching, Session disposal, expiry and Stop remain hard boundaries.
  ctx.on('session/event', (session: { id: string }, event: { type: string; data?: { reason?: { kind?: string } } }) => {
    if (event.type !== 'turn/end') return;
    const endedScope = sessions.get(session.id);
    endedScope?.keeper?.stop(); if (endedScope) delete endedScope.keeper;
    if (approvalMode === 'personal') {
      // Only a completed Host turn has authority for normal cleanup. Unknown,
      // interrupted or errored endings keep pages available for recovery.
      const scope = sessions.get(session.id);
      if (event.data?.reason?.kind === 'completed' && scope && !foregroundDenial(session.id)) {
        return finishTask(session.id, scope, AbortSignal.any([scope.controller.signal, AbortSignal.timeout(15000)]))
          .catch(() => tasks.interrupted(session.id));
      }
      if (event.data?.reason?.kind && event.data.reason.kind !== 'completed') releaseScope(session.id, 'Browser turn was interrupted or did not complete');
      return;
    }
    releaseScope(session.id, 'The owning DSH turn ended');
  });
  ctx.on('session/disposed', (session: { id: string }) => { releaseScope(session.id, 'The owning DSH conversation was disposed'); tasks.delete(session.id); });
  ctx.effect(() => () => {
    disposed = true;
    for (const scope of sessions.values()) scope.controller.abort(new BrowserError('LEASE_REVOKED', 'Browser plugin disposed'));
    void connection?.then(p => p.close()).catch(() => {});
    sessions.clear();
    tasks.clear();
    screenshots.clear();
  });
}
