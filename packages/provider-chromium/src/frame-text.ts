import { BrowserError } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import type { FrameSessions } from './frame-sessions.js';
import { frameReadBinding } from './frame-read.js';
import { withFrameNodeScope } from './frame-node-scope.js';

type Dict = Record<string, any>;

export function frameTextRequest(raw: unknown) {
  const value = record(raw);
  if (Object.keys(value).some(key => !['binding', 'text'].includes(key))) {
    throw new BrowserError('INVALID_REQUEST', 'Invalid bound child text check');
  }
  const text = string(value.text, 1000);
  if (!text.trim()) throw new BrowserError('INVALID_REQUEST', 'Child text check requires nonblank text');
  return { binding: frameReadBinding(value.binding), text };
}

const normalized = (value: string) => value.replace(/\s+/g, ' ');

/** A bounded postcondition predicate for large child documents. The source
 * returns only a boolean; candidate text and private object identities never
 * cross the provider boundary. */
export async function hasFrameText(graph: FrameSessions, raw: unknown, origin: string, signal: AbortSignal) {
  const request = frameTextRequest(raw);
  return withFrameNodeScope(graph, request.binding, undefined, origin, signal, async scope => {
    const response = await scope.send('Accessibility.queryAXTree', {
      backendNodeId: scope.rootBackendId, accessibleName: request.text
    });
    if (!Array.isArray(response.nodes)) throw new BrowserError('STALE_TARGET', 'Child text query is unavailable');
    let truncated = response.nodes.length > 128;
    const candidates: Dict[] = [];
    for (const node of response.nodes.slice(0, 128)) {
      if (!node || typeof node !== 'object' || typeof node.role?.value !== 'string'
        || typeof node.name?.value !== 'string') { truncated = true; continue; }
      // Preserve the public text-postcondition contract: control accessible
      // names are node identities, while Observation.text contains StaticText.
      if (node.role.value !== 'StaticText') continue;
      candidates.push(node);
    }
    const filtered = await scope.filter(candidates, truncated, 128);
    const expected = normalized(request.text);
    return { present: filtered.nodes.some(node => normalized(node.name.value).includes(expected)) };
  });
}
