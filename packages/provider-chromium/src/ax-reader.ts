import { BrowserError, checkAbort } from '../../contracts/src/index.js';
import { checkedValue } from './checked.js';
type Dict = Record<string, any>;
export interface AXReadRequest { frameId: string; backendNodeId?: number }
export const axReadLimits = { nodes: 2048, calls: 128, depth: 64, bytes: 192 * 1024,
  retainedBytes: 1024 * 1024, edges: 8192, name: 16384 } as const;
export function axReadRequest(raw: unknown): AXReadRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BrowserError('INVALID_REQUEST', 'Invalid AX read');
  const p = raw as Dict;
  if (typeof p.frameId !== 'string' || !p.frameId || p.frameId.length > 128 ||
    Object.keys(p).some(k => !['frameId', 'backendNodeId'].includes(k)) ||
    p.backendNodeId !== undefined && (!Number.isSafeInteger(p.backendNodeId) || p.backendNodeId <= 0)) {
    throw new BrowserError('INVALID_REQUEST', 'AX reads require a frame and optional exact backend root');
  }
  return p as AXReadRequest;
}
type Cached = { id: string; children: string[]; entry?: Dict; terminal: boolean };
const idOf = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

/** Executes next to CDP, inside MV3 in production. Bounds retained/output work, not Chrome's
 * internal allocation of a potentially large single sibling response. No native raw-tree transfer. */
export async function readAXTree(raw: AXReadRequest, send: (method: string, params: Dict) => Promise<Dict>, signal: AbortSignal) {
  const options = axReadRequest(raw), nodes: Dict[] = [], cache = new Map<string, Cached>();
  let truncated = false, calls = 0, bytes = 512, visited = 0, retainedBytes = 0, edges = 0;
  const call = async (method: string, params: Dict) => {
    checkAbort(signal); calls++;
    const result = await send(method, params); checkAbort(signal); return result;
  };
  const remember = (raw: Dict): Cached | undefined => {
    if (!raw || !idOf(raw.nodeId)) throw new BrowserError('STALE_TARGET', 'Invalid AX node identity');
    const previous = cache.get(raw.nodeId); if (previous) return previous;
    if (cache.size >= axReadLimits.nodes) { truncated = true; return; }
    const role = raw.role?.value, name = raw.name?.value ?? '';
    const foreignFrame = raw.frameId !== undefined && raw.frameId !== options.frameId;
    const frameBoundary = role === 'Iframe' || role === 'IframePresentational' || foreignFrame;
    const terminal = role === 'StaticText' || role === 'InlineTextBox' || frameBoundary;
    if (frameBoundary) truncated = true;
    const children: string[] = [];
    if (!terminal && Array.isArray(raw.childIds)) {
      for (let i = 0; i < Math.min(raw.childIds.length, axReadLimits.nodes, axReadLimits.edges - edges); i++) {
        if (!idOf(raw.childIds[i])) throw new BrowserError('STALE_TARGET', 'Invalid AX child identity');
        children.push(raw.childIds[i]);
      }
      if (raw.childIds.length > children.length) truncated = true;
    }
    let entry: Dict | undefined;
    if (!raw.ignored && !foreignFrame && role !== 'InlineTextBox') {
      if (typeof role !== 'string' || role.length > 128 || typeof name !== 'string' || name.length > axReadLimits.name) {
        truncated = true; // Do not shorten an exact control identity and later treat it as authentic.
      } else {
        entry = { role: { value: role }, name: { value: name } };
        if (Number.isSafeInteger(raw.backendDOMNodeId) && raw.backendDOMNodeId > 0) entry.backendDOMNodeId = raw.backendDOMNodeId;
        if (Array.isArray(raw.properties)) entry.properties = raw.properties.slice(0, 64)
          .filter((p: Dict) => p && ((p.name === 'disabled' || p.name === 'focused') && typeof p.value?.value === 'boolean'
            || role === 'generic' && (p.name === 'focusable' && typeof p.value?.value === 'boolean'
              || p.name === 'editable' && ['plaintext', 'richtext'].includes(p.value?.value))
            || p.name === 'checked' && checkedValue(p.value?.value) !== undefined))
          .map((p: Dict) => ({ name: p.name, value: { value: p.value.value } }));
      }
    }
    const item: Cached = { id: raw.nodeId, children, terminal, ...(entry ? { entry } : {}) };
    const size = new TextEncoder().encode(JSON.stringify(item)).length;
    if (retainedBytes + size > axReadLimits.retainedBytes) { truncated = true; return; }
    retainedBytes += size; edges += children.length;
    cache.set(item.id, item); return item;
  };
  const initial = options.backendNodeId === undefined
    ? (await call('Accessibility.getRootAXNode', { frameId: options.frameId })).node
    : (await call('Accessibility.getPartialAXTree', { backendNodeId: options.backendNodeId, fetchRelatives: false })).nodes
      ?.find((n: Dict) => n.backendDOMNodeId === options.backendNodeId);
  if (!initial) throw new BrowserError('STALE_TARGET', 'AX observation root is unavailable');
  const root = remember(initial);
  if (!root) throw new BrowserError('QUEUE_FULL', 'AX observation root exceeds retention budget');
  const queue = [{ id: root.id, depth: 0 }], queued = new Set([root.id]);
  for (let index = 0; index < queue.length; index++) {
    checkAbort(signal);
    const work = queue[index]!, node = cache.get(work.id);
    if (!node) { truncated = true; continue; }
    visited++;
    if (node.entry) {
      const size = new TextEncoder().encode(JSON.stringify(node.entry)).length + 1;
      if (bytes + size > axReadLimits.bytes) { truncated = true; break; }
      bytes += size; nodes.push(node.entry);
    }
    if (node.terminal || node.children.length === 0) continue;
    if (work.depth >= axReadLimits.depth) { truncated = true; continue; }
    if (node.children.some(id => !cache.has(id))) {
      if (calls >= axReadLimits.calls || cache.size >= axReadLimits.nodes) truncated = true;
      else {
        const children = await call('Accessibility.getChildAXNodes', { id: node.id, frameId: options.frameId });
        if (!Array.isArray(children.nodes)) throw new BrowserError('STALE_TARGET', 'AX subtree is unavailable');
        // Chromium includes ignored descendants. Cache them once; emit only reachable child links.
        for (let i = 0; i < Math.min(children.nodes.length, axReadLimits.nodes); i++) remember(children.nodes[i]);
        if (children.nodes.length > axReadLimits.nodes) truncated = true;
      }
    }
    for (const child of node.children) {
      if (queued.has(child)) { truncated = true; continue; }
      if (!cache.has(child) || queue.length >= axReadLimits.nodes) { truncated = true; continue; }
      queued.add(child); queue.push({ id: child, depth: work.depth + 1 });
    }
  }
  return { nodes, truncated, acquisition: { visited, calls, bytes, retainedBytes, edges } };
}
