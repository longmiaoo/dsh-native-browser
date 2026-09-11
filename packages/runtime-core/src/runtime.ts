import { createHash, randomUUID } from 'node:crypto';
import {
  BrowserError, checkAbort, errorCode, originOf,
  type ActionRequest, type ActionResult, type Authorize, type BrowserProvider,
  type Lease, type FullObservation, type ObserveOptions, type ObservationUpdate, type TabSummary, type ErrorCode,
} from '../../contracts/src/index.js';
import { ObservationCache } from './observations.js';
import { observationScope, observeOptions, sameScope } from '../../contracts/src/validation.js';
import { scrollMovedAsRequested, validateScrollEvidence } from '../../contracts/src/scrolling.js';
import { recoveredAction, type ActionJournal, type RecoveryRecord } from '../../contracts/src/journal.js';
import { ActionResultCache } from './action-results.js';

type Entry = {
  scope: string;
  lease: Lease; provider: BrowserProvider; tab: TabSummary;
  controller: AbortController; timer: ReturnType<typeof setTimeout>;
  tail: Promise<void>; queued: number;
};
type JournalEntry = { hash: string; pending?: Promise<ActionResult>; recovery?: RecoveryRecord; failure?: ErrorCode };
type Claim = { owner: string; scope: string; instanceId: string; controller: AbortController };
type LeaseRevocation = Readonly<{ owner: string; scope: string; leaseId: string }>;
const defaultLimits = { leaseMs: 120_000, queueSize: 16, journalSize: 10_000, actionMs: 10_000,
  providers: 16, leases: 64, claims: 32, resultEntries: 128, resultBytes: 8 * 1024 * 1024, resultMs: 120_000 };
type RuntimeLimits = typeof defaultLimits;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One instance belongs to the per-user Broker, not to each DSH process. */
export class BrowserRuntime {
  private readonly providers = new Map<string, BrowserProvider>();
  private readonly leases = new Map<string, Entry>();
  private readonly tabs = new Map<string, string>();
  private readonly journal = new Map<string, JournalEntry>();
  private readonly observations = new ObservationCache();
  private readonly results: ActionResultCache;
  private readonly inFlight = new Set<Promise<ActionResult>>();
  private readonly claims = new Set<Claim>();
  private readonly revocationListeners = new Set<(event: LeaseRevocation) => void>();
  private readonly limits: Readonly<RuntimeLimits>;
  private closed = false;

  constructor(private readonly authorize: Authorize, limits: Partial<RuntimeLimits> = {}, private readonly durable?: ActionJournal) {
    this.limits = Object.freeze({ ...defaultLimits, ...limits });
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.limits.providers > 64 || this.limits.leases > 256 || this.limits.claims > 128) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid runtime resource limits');
    }
    this.results = new ActionResultCache({ maxEntries: this.limits.resultEntries, maxBytes: this.limits.resultBytes, ttlMs: this.limits.resultMs });
  }

  resourceUsage() { return { providers: this.providers.size, leases: this.leases.size, claims: this.claims.size }; }
  journalUsage() { return { identities: this.journal.size, pending: this.inFlight.size, results: this.results.usage() }; }

  /** Metadata-only notification after authority is removed, before provider cleanup can wait. */
  onLeaseRevoked(listener: (event: LeaseRevocation) => void): () => void {
    if (this.closed) throw new BrowserError('CONNECTION_LOST', 'Runtime closed');
    if (this.revocationListeners.size >= 128) throw new BrowserError('QUEUE_FULL', 'Lease listener limit reached');
    this.revocationListeners.add(listener);
    return () => { this.revocationListeners.delete(listener); };
  }

  register(provider: BrowserProvider): void {
    if (this.closed || this.providers.has(provider.instance.id)) {
      throw new BrowserError('INVALID_REQUEST', 'Runtime closed or duplicate browser instance');
    }
    if (this.providers.size >= this.limits.providers) throw new BrowserError('QUEUE_FULL', 'Browser instance limit reached');
    this.providers.set(provider.instance.id, provider);
  }

  instances() { return [...this.providers.values()].map(p => structuredClone(p.instance)); }

  async listTabs(instanceId: string, signal: AbortSignal): Promise<TabSummary[]> {
    checkAbort(signal);
    return this.provider(instanceId).listTabs(signal);
  }

  private provider(id: string): BrowserProvider {
    const value = this.providers.get(id);
    if (!value || this.closed) throw new BrowserError('CONNECTION_LOST', 'Browser instance is not connected');
    return value;
  }

  async claim(owner: string, instanceId: string, tabId: string, signal: AbortSignal, scope = owner): Promise<Lease> {
    checkAbort(signal);
    if (!owner || !scope) throw new BrowserError('INVALID_REQUEST', 'A session owner and lifecycle scope are required');
    if (this.claims.size >= this.limits.claims) throw new BrowserError('QUEUE_FULL', 'Pending claim limit reached');
    const claim = { owner, scope, instanceId, controller: new AbortController() };
    this.claims.add(claim);
    const timer = setTimeout(() => claim.controller.abort(new BrowserError('DEADLINE_EXCEEDED', 'Claim deadline exceeded')), this.limits.actionMs);
    timer.unref();
    try {
      return await this.claimWithin(owner, instanceId, tabId,
        AbortSignal.any([signal, claim.controller.signal]), scope);
    } finally { clearTimeout(timer); this.claims.delete(claim); }
  }

  private async claimWithin(owner: string, instanceId: string, tabId: string, signal: AbortSignal, scope: string): Promise<Lease> {
    const provider = this.provider(instanceId);
    const tab = (await provider.listTabs(signal)).find(t => t.id === tabId && t.instanceId === instanceId);
    checkAbort(signal);
    if (!tab) throw new BrowserError('STALE_TARGET', 'Tab is no longer available');
    const origin = originOf(tab.url);
    if (!await this.authorize({ owner, tab, operation: 'claim' }, signal)) {
      throw new BrowserError('POLICY_DENIED', 'Tab control was not authorized');
    }
    checkAbort(signal);
    if (this.provider(instanceId) !== provider) throw new BrowserError('CONNECTION_LOST', 'Browser instance changed while claiming');
    const tabKey = JSON.stringify([instanceId, tabId]);
    if (this.tabs.has(tabKey)) throw new BrowserError('LEASE_BUSY', 'Another task controls this tab');
    if (this.leases.size >= this.limits.leases) throw new BrowserError('QUEUE_FULL', 'Active lease limit reached');
    const lease: Lease = Object.freeze({ id: randomUUID(), token: randomUUID(), owner,
      tab: tabId, instanceId, origin, expiresAt: Date.now() + this.limits.leaseMs });
    const controller = new AbortController();
    const timer = setTimeout(() => { void this.release(owner, lease.id).catch(() => {}); }, this.limits.leaseMs);
    timer.unref();
    const entry: Entry = { scope, lease, provider, tab, controller, timer, tail: Promise.resolve(), queued: 0 };
    // Reserve synchronously before grant yields, including for competing claim calls.
    this.leases.set(lease.id, entry);
    this.tabs.set(tabKey, lease.id);
    try {
      await provider.grant(lease, AbortSignal.any([signal, controller.signal]));
      checkAbort(signal);
      this.entry(owner, lease.id);
      return structuredClone(lease);
    } catch (error) {
      // A release may have run while grant was pending. Revoke the exact token again
      // if a non-cooperative/late grant completed after that earlier cleanup.
      if (this.leases.has(lease.id)) await this.release(owner, lease.id).catch(() => {});
      else await provider.revoke(lease).catch(() => {});
      throw error;
    }
  }

  private entry(owner: string, leaseId: string): Entry {
    const entry = this.leases.get(leaseId);
    if (!entry || entry.lease.owner !== owner || entry.lease.expiresAt <= Date.now()) {
      throw new BrowserError('LEASE_REVOKED', 'Lease is expired, revoked, or belongs to another session');
    }
    checkAbort(entry.controller.signal);
    return entry;
  }

  private async authorized(entry: Entry, operation: 'observe' | 'act', signal: AbortSignal,
    action?: ActionRequest['action']): Promise<void> {
    checkAbort(signal);
    this.entry(entry.lease.owner, entry.lease.id);
    const tab = (await entry.provider.listTabs(signal)).find(t => t.id === entry.lease.tab);
    if (!tab || originOf(tab.url) !== entry.lease.origin) {
      throw new BrowserError('POLICY_DENIED', 'Tab moved outside its authorized origin');
    }
    const request = { owner: entry.lease.owner, tab, operation, ...(action ? { action } : {}) };
    if (!await this.authorize(request, signal)) throw new BrowserError('POLICY_DENIED', 'Operation denied');
    checkAbort(signal);
    this.entry(entry.lease.owner, entry.lease.id);
  }

  private async serialized<T>(entry: Entry, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (entry.queued >= this.limits.queueSize) throw new BrowserError('QUEUE_FULL', 'Tab queue is full');
    entry.queued++;
    const previous = entry.tail;
    let finish!: () => void;
    entry.tail = new Promise<void>(resolve => { finish = resolve; });
    try {
      await previous;
      checkAbort(signal);
      this.entry(entry.lease.owner, entry.lease.id);
      return await operation();
    } finally { entry.queued--; finish(); }
  }

  observe(owner: string, leaseId: string, signal: AbortSignal): Promise<FullObservation>;
  observe(owner: string, leaseId: string, signal: AbortSignal, options: ObserveOptions): Promise<ObservationUpdate>;
  async observe(owner: string, leaseId: string, signal: AbortSignal, options: ObserveOptions = {}): Promise<ObservationUpdate> {
    const entry = this.entry(owner, leaseId);
    const { cursor, rootRef, query } = observeOptions(options);
    const scope = query ? { kind: 'query' as const, query, ...(rootRef === undefined ? {} : { rootRef }) }
      : rootRef === undefined ? { kind: 'document' as const } : { kind: 'subtree' as const, rootRef };
    const linked = AbortSignal.any([signal, entry.controller.signal, AbortSignal.timeout(this.limits.actionMs)]);
    return this.serialized(entry, linked, async () => {
      await this.authorized(entry, 'observe', linked);
      if (query && !entry.provider.find) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Provider does not support semantic queries');
      if (!query && rootRef !== undefined && !entry.provider.observeSubtree) {
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Provider does not support scoped observation');
      }
      const observation = query ? await entry.provider.find!(entry.lease, query, linked, rootRef)
        : rootRef === undefined ? await entry.provider.observe(entry.lease, linked)
        : await entry.provider.observeSubtree!(entry.lease, rootRef, linked);
      checkAbort(linked);
      if (!sameScope(observationScope(observation.scope), scope)) throw new BrowserError('INVALID_REQUEST', 'Provider returned the wrong observation scope');
      if (observation.tab !== entry.lease.tab || originOf(observation.url) !== entry.lease.origin) throw new BrowserError('POLICY_DENIED', 'Observation tab or origin changed');
      return this.observations.publish(owner, leaseId, observation, cursor);
    });
  }

  async capture(owner: string, leaseId: string, signal: AbortSignal) {
    const entry = this.entry(owner, leaseId);
    const linked = AbortSignal.any([signal, entry.controller.signal, AbortSignal.timeout(this.limits.actionMs)]);
    return this.serialized(entry, linked, async () => {
      await this.authorized(entry, 'observe', linked);
      if (!entry.provider.capture) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Provider cannot capture images');
      const result = await entry.provider.capture(entry.lease, linked);
      checkAbort(linked);
      return result;
    });
  }

  /** Recheck current read authority after an out-of-process image storage step.
   * No screenshot, page content, queue reservation or renewed lease is returned.
   */
  async validateLease(owner: string, leaseId: string, signal: AbortSignal): Promise<{ valid: true }> {
    const entry = this.entry(owner, leaseId);
    const linked = AbortSignal.any([signal, entry.controller.signal, AbortSignal.timeout(this.limits.actionMs)]);
    await this.authorized(entry, 'observe', linked);
    return { valid: true };
  }

  act(owner: string, request: ActionRequest, signal: AbortSignal, recoveryScope = owner): Promise<ActionResult> {
    checkAbort(signal);
    if (this.closed) throw new BrowserError('CONNECTION_LOST', 'Runtime is closed');
    if (!request.requestId || request.requestId.length > 128) {
      throw new BrowserError('INVALID_REQUEST', 'A bounded request ID is required');
    }
    // Caller mutations cannot change the action after authorization or journaling.
    const frozen = structuredClone(request);
    const key = JSON.stringify([owner, request.requestId]);
    const hash = createHash('sha256').update(canonical(frozen)).digest('hex');
    const durableKey = JSON.stringify([recoveryScope, request.requestId]);
    const previous = this.journal.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new BrowserError('REQUEST_ID_CONFLICT', 'Request ID already used for another payload');
      // Full cached observations still require live lease authority. Recovery below only exposes metadata.
      try { this.entry(owner, request.leaseId); }
      catch (error) {
        const recovered = this.durable?.lookup(durableKey, hash);
        if (recovered) return Promise.resolve(recoveredAction(request.requestId, recovered));
        throw error;
      }
      if (previous.pending) return previous.pending.then(value => this.deliverAction(owner, frozen.leaseId, value, previous.recovery));
      if (previous.failure) throw new BrowserError(previous.failure, 'Historical action failed before producing a result');
      const cached = this.results.get(key);
      if (cached) return Promise.resolve(cached).then(value => this.deliverAction(owner, frozen.leaseId, value, previous.recovery));
      if (previous.recovery) return Promise.resolve(recoveredAction(frozen.requestId, structuredClone(previous.recovery)));
      throw new BrowserError('INTERNAL_ERROR', 'Action fence has no execution state');
    }
    const recovered = this.durable?.lookup(durableKey, hash);
    if (recovered) return Promise.resolve(recoveredAction(request.requestId, recovered));
    const entry = this.entry(owner, request.leaseId);
    // Never evict and silently permit a duplicate side effect within this runtime epoch.
    if (this.journal.size >= this.limits.journalSize) throw new BrowserError('JOURNAL_FULL', 'Action journal is full');
    const record: JournalEntry = { hash };
    this.journal.set(key, record);
    const result = this.execute(entry, frozen, signal, durableKey, hash);
    record.pending = result;
    this.inFlight.add(result);
    void result.then(value => {
      record.recovery = this.actionMetadata(value);
      delete record.pending; this.inFlight.delete(result);
      // Never retain full page data after authority ended, including during durable settlement.
      try { this.entry(owner, frozen.leaseId); if (!this.closed) this.results.put(key, frozen.leaseId, value); }
      catch { /* Metadata fence remains even if payload caching is unavailable. */ }
    }, error => {
      record.failure = errorCode(error); delete record.pending; this.inFlight.delete(result);
    });
    return result.then(value => this.deliverAction(owner, frozen.leaseId, value, record.recovery));
  }

  private actionMetadata(value: ActionResult): RecoveryRecord {
    return value.recovery ? structuredClone(value.recovery) : { state: 'settled', recordedAt: Date.now(),
      dispatch: value.dispatch === 'notDispatched' ? 'notDispatched' : 'dispatched', priorOutcome: value.outcome };
  }

  private deliverAction(owner: string, leaseId: string, value: ActionResult, metadata?: RecoveryRecord): ActionResult {
    if (value.observation || value.scroll) {
      try { this.entry(owner, leaseId); }
      catch { return recoveredAction(value.requestId, metadata ? structuredClone(metadata) : this.actionMetadata(value)); }
    }
    return structuredClone(value);
  }

  private async execute(entry: Entry, request: ActionRequest, callerSignal: AbortSignal, durableKey: string, hash: string): Promise<ActionResult> {
    let dispatched = false, reserved = false;
    const timeout = request.timeoutMs ?? this.limits.actionMs;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
      throw new BrowserError('INVALID_REQUEST', 'Action timeout must be between 1 and 30000 ms');
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new BrowserError('DEADLINE_EXCEEDED', 'Action deadline exceeded')), timeout);
    timer.unref();
    const signal = AbortSignal.any([callerSignal, entry.controller.signal, deadline.signal]);
    let outcome: ActionResult;
    try {
      outcome = await this.serialized(entry, signal, async () => {
        await this.authorized(entry, 'act', signal, request.action);
        if (this.durable) {
          reserved = await this.durable.reserve(durableKey, hash, request.action.kind);
          if (!reserved) {
            const recovered = this.durable.lookup(durableKey, hash);
            if (!recovered) throw new BrowserError('JOURNAL_UNAVAILABLE', 'Reserved action disappeared');
            return recoveredAction(request.requestId, recovered);
          }
          // Stop/cancellation while fsync was pending must still prevent provider execution.
          checkAbort(signal); this.entry(entry.lease.owner, entry.lease.id);
        }
        const result = await entry.provider.act(entry.lease, request, { signal, onDispatch: () => {
          checkAbort(signal);
          this.entry(entry.lease.owner, entry.lease.id);
          dispatched = true;
        } });
        checkAbort(signal);
        if (result.observation.tab !== entry.lease.tab || originOf(result.observation.url) !== entry.lease.origin) {
          throw new BrowserError('POLICY_DENIED', 'Result moved outside its authorized origin');
        }
        const scroll = request.action.kind === 'scroll' ? validateScrollEvidence(result.scroll, request.action) : undefined;
        if (scroll && result.postcondition === 'passed' && !scrollMovedAsRequested(scroll)) {
          throw new BrowserError('INVALID_REQUEST', 'Provider claimed scroll success without movement in the requested direction');
        }
        return { requestId: request.requestId,
          outcome: result.postcondition === 'passed' ? 'succeeded' : result.postcondition === 'failed' ? 'failed' : 'unknown',
          dispatch: dispatched ? 'observed' : 'notDispatched', postcondition: result.postcondition,
          observation: this.observations.publish(entry.lease.owner, entry.lease.id, result.observation), ...(scroll ? { scroll } : {}) };
      });
    } catch (error) {
      const code = errorCode(error);
      outcome = { requestId: request.requestId, outcome: dispatched ? 'unknown' :
        ['CANCELLED', 'USER_STOPPED', 'LEASE_REVOKED'].includes(code) ? 'cancelled' : 'failed',
        dispatch: dispatched ? 'dispatched' : 'notDispatched', postcondition: 'unverified', code };
    } finally { clearTimeout(timer); }
    if (reserved) {
      try { await this.durable!.settle(durableKey, outcome); }
      catch {
        // The durable intent still fences replay, but failed storage cannot confirm a result.
        return { requestId: request.requestId, outcome: dispatched ? 'unknown' : 'failed',
          dispatch: dispatched ? 'dispatched' : 'notDispatched', postcondition: 'unverified', code: 'JOURNAL_UNAVAILABLE' };
      }
    }
    return outcome;
  }

  async release(owner: string, leaseId: string): Promise<void> {
    const entry = this.leases.get(leaseId);
    if (!entry) return;
    if (entry.lease.owner !== owner) throw new BrowserError('LEASE_REVOKED', 'Lease belongs to another session');
    this.leases.delete(leaseId);
    this.observations.revokeLease(leaseId);
    this.results.revokeLease(leaseId);
    this.tabs.delete(JSON.stringify([entry.lease.instanceId, entry.lease.tab]));
    clearTimeout(entry.timer);
    entry.controller.abort(new BrowserError('LEASE_REVOKED', 'Control was released'));
    const event = Object.freeze({ owner: entry.lease.owner, scope: entry.scope, leaseId });
    for (const listener of this.revocationListeners) {
      try { listener(event); } catch { /* A delivery failure cannot retain browser authority. */ }
    }
    await entry.provider.revoke(entry.lease);
    await entry.tail;
  }

  async releaseOwner(owner: string): Promise<void> {
    this.cancelClaims(claim => claim.owner === owner);
    await Promise.allSettled([...this.leases.values()].filter(e => e.lease.owner === owner)
      .map(e => this.release(owner, e.lease.id)));
  }

  /** Trusted lifecycle scope (for example a Broker connection), never a peer-supplied lease capability. */
  async releaseScope(scope: string): Promise<void> {
    this.cancelClaims(claim => claim.scope === scope);
    await Promise.allSettled([...this.leases.values()].filter(e => e.scope === scope)
      .map(e => this.release(e.lease.owner, e.lease.id)));
  }

  /** Accept Stop only from the provider that owns the live lease; no historical index is retained. */
  async providerRevoked(instanceId: string, leaseId: string): Promise<void> {
    const entry = this.leases.get(leaseId);
    if (entry?.lease.instanceId === instanceId) await this.release(entry.lease.owner, leaseId);
  }

  private cancelClaims(matches: (claim: Claim) => boolean): void {
    for (const claim of this.claims) if (matches(claim)) {
      claim.controller.abort(new BrowserError('LEASE_REVOKED', 'Claim lifecycle ended'));
    }
  }

  async disconnect(instanceId: string): Promise<void> {
    this.providers.delete(instanceId);
    this.cancelClaims(claim => claim.instanceId === instanceId);
    await Promise.allSettled([...this.leases.values()].filter(e => e.lease.instanceId === instanceId)
      .map(e => this.release(e.lease.owner, e.lease.id)));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.cancelClaims(() => true);
    await Promise.allSettled([...this.leases.values()].map(e => this.release(e.lease.owner, e.lease.id)));
    await Promise.allSettled([...this.inFlight]);
    this.results.clear(); this.journal.clear();
    this.providers.clear();
    this.observations.clear();
    this.revocationListeners.clear();
  }
}
