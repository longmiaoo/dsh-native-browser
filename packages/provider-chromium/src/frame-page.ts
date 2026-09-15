import { BrowserError } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import { frameReadBinding, type FrameReadBinding } from './frame-read.js';
import { frameNodeRoot, withFrameNodeScope, type FrameNodeRoot } from './frame-node-scope.js';
import { AXPager, axPageLimits } from './ax-pager.js';
import type { FrameSessions } from './frame-sessions.js';

export interface FramePageRequest { binding: FrameReadBinding; root?: FrameNodeRoot; continuation?: string }
export function framePageRequest(raw: unknown): FramePageRequest {
  const v = record(raw);
  if (Object.keys(v).some(key => !['binding', 'root', 'continuation'].includes(key)))
    throw new BrowserError('INVALID_REQUEST', 'Invalid bound frame page request');
  return { binding: frameReadBinding(v.binding), ...(v.root === undefined ? {} : { root: frameNodeRoot(v.root) }),
    ...(v.continuation === undefined ? {} : { continuation: string(v.continuation, 128) }) };
}

/** Uses the same global pager as root reads. Tokens retain only identities/offsets;
 * private object handles are released and the graph rechecked before return. */
export async function readFramePage(graph: FrameSessions, raw: FramePageRequest, origin: string,
  signal: AbortSignal, pager: AXPager, leaseToken: string) {
  const request = framePageRequest(raw);
  const key = leaseToken + '|frame|' + JSON.stringify([request.binding, request.root?.backendNodeId ?? null]);
  let next: string | undefined;
  try {
    const result = await withFrameNodeScope(graph, request.binding, request.root, origin, signal, async scope => {
      const result = await pager.read({ frameId: scope.frameId, backendNodeId: scope.rootBackendId,
        ...(request.continuation === undefined ? {} : { continuation: request.continuation }) }, key, scope.send, signal,
        nodes => scope.filter(nodes, false, axPageLimits.nodes));
      next = result.page.continuation;
      return result;
    });
    if (next !== undefined && !pager.has(next)) throw new BrowserError('STALE_TARGET', 'Frame continuation expired or was revoked during final checks');
    return result;
  } catch (error) {
    // A final root check, group release or graph fence can still fail after the
    // pager returned. Remove only this newly minted token, not other readers.
    pager.discard(next);
    throw error;
  }
}
