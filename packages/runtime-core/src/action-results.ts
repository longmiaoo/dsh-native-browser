import { BrowserError, type ActionResult } from '../../contracts/src/index.js';

type Limits = { maxEntries: number; maxBytes: number; maxResultBytes: number; ttlMs: number };
const defaults: Limits = { maxEntries: 128, maxBytes: 8 * 1024 * 1024, maxResultBytes: 128 * 1024, ttlMs: 120_000 };
type Cached = { leaseId: string; expires: number; data: Buffer };

/** Disposable payload cache only. Evicting this cache must never remove an action identity fence. */
export class ActionResultCache {
  private readonly values = new Map<string, Cached>();
  private bytes = 0;
  private readonly limits: Readonly<Limits>;
  constructor(limits: Partial<Limits> = {}, private readonly now = Date.now) {
    this.limits = Object.freeze({ ...defaults, ...limits });
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.limits.maxEntries > 4096 || this.limits.maxBytes > 64 * 1024 * 1024
      || this.limits.maxResultBytes > 1024 * 1024) throw new BrowserError('INVALID_REQUEST', 'Invalid action result cache limits');
  }
  private remove(key: string): void {
    const value = this.values.get(key);
    if (value) { this.bytes -= value.data.byteLength; this.values.delete(key); }
  }
  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.values) if (value.expires <= now) this.remove(key);
  }
  usage() { this.prune(); return { entries: this.values.size, serializedBytes: this.bytes }; }
  put(key: string, leaseId: string, result: ActionResult): boolean {
    this.prune(); this.remove(key);
    const data = Buffer.from(JSON.stringify(result), 'utf8');
    if (data.byteLength > this.limits.maxResultBytes || data.byteLength > this.limits.maxBytes) return false;
    while (this.values.size >= this.limits.maxEntries || this.bytes + data.byteLength > this.limits.maxBytes) {
      this.remove(this.values.keys().next().value!);
    }
    this.values.set(key, { leaseId, expires: this.now() + this.limits.ttlMs, data });
    this.bytes += data.byteLength; return true;
  }
  get(key: string): ActionResult | undefined {
    this.prune();
    const value = this.values.get(key);
    if (!value) return;
    this.values.delete(key); this.values.set(key, value); // LRU, without extending the original TTL.
    return JSON.parse(value.data.toString('utf8')) as ActionResult;
  }
  revokeLease(leaseId: string): void {
    for (const [key, value] of this.values) if (value.leaseId === leaseId) this.remove(key);
  }
  clear(): void { this.values.clear(); this.bytes = 0; }
}
