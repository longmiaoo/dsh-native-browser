import { BrowserError, checkAbort } from '../../contracts/src/index.js';

type Entry = { expiresAt: number; controller: AbortController; timer?: ReturnType<typeof setTimeout> };

/** Host-only maintenance. No input replay, claims, reconnects, or model-visible tool. */
export class LeaseKeepAlive {
  private readonly entries = new Map<string, Entry>();
  private touchedAt = Date.now();
  private stopped = false;
  private readonly abort = () => this.stop();
  constructor(private readonly renew: (id: string, signal: AbortSignal) => Promise<{ expiresAt: number }>,
    private readonly signal: AbortSignal, private readonly idleMs = 10 * 60_000) {
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0) throw new BrowserError('INVALID_REQUEST', 'Invalid lease idle budget');
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.stop();
  }
  touch() { if (!this.stopped) this.touchedAt = Date.now(); }
  track(id: string, expiresAt: number) {
    checkAbort(this.signal);
    if (this.stopped || expiresAt <= Date.now()) return;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > Date.now() + 5 * 60_000)
      throw new BrowserError('PROTOCOL_MISMATCH', 'Invalid maintenance deadline');
    this.forget(id);
    const entry: Entry = { expiresAt, controller: new AbortController() };
    this.entries.set(id, entry); this.touch(); this.schedule(id, entry);
  }
  forget(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); clearTimeout(entry.timer);
    entry.controller.abort(new BrowserError('LEASE_REVOKED', 'Lease maintenance ended'));
  }
  stop() {
    this.stopped = true;
    this.signal.removeEventListener('abort', this.abort);
    for (const id of this.entries.keys()) this.forget(id);
  }
  private schedule(id: string, entry: Entry) {
    const now = Date.now();
    const delay = Math.max(1, Math.min((entry.expiresAt - now) / 2, this.touchedAt + this.idleMs - now));
    entry.timer = setTimeout(() => { void this.tick(id, entry); }, delay);
    entry.timer.unref();
  }
  private async tick(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry) return;
    if (this.stopped || this.signal.aborted || Date.now() >= entry.expiresAt || Date.now() >= this.touchedAt + this.idleMs) {
      this.forget(id); return;
    }
    try {
      const next = await this.renew(id, AbortSignal.any([this.signal, entry.controller.signal, AbortSignal.timeout(10_000)]));
      if (this.entries.get(id) !== entry || this.stopped) return;
      if (!Number.isSafeInteger(next.expiresAt) || next.expiresAt <= entry.expiresAt || next.expiresAt > Date.now() + 5 * 60_000)
        throw new BrowserError('PROTOCOL_MISMATCH', 'Renewal did not extend the live deadline');
      entry.expiresAt = next.expiresAt; this.schedule(id, entry);
    } catch {
      // No automatic retry: a lost renewal ACK must not become a new claim.
      if (this.entries.get(id) === entry) this.forget(id);
    }
  }
}
