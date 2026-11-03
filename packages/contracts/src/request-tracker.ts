import { rememberRequestId } from './request-ids.js';

/** Bookkeeping for requests a peer is executing on behalf of the other side: replay rejection over a
 * bounded window of recent IDs, a concurrency cap, and per-request cancellation. Transport-agnostic so
 * the Node peer and the extension service worker share one implementation. */
export class InboundRequests {
  private readonly seen = new Set<string>();
  private readonly executing = new Map<string, AbortController>();
  constructor(private readonly maxExecuting = 32) {}

  get size(): number { return this.executing.size; }

  /** Admit a request. `duplicate` is a protocol violation; `full` should be answered with QUEUE_FULL. */
  begin(id: string): AbortController | 'duplicate' | 'full' {
    if (this.seen.has(id) || this.executing.has(id)) return 'duplicate';
    rememberRequestId(this.seen, id, this.executing);
    if (this.executing.size >= this.maxExecuting) return 'full';
    const controller = new AbortController();
    this.executing.set(id, controller);
    return controller;
  }
  cancel(id: string, reason?: unknown): void { this.executing.get(id)?.abort(reason); }
  end(id: string): void { this.executing.delete(id); }
  /** Abort everything in flight; `forget` also drops replay memory (connection teardown). */
  abortAll(reason?: unknown, forget = false): void {
    for (const controller of this.executing.values()) controller.abort(reason);
    if (forget) { this.executing.clear(); this.seen.clear(); }
  }
}
