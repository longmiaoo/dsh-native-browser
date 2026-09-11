import { randomUUID } from 'node:crypto';
import { BrowserError, type FullObservation, type Observation, type ObservationDelta,
  type ObservationUpdate } from '../../contracts/src/index.js';
import { observationScope, sameScope } from '../../contracts/src/validation.js';

type Snapshot = { owner: string; leaseId: string; observation: Observation; expiresAt: number; bytes: number };
type Limits = { maxEntries: number; maxBytes: number; maxSnapshotBytes: number; ttlMs: number };
const defaults: Limits = { maxEntries: 128, maxBytes: 8 * 1024 * 1024, maxSnapshotBytes: 96 * 1024, ttlMs: 120_000 };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Per-consumer immutable baselines, shared across providers; never a global last-read cursor. */
export class ObservationCache {
  private readonly snapshots = new Map<string, Snapshot>();
  private usedBytes = 0;
  private readonly limits: Readonly<Limits>;
  constructor(limits: Limits = defaults, private readonly now = Date.now) {
    if ([limits.maxEntries, limits.maxBytes, limits.maxSnapshotBytes, limits.ttlMs].some(value => !Number.isSafeInteger(value) || value <= 0)
      || limits.maxSnapshotBytes > limits.maxBytes || limits.maxEntries > 4096 || limits.maxBytes > 128 * 1024 * 1024) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid observation cache limits');
    }
    this.limits = Object.freeze({ ...limits });
  }
  get size(): number { this.prune(); return this.snapshots.size; }
  get serializedBytes(): number { this.prune(); return this.usedBytes; }
  private remove(cursor: string): void {
    const entry = this.snapshots.get(cursor);
    if (entry) { this.usedBytes -= entry.bytes; this.snapshots.delete(cursor); }
  }
  private prune(): void {
    const now = this.now();
    for (const [cursor, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.remove(cursor);
  }
  publish(owner: string, leaseId: string, observation: Observation): FullObservation;
  publish(owner: string, leaseId: string, observation: Observation, baseCursor: string | undefined): ObservationUpdate;
  publish(owner: string, leaseId: string, observation: Observation, baseCursor?: string): ObservationUpdate {
    this.prune();
    const scope = observationScope(observation.scope);
    observation = { ...observation, scope };
    if (!owner || !leaseId || (baseCursor !== undefined && (typeof baseCursor !== 'string' || !baseCursor || baseCursor.length > 128))
      || !Array.isArray(observation.nodes) || !Array.isArray(observation.text)
      || observation.nodes.some(node => !node.id || typeof node.role !== 'string' || typeof node.name !== 'string')
      || new Set(observation.nodes.map(node => node.id)).size !== observation.nodes.length
      || observation.text.some(text => typeof text !== 'string')) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid observation or cursor');
    }
    const snapshotBytes = bytes({ owner, leaseId, observation });
    if (snapshotBytes > this.limits.maxSnapshotBytes) throw new BrowserError('QUEUE_FULL', 'Observation exceeds the snapshot budget');
    const found = baseCursor === undefined ? undefined : this.snapshots.get(baseCursor);
    // Same shape for missing, expired and foreign cursors; never disclose a foreign baseline.
    const baseline = found?.owner === owner && found.leaseId === leaseId && found.observation.tab === observation.tab ? found : undefined;
    let reason: FullObservation['resyncReason'];
    if (baseCursor !== undefined && !baseline) reason = 'cursor-unavailable';
    else if (baseline && baseline.observation.documentEpoch !== observation.documentEpoch) reason = 'document-changed';
    else if (baseline && !sameScope(observationScope(baseline.observation.scope), scope)) reason = 'scope-changed';
    const cursor = randomUUID();
    const full: FullObservation = { ...structuredClone(observation), scope, format: 'full', cursor,
      resyncRequired: reason !== undefined, ...(reason ? { resyncReason: reason } : {}) };
    let result: ObservationUpdate = full;
    if (baseline && reason === undefined) {
      const before = baseline.observation;
      const oldNodes = new Map(before.nodes.map(node => [node.id, node]));
      const currentIds = new Set(observation.nodes.map(node => node.id));
      const delta: ObservationDelta = { format: 'delta', cursor, baseCursor: baseCursor!, resyncRequired: false,
        tab: observation.tab, url: observation.url, title: observation.title,
        documentEpoch: observation.documentEpoch, revision: observation.revision, truncated: observation.truncated, scope,
        nodes: {
          upsert: observation.nodes.filter(node => !same(oldNodes.get(node.id), node)),
          remove: before.nodes.filter(node => !currentIds.has(node.id)).map(node => node.id),
        } };
      const order = observation.nodes.map(node => node.id);
      if (!same(order, before.nodes.map(node => node.id))) delta.nodes.order = order;
      if (!same(before.text, observation.text)) {
        let start = 0;
        while (start < before.text.length && start < observation.text.length && before.text[start] === observation.text[start]) start++;
        let endBefore = before.text.length, endAfter = observation.text.length;
        while (endBefore > start && endAfter > start && before.text[endBefore - 1] === observation.text[endAfter - 1]) { endBefore--; endAfter--; }
        delta.text = { start, deleteCount: endBefore - start, insert: observation.text.slice(start, endAfter) };
      }
      // Small pages and extensive changes can be cheaper and clearer as a full snapshot.
      if (bytes(delta) < bytes(full) * 0.85) result = delta;
    }
    while (this.snapshots.size >= this.limits.maxEntries || this.usedBytes + snapshotBytes > this.limits.maxBytes) {
      this.remove(this.snapshots.keys().next().value!);
    }
    this.snapshots.set(cursor, { owner, leaseId, observation: structuredClone(observation),
      expiresAt: this.now() + this.limits.ttlMs, bytes: snapshotBytes });
    this.usedBytes += snapshotBytes;
    return structuredClone(result);
  }
  revokeLease(leaseId: string): void {
    for (const [cursor, snapshot] of this.snapshots) if (snapshot.leaseId === leaseId) this.remove(cursor);
  }
  clear(): void { this.snapshots.clear(); this.usedBytes = 0; }
}
