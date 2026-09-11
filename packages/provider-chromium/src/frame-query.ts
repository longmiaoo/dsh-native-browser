import { BrowserError } from '../../contracts/src/index.js';
import { record, semanticQuery } from '../../contracts/src/validation.js';
import type { FrameSessions } from './frame-sessions.js';
import { frameReadBinding } from './frame-read.js';
import { findAXNodes } from './ax-query.js';
import { frameNodeRoot, withFrameNodeScope } from './frame-node-scope.js';

export function frameFindRequest(raw: unknown) {
  const value = record(raw);
  if (Object.keys(value).some(key => !['binding', 'query', 'root'].includes(key)))
    throw new BrowserError('INVALID_REQUEST', 'Invalid bound child query');
  return { binding: frameReadBinding(value.binding), query: semanticQuery(value.query),
    ...(value.root === undefined ? {} : { root: frameNodeRoot(value.root) }) };
}

/** Explicit child document/subtree query; raw name-computation work belongs to Chromium. */
export async function findFrameAX(graph: FrameSessions, raw: unknown, origin: string, signal: AbortSignal) {
  const request = frameFindRequest(raw);
  return withFrameNodeScope(graph, request.binding, request.root, origin, signal, async scope => {
    const candidates = await findAXNodes({ frameId: scope.frameId, backendNodeId: scope.rootBackendId, query: request.query }, scope.send, signal);
    return scope.filter(candidates.nodes, candidates.truncated, 128);
  });
}
