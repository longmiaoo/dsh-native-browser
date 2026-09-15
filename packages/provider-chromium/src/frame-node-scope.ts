import { BrowserError } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import { bindFrameDocument, type FrameReadBinding } from './frame-read.js';
import type { FrameSessions } from './frame-sessions.js';
import { frameQueryDocumentFunction, frameQueryNodeFunction, frameWithinRootFunction } from './frame-query-functions.js';
type Dict = Record<string, any>;
export interface FrameNodeRoot { backendNodeId: number; role: string; name: string; editable: boolean }
export function frameNodeRoot(raw: unknown): FrameNodeRoot {
  const value = record(raw);
  if (Object.keys(value).some(key => !['backendNodeId', 'role', 'name', 'editable'].includes(key))
    || !Number.isSafeInteger(value.backendNodeId) || Number(value.backendNodeId) <= 0
    || typeof value.name !== 'string' || value.name.length > 1000 || typeof value.editable !== 'boolean')
    throw new BrowserError('INVALID_REQUEST', 'Invalid bound child observation root');
  return { backendNodeId: Number(value.backendNodeId), role: string(value.role, 80), name: value.name, editable: value.editable };
}
type NodeScope = {
  frameId: string; rootBackendId: number;
  send(method: string, params: Dict): Promise<Dict>;
  filter(nodes: Dict[], truncated: boolean, limit: number): Promise<{nodes: Dict[]; truncated: boolean}>;
};

/** Shared private-object/document fence for child query and subtree acquisition.
 * The provider must supply a cached semantic root, never a model-selected backend. */
export async function withFrameNodeScope<T>(graph: FrameSessions, binding: FrameReadBinding, root: FrameNodeRoot | undefined,
  origin: string, signal: AbortSignal, use: (scope: NodeScope) => Promise<T>): Promise<T> {
  const { before, target } = await bindFrameDocument(graph, binding, origin, signal);
  const scope = graph.openQueryRead(target.sessionId!, before.revision, signal);
  let result: T;
  try {
    const resolve = async (backendNodeId: number) => {
      const response = await scope.send('DOM.resolveNode', { backendNodeId, executionContextId: target.context!.id });
      const id = response.object?.objectId;
      if (typeof id !== 'string' || !id || id.length > 512) throw new BrowserError('STALE_TARGET', 'Bound child node is unavailable');
      return id as string;
    };
    const check = async (objectId: string, functionDeclaration: string, ancestor?: string) => {
      const response = await scope.send('Runtime.callFunctionOn', { objectId, functionDeclaration,
        arguments: ancestor === undefined ? [] : [{ objectId: ancestor }], returnByValue: true });
      return !response.exceptionDetails && response.result?.value === true;
    };
    const identity = async (objectId: string, backend: number, role: string, name: string, editable?: boolean) => {
      const response = await scope.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
      const node = response.nodes?.find((item: Dict) => item.backendDOMNodeId === backend);
      const editor = node?.role?.value === 'generic'
        && node.properties?.some((p: Dict) => p.name === 'focusable' && p.value?.value === true) === true
        && node.properties?.some((p: Dict) => p.name === 'editable' && ['plaintext', 'richtext'].includes(p.value?.value)) === true;
      if (!node || node.ignored || node.role?.value !== role || (node.name?.value ?? '') !== name
        || editable !== undefined && editable !== editor) throw new BrowserError('STALE_TARGET', 'Bound child semantic identity changed');
    };
    await scope.send('Accessibility.enable', {});
    const documentRoot = (await scope.send('Accessibility.getRootAXNode', { frameId: target.frameId })).node;
    if (documentRoot?.frameId !== target.frameId || !Number.isSafeInteger(documentRoot.backendDOMNodeId) || documentRoot.backendDOMNodeId <= 0)
      throw new BrowserError('STALE_TARGET', 'Child document root is unavailable');
    const documentObject = await resolve(documentRoot.backendDOMNodeId);
    if (!await check(documentObject, frameQueryDocumentFunction)) throw new BrowserError('POLICY_DENIED', 'Wrong child document object');
    const rootBackendId = root?.backendNodeId ?? documentRoot.backendDOMNodeId;
    const rootObject = root ? await resolve(root.backendNodeId) : documentObject;
    const verifyRoot = async () => {
      if (!await check(documentObject, frameQueryDocumentFunction)) throw new BrowserError('STALE_TARGET', 'Child document changed');
      if (root) {
        if (!await check(rootObject, frameQueryNodeFunction)) throw new BrowserError('STALE_TARGET', 'Child observation root left its document');
        await identity(rootObject, root.backendNodeId, root.role, root.name, root.editable);
      }
    };
    await verifyRoot();
    result = await use({ frameId: target.frameId, rootBackendId,
      send: (method, params) => method === 'Accessibility.getPartialAXTree' && params.backendNodeId === rootBackendId
        ? scope.send(method, { objectId: rootObject, fetchRelatives: false }) : scope.send(method, params),
      filter: async (nodes, truncated, limit) => {
        const kept: Dict[] = []; truncated ||= nodes.length > limit;
        for (const node of nodes.slice(0, limit)) {
          if (!Number.isSafeInteger(node.backendDOMNodeId) || node.backendDOMNodeId <= 0) { truncated = true; continue; }
          const object = await resolve(node.backendDOMNodeId);
          const isDocument = !root && node.backendDOMNodeId === documentRoot.backendDOMNodeId;
          if (!await check(object, isDocument ? frameQueryDocumentFunction : root ? frameWithinRootFunction : frameQueryNodeFunction, root ? rootObject : undefined)) { truncated = true; continue; }
          await identity(object, node.backendDOMNodeId, node.role.value, node.name.value);
          kept.push(node);
        }
        return { nodes: kept, truncated };
      }
    });
    await verifyRoot();
  } finally { await scope.close(); }
  const after = await graph.snapshot(signal);
  if (after.revision !== before.revision || JSON.stringify(after.frames) !== JSON.stringify(before.frames))
    throw new BrowserError('STALE_TARGET', 'Frame changed during scoped read or cleanup');
  return result;
}
