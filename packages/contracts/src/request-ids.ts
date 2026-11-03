/** Completed IDs remembered to reject replays. Bounded FIFO: a long-lived peer must
 * not be disconnected just because it has issued many requests over its lifetime. */
export const RECENT_REQUEST_IDS = 10_000;
export function rememberRequestId(seen: Set<string>, id: string, live: { has(id: string): boolean }): void {
  seen.add(id);
  if (seen.size <= RECENT_REQUEST_IDS) return;
  // Insertion order is oldest-first; never forget an ID that is still executing.
  for (const old of seen) if (!live.has(old)) { seen.delete(old); return; }
}
