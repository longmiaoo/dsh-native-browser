import { BrowserError, checkAbort } from '../../contracts/src/index.js';

/** Events are hints, not a lossless DOM log. A revision closes the check/subscribe race. */
export class ChangeClock {
  revision = 0;
  private listeners = new Set<() => void>();
  pulse(): void { this.revision++; for (const listener of [...this.listeners]) listener(); }
  wait(after: number, signal: AbortSignal, fallbackMs: number): Promise<void> {
    checkAbort(signal);
    if (this.revision !== after) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(wake); signal.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); try { checkAbort(signal); } catch (error) { reject(error); } };
      const timer = setTimeout(wake, fallbackMs);
      this.listeners.add(wake); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else if (this.revision !== after) wake();
    });
  }
}

export function actionDeadline(signal: AbortSignal, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BrowserError('DEADLINE_EXCEEDED', 'Action deadline exceeded')), timeoutMs);
  timer.unref();
  return { signal: AbortSignal.any([signal, controller.signal]), dispose: () => clearTimeout(timer) };
}

/** Shares its caller's deadline; never retries the action, only the read-only predicate. */
export async function waitUntil<T>(check: () => Promise<T | undefined>, options: {
  signal: AbortSignal; clock: ChangeClock; fallbackMs?: number;
}): Promise<T> {
  for (;;) {
    checkAbort(options.signal);
    const before = options.clock.revision;
    const result = await check();
    checkAbort(options.signal);
    if (result !== undefined) return result;
    await options.clock.wait(before, options.signal, options.fallbackMs ?? 100);
  }
}
