import { BrowserError, checkAbort, type SemanticQuery } from '../../contracts/src/index.js';
import { record, semanticQuery } from '../../contracts/src/validation.js';
import { axReadRequest, axReadLimits, type AXReadRequest } from './ax-reader.js';
import { checkedValue } from './checked.js';
type Dict = Record<string, any>;
export type AXFindRequest = AXReadRequest & { query: SemanticQuery };
export function axFindRequest(raw: unknown): AXFindRequest {
  const v = record(raw);
  if (Object.keys(v).some(key => !['query', 'frameId', 'backendNodeId'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid semantic lookup');
  return { ...axReadRequest({ frameId: v.frameId, ...(v.backendNodeId === undefined ? {} : { backendNodeId: v.backendNodeId }) }), query: semanticQuery(v.query) };
}

/** Exact, source-filtered query; no paging, fuzzy matching, implicit rebind, or action.
 * Chrome computes accessible names within the requested DOM subtree. Output is bounded,
 * but this API does not bound browser-internal work or a large raw matching response. */
export async function findAXNodes(raw: AXFindRequest, send: (method: string, params: Dict) => Promise<Dict>, signal: AbortSignal) {
  const request = axFindRequest(raw);
  const call = async (method: string, params: Dict) => {
    checkAbort(signal); const result = await send(method, params); checkAbort(signal); return result;
  };
  const backendNodeId = request.backendNodeId ?? (await call('DOM.getDocument', { depth: 0, pierce: false })).root?.backendNodeId;
  if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new BrowserError('STALE_TARGET', 'Query root is unavailable');
  const result = await call('Accessibility.queryAXTree', { backendNodeId, accessibleName: request.query.name,
    ...(request.query.role === undefined ? {} : { role: request.query.role }) });
  if (!Array.isArray(result.nodes)) throw new BrowserError('STALE_TARGET', 'Semantic query result is unavailable');
  const nodes: Dict[] = [], seen = new Set<number>();
  let truncated = result.nodes.length > axReadLimits.nodes, bytes = 512;
  for (let i = 0; i < Math.min(result.nodes.length, axReadLimits.nodes); i++) {
    checkAbort(signal);
    const raw = result.nodes[i];
    if (!raw || typeof raw !== 'object') throw new BrowserError('STALE_TARGET', 'Invalid semantic candidate');
    if (raw.ignored) continue;
    if (raw.frameId !== undefined && raw.frameId !== request.frameId) { truncated = true; continue; }
    const role = raw.role?.value, name = raw.name?.value;
    if (typeof role !== 'string' || role.length > 80 || name !== request.query.name ||
      request.query.role !== undefined && role !== request.query.role) {
      throw new BrowserError('STALE_TARGET', 'Semantic query returned a mismatched candidate');
    }
    if (!Number.isSafeInteger(raw.backendDOMNodeId) || raw.backendDOMNodeId <= 0) { truncated = true; continue; }
    if (seen.has(raw.backendDOMNodeId)) continue;
    const entry = { backendDOMNodeId: raw.backendDOMNodeId, role: { value: role }, name: { value: name },
      properties: Array.isArray(raw.properties) ? raw.properties.slice(0, 64)
        .filter((p: Dict) => p && ((p.name === 'disabled' || p.name === 'focused') && typeof p.value?.value === 'boolean'
          || role === 'generic' && (p.name === 'focusable' && typeof p.value?.value === 'boolean'
            || p.name === 'editable' && ['plaintext', 'richtext'].includes(p.value?.value))
          || p.name === 'checked' && checkedValue(p.value?.value) !== undefined))
        .map((p: Dict) => ({ name: p.name, value: { value: p.value.value } })) : [] };
    const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    if (bytes + size > axReadLimits.bytes) { truncated = true; break; }
    bytes += size; seen.add(raw.backendDOMNodeId); nodes.push(entry);
  }
  return { nodes, truncated };
}
