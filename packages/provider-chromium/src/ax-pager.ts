import { BrowserError, checkAbort } from '../../contracts/src/index.js';
import { axReadRequest, type AXReadRequest } from './ax-reader.js';
import { checkedValue } from './checked.js';

type Dict = Record<string, any>;
type Frame = { id: string; children: string[]; offset: number; emitted: boolean; terminal: boolean };
type Walk = { binding: string; root: AXReadRequest; stack: Frame[]; seen: Set<string>; expiresAt: number;
  page: number; incomplete: boolean };
export const axPageLimits = Object.freeze({ contexts: 8, ttlMs: 120000, nodes: 100, bytes: 16 * 1024,
  calls: 128, depth: 64, children: 8192, responseNodes: 32768, visited: 16384, stateBytes: 256 * 1024,
  cacheNodes: 256, cacheBytes: 1024 * 1024 });
export interface AXPageRequest extends AXReadRequest { continuation?: string }
export function axPageRequest(value: unknown): AXPageRequest {
  const raw = value as Dict;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['frameId', 'backendNodeId', 'continuation'].includes(key)))
    throw new BrowserError('INVALID_REQUEST', 'Invalid AX page request');
  const root = axReadRequest({ frameId: raw.frameId, ...(raw.backendNodeId === undefined ? {} : { backendNodeId: raw.backendNodeId }) });
  if (raw.continuation !== undefined && (typeof raw.continuation !== 'string' || !raw.continuation || raw.continuation.length > 128))
    throw new BrowserError('INVALID_REQUEST', 'Invalid AX continuation');
  return { ...root, ...(raw.continuation === undefined ? {} : { continuation: raw.continuation }) };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 128;
const sameChildren = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const regionRoles = new Set(['region', 'form', 'group', 'dialog', 'alertdialog', 'main', 'navigation', 'search',
  'complementary', 'banner', 'contentinfo', 'table', 'list', 'tabpanel']);

/** Source-side, live DFS windows. Retained continuations contain identities/offsets,
 * never page text or values. They are not an atomic snapshot or a mutation changefeed. */
export class AXPager {
  private readonly walks = new Map<string, Walk>();
  private active = 0;
  private readonly operations = new Set<{ binding: string; cancelled: boolean }>();
  constructor(private readonly now = Date.now, private readonly token = () => crypto.randomUUID()) {}
  private prune() { for (const [token, walk] of this.walks) if (walk.expiresAt <= this.now()) this.walks.delete(token); }
  get size() { this.prune(); return this.walks.size; }
  has(token: string) { this.prune(); return this.walks.has(token); }
  discard(token: string | undefined) { if (token !== undefined) this.walks.delete(token); }
  clear() { this.walks.clear(); for (const operation of this.operations) operation.cancelled = true; }
  revoke(bindingPrefix: string) {
    for (const [token, walk] of this.walks) if (walk.binding.startsWith(bindingPrefix)) this.walks.delete(token);
    for (const operation of this.operations) if (operation.binding.startsWith(bindingPrefix)) operation.cancelled = true;
  }
  async read(raw: AXPageRequest, binding: string, send: (method: string, params: Dict) => Promise<Dict>, signal: AbortSignal,
    validate?: (nodes: Dict[]) => Promise<{ nodes: Dict[]; truncated: boolean }>) {
    const request = axPageRequest(raw), { continuation, ...rootRequest } = request;
    checkAbort(signal); this.prune();
    let walk = continuation === undefined ? undefined : this.walks.get(continuation);
    if (continuation !== undefined && (!walk || walk.binding !== binding || JSON.stringify(walk.root) !== JSON.stringify(rootRequest)))
      throw new BrowserError('STALE_TARGET', 'Continuation expired, changed scope or is unavailable');
    if (walk) this.walks.delete(continuation!); // Single-use: parallel/replayed tokens cannot skip a window.
    if (this.walks.size + this.active >= axPageLimits.contexts) throw new BrowserError('QUEUE_FULL', 'AX continuation capacity reached');
    this.active++;
    const operation = { binding, cancelled: false }; this.operations.add(operation);
    const check = () => { checkAbort(signal); if (operation.cancelled) throw new BrowserError('LEASE_REVOKED', 'AX page control ended'); };
    try {
      const nodes: Dict[] = [], cache = new Map<string, { node: Dict; bytes: number }>();
      let calls = 0, outputBytes = 0, cacheBytes = 0, regions = 0;
      const call = async (method: string, params: Dict) => {
        check();
        if (calls >= axPageLimits.calls) throw new BrowserError('QUEUE_FULL', 'AX page call budget exceeded');
        calls++; const result = await send(method, params); check(); return result;
      };
      const normalize = (raw: Dict): Dict => {
        if (!raw || !id(raw.nodeId)) throw new BrowserError('STALE_TARGET', 'Invalid AX identity');
        const role = raw.role?.value, name = raw.name?.value ?? '';
        if (typeof role !== 'string' || role.length > 128 || typeof name !== 'string') throw new BrowserError('STALE_TARGET', 'Invalid AX node');
        const foreign = raw.frameId !== undefined && raw.frameId !== request.frameId;
        const terminal = foreign || ['StaticText', 'InlineTextBox', 'Iframe', 'IframePresentational'].includes(role);
        const children = terminal ? [] : raw.childIds ?? [];
        if (!Array.isArray(children) || children.length > axPageLimits.children)
          throw new BrowserError('QUEUE_FULL', 'AX sibling list exceeds page traversal budget; use a smaller region');
        if (children.some(child => !id(child)) || new Set(children).size !== children.length)
          throw new BrowserError('STALE_TARGET', 'Invalid AX child identities');
        // Oversize names are omitted, never shortened into an apparent exact identity.
        const properties = Array.isArray(raw.properties) ? raw.properties.slice(0, 64).filter((p: Dict) => p &&
          (['disabled', 'focused', 'focusable'].includes(p.name) && typeof p.value?.value === 'boolean'
            || p.name === 'editable' && ['plaintext', 'richtext'].includes(p.value?.value)
            || p.name === 'checked' && checkedValue(p.value?.value) !== undefined))
          .map((p: Dict) => ({ name: p.name, value: { value: p.value.value } })) : [];
        return { nodeId: raw.nodeId, childIds: [...children], terminal, foreign,
          boundary: foreign || ['Iframe', 'IframePresentational'].includes(role), ignored: raw.ignored === true,
          role: { value: role }, ...(name.length <= 16384 ? { name: { value: name } } : { oversized: true }),
          ...(Number.isSafeInteger(raw.backendDOMNodeId) && raw.backendDOMNodeId > 0 ? { backendDOMNodeId: raw.backendDOMNodeId } : {}), properties };
      };
      const remember = (raw: Dict) => {
        const node = normalize(raw), size = bytes(node);
        if (size > axPageLimits.cacheBytes) throw new BrowserError('QUEUE_FULL', 'AX node exceeds page cache budget');
        const old = cache.get(node.nodeId); if (old) { cacheBytes -= old.bytes; cache.delete(node.nodeId); }
        while (cache.size >= axPageLimits.cacheNodes || cacheBytes + size > axPageLimits.cacheBytes) {
          const key = cache.keys().next().value!; cacheBytes -= cache.get(key)!.bytes; cache.delete(key);
        }
        cache.set(node.nodeId, { node, bytes: size }); cacheBytes += size; return node;
      };
      const initial = request.backendNodeId === undefined
        ? (await call('Accessibility.getRootAXNode', { frameId: request.frameId })).node
        : (await call('Accessibility.getPartialAXTree', { backendNodeId: request.backendNodeId, fetchRelatives: false })).nodes
          ?.find((node: Dict) => node.backendDOMNodeId === request.backendNodeId);
      const root = remember(initial);
      const frame = (node: Dict): Frame => ({ id: node.nodeId, children: node.childIds, offset: 0, emitted: false, terminal: node.terminal });
      walk ??= { binding, root: rootRequest, stack: [frame(root)], seen: new Set([root.nodeId]),
        expiresAt: this.now() + axPageLimits.ttlMs, page: 0, incomplete: false };
      const child = async (parent: Frame, childId: string): Promise<Dict> => {
        const saved = cache.get(childId); if (saved) return saved.node;
        const response = await call('Accessibility.getChildAXNodes', { id: parent.id, frameId: request.frameId });
        if (!Array.isArray(response.nodes) || response.nodes.length > axPageLimits.responseNodes)
          throw new BrowserError('QUEUE_FULL', 'AX sibling response exceeds bounded scan');
        // Chrome may return ignored descendants too. Retain only the next direct-child window.
        const start = parent.children.indexOf(childId), wanted = new Set(parent.children.slice(start, start + axPageLimits.nodes));
        for (const raw of response.nodes) if (wanted.has(raw.nodeId)) remember(raw);
        const found = cache.get(childId);
        if (!found) throw new BrowserError('STALE_TARGET', 'AX traversal child changed');
        return found.node;
      };
      // Freshly rebuild the live active path. A changed child order must not silently
      // shift saved offsets onto different nodes. Completed earlier windows stay historical.
      let current = root;
      for (let index = 0; index < walk.stack.length; index++) {
        const saved = walk.stack[index]!;
        if (current.nodeId !== saved.id || current.terminal !== saved.terminal || !sameChildren(current.childIds, saved.children))
          throw new BrowserError('STALE_TARGET', 'AX traversal path changed; start a fresh read');
        if (index + 1 < walk.stack.length) current = await child(saved, walk.stack[index + 1]!.id);
      }
      while (walk.stack.length) {
        check();
        const top = walk.stack.at(-1)!;
        if (!top.emitted) {
          const node = cache.get(top.id)?.node;
          if (!node) throw new BrowserError('STALE_TARGET', 'AX page path cache is unavailable');
          if (node.boundary || node.oversized) walk.incomplete = true;
          if (!node.ignored && !node.foreign && !node.oversized && node.role.value !== 'InlineTextBox') {
            const entry = { role: node.role, name: node.name, properties: node.properties,
              ...(node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }) };
            const size = bytes(entry) + 1;
            const isRegion = regionRoles.has(node.role.value) && !!node.name.value.trim();
            if (size > axPageLimits.bytes) walk.incomplete = true;
            else {
              if (nodes.length >= axPageLimits.nodes || outputBytes + size > axPageLimits.bytes || isRegion && regions >= 24) break;
              nodes.push(entry); outputBytes += size;
              if (isRegion) regions++;
            }
          }
          top.emitted = true;
        }
        if (top.offset === top.children.length || top.terminal) { walk.stack.pop(); continue; }
        if (walk.stack.length >= axPageLimits.depth) { walk.incomplete = true; walk.stack.pop(); continue; }
        if (calls >= axPageLimits.calls || nodes.length >= axPageLimits.nodes) break;
        const nextId = top.children[top.offset]!;
        if (walk.seen.has(nextId)) throw new BrowserError('STALE_TARGET', 'AX traversal repeated an identity');
        if (walk.seen.size >= axPageLimits.visited) throw new BrowserError('QUEUE_FULL', 'AX traversal node budget reached; narrow the region');
        const next = await child(top, nextId); top.offset++; walk.seen.add(nextId); walk.stack.push(frame(next));
      }
      // Ownership/semantic verification happens before continuation publication.
      // Omission remains sticky across all later windows in this traversal.
      const verified = validate ? await validate(nodes) : { nodes, truncated: false };
      walk.incomplete ||= verified.truncated;
      check();
      if (walk.expiresAt <= this.now()) throw new BrowserError('STALE_TARGET', 'AX continuation expired during read');
      const more = walk.stack.length > 0;
      let nextToken: string | undefined;
      if (more) {
        if (bytes({ ...walk, seen: [...walk.seen] }) > axPageLimits.stateBytes)
          throw new BrowserError('QUEUE_FULL', 'AX continuation state budget reached; narrow the region');
        nextToken = this.token(); this.walks.set(nextToken, walk);
      }
      return { nodes: verified.nodes, truncated: more || walk.incomplete, page: { index: walk.page++, incomplete: walk.incomplete,
        ...(nextToken ? { continuation: nextToken } : {}) }, acquisition: { calls, bytes: outputBytes, visited: walk.seen.size } };
    } finally { this.active--; this.operations.delete(operation); }
  }
}
