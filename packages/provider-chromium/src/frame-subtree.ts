import { BrowserError } from '../../contracts/src/index.js';
import { record } from '../../contracts/src/validation.js';
import { frameReadBinding } from './frame-read.js';
import type { FrameSessions } from './frame-sessions.js';
import { frameNodeRoot, withFrameNodeScope } from './frame-node-scope.js';
import { readAXTree } from './ax-reader.js';

export function frameSubtreeRequest(raw: unknown) {
  const value = record(raw);
  if (Object.keys(value).some(key => !['binding', 'root'].includes(key)))
    throw new BrowserError('INVALID_REQUEST', 'Invalid child subtree request');
  return { binding: frameReadBinding(value.binding), root: frameNodeRoot(value.root) };
}
export async function readFrameSubtree(graph: FrameSessions, raw: unknown, origin: string, signal: AbortSignal) {
  const request = frameSubtreeRequest(raw);
  return withFrameNodeScope(graph, request.binding, request.root, origin, signal, async scope => {
    const read = await readAXTree({ frameId: scope.frameId, backendNodeId: scope.rootBackendId }, scope.send, signal);
    return scope.filter(read.nodes, read.truncated, 256);
  });
}
