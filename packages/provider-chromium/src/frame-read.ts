import { BrowserError } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import type { FrameSessions } from './frame-sessions.js';
import { readAXTree } from './ax-reader.js';

export interface FrameReadBinding {
  frameId: string; loaderId: string; contextUniqueId: string;
  rootFrameId: string; rootLoaderId: string;
}
export function frameReadBinding(raw: unknown): FrameReadBinding {
  const v = record(raw), keys = ['frameId', 'loaderId', 'contextUniqueId', 'rootFrameId', 'rootLoaderId'];
  if (Object.keys(v).some(key => !keys.includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid frame read binding');
  return { frameId: string(v.frameId, 128), loaderId: string(v.loaderId, 128), contextUniqueId: string(v.contextUniqueId, 128),
    rootFrameId: string(v.rootFrameId, 128), rootLoaderId: string(v.rootLoaderId, 128) };
}

/** Source-side content fence. Session IDs are resolved from current metadata,
 * never chosen by the request, and every read stays in exactly one document. */
export async function bindFrameDocument(graph: FrameSessions, raw: unknown, origin: string, signal: AbortSignal) {
  const binding = frameReadBinding(raw), before = await graph.snapshot(signal);
  const byId = new Map(before.frames.map(frame => [frame.frameId, frame]));
  const target = byId.get(binding.frameId), root = byId.get(binding.rootFrameId);
  if (!root || root.parentId !== undefined || root.loaderId !== binding.rootLoaderId || !target
    || target.loaderId !== binding.loaderId || target.context?.uniqueId !== binding.contextUniqueId)
    throw new BrowserError('STALE_TARGET', 'Frame read binding is no longer current');
  if (target === root) throw new BrowserError('INVALID_REQUEST', 'Use the root observation path');
  if (before.truncated || target.sessionId === undefined) throw new BrowserError('POLICY_DENIED', 'Frame authority is incomplete');
  let current = target; const seen = new Set<string>(), ancestry = [];
  while (true) {
    if (seen.has(current.frameId) || current.origin !== origin) throw new BrowserError('POLICY_DENIED', 'Frame ancestry is outside the lease');
    seen.add(current.frameId); ancestry.push(current); if (current === root) break;
    const parent = current.parentId === undefined ? undefined : byId.get(current.parentId);
    if (!parent) throw new BrowserError('POLICY_DENIED', 'Frame ancestry is incomplete');
    current = parent;
  }
  return { binding, before, target, root, ancestry };
}

export async function readFrameAX(graph: FrameSessions, raw: unknown, origin: string, signal: AbortSignal) {
  const { before, target } = await bindFrameDocument(graph, raw, origin, signal);
  const send = (method: string, params: Record<string, unknown>) => graph.readCommand(target.sessionId!, before.revision, method, params, signal);
  await send('Accessibility.enable', {});
  const result = await readAXTree({ frameId: target.frameId }, send, signal);
  const after = await graph.snapshot(signal);
  if (after.revision !== before.revision || JSON.stringify(after.frames) !== JSON.stringify(before.frames))
    throw new BrowserError('STALE_TARGET', 'Frame documents changed during AX read');
  return result;
}
