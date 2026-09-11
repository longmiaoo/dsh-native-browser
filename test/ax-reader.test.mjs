import assert from 'node:assert/strict';
import test from 'node:test';
import { readAXTree, axReadLimits, axReadRequest } from '../dist/packages/provider-chromium/src/ax-reader.js';
const node = (id, role, name = '', children = []) => ({ nodeId: String(id), backendDOMNodeId: Number(id) || 1,
  role: { value: role }, name: { value: name }, childIds: children.map(String) });
function fixture(root, responses) {
  const calls = [], controller = new AbortController();
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Accessibility.getRootAXNode') return { node: root };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [root] };
    assert.equal(method, 'Accessibility.getChildAXNodes');
    return { nodes: typeof responses === 'function' ? responses(params.id) : responses[params.id] ?? [] };
  };
  return { calls, controller, send, read: (options = { frameId: 'frame' }) => readAXTree(options, send, controller.signal) };
}
test('AX traversal follows only reachable links, reuses ignored descendants, and projects no values/sources', async () => {
  const root = node(1, 'RootWebArea', '', [2]);
  const ignored = { ...node(2, 'none', '', [3]), ignored: true };
  const button = { ...node(3, 'button', '按钮', [4]), value: { value: 'password-secret' },
    name: { value: '按钮', sources: [{ value: 'hidden-source' }] }, properties: [{ name: 'url', value: { value: 'private-url' } }, { name: 'disabled', value: { value: true } }] };
  const f = fixture(root, { 1: [ignored, button, node(99, 'button', 'Outside')], 3: [node(4, 'StaticText', '按钮', [5])] });
  const r = await f.read();
  assert.equal(r.truncated, false); assert.equal(r.acquisition.calls, 3);
  assert.deepEqual(r.nodes.map(n => n.name.value), ['', '按钮', '按钮']);
  assert.deepEqual(r.nodes[1].properties, [{ name: 'disabled', value: { value: true } }]);
  for (const secret of ['password-secret', 'hidden-source', 'private-url', 'Outside']) assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(f.calls.some(c => c.params.id === '2' || c.params.id === '4'), false);
});
test('AX subtree traversal starts from exact backend identity and never requests the document root', async () => {
  const f = fixture(node(20, 'region', 'Pane', [21]), { 20: [node(21, 'button', 'Inside')] });
  const r = await f.read({ frameId: 'frame', backendNodeId: 20 });
  assert.equal(r.nodes[1].name.value, 'Inside');
  assert.deepEqual(f.calls[0], { method: 'Accessibility.getPartialAXTree', params: { backendNodeId: 20, fetchRelatives: false } });
  assert.equal(f.calls.some(c => c.method === 'Accessibility.getRootAXNode'), false);
  await assert.rejects(f.read({ frameId: 'frame', backendNodeId: 999 }), e => e.code === 'STALE_TARGET');
});
test('AX discovery has explicit wide-tree node/retention/output bounds instead of transferring a full tree', async () => {
  const root = node(1, 'RootWebArea', '', Array.from({ length: 10000 }, (_, i) => i + 2));
  const f = fixture(root, { 1: Array.from({ length: 10000 }, (_, i) => node(i + 2, 'button', `wide-${i}`)) });
  const r = await f.read();
  assert.equal(r.truncated, true); assert.ok(r.nodes.length > 100);
  assert.ok(r.acquisition.visited <= axReadLimits.nodes);
  assert.ok(r.acquisition.retainedBytes <= axReadLimits.retainedBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= axReadLimits.bytes);
});
test('AX discovery bounds depth, calls, retained edges and cycles', async () => {
  const deep = fixture(node(1, 'generic', '', [2]), id => [node(Number(id) + 1, 'generic', '', [Number(id) + 2])]);
  const d = await deep.read(); assert.equal(d.truncated, true); assert.ok(d.acquisition.calls <= axReadLimits.depth + 1);
  const width = 200;
  const root = node(1, 'RootWebArea', '', Array.from({ length: width }, (_, i) => i + 2));
  const wide = fixture(root, id => id === '1' ? root.childIds.map(i => node(i, 'paragraph', '', [Number(i) + 1000])) : [node(Number(id) + 1000, 'StaticText', 'Text')]);
  const w = await wide.read(); assert.equal(w.truncated, true); assert.equal(w.acquisition.calls, axReadLimits.calls);
  const cycle = fixture(node(1, 'generic', '', [2]), { 1: [node(2, 'generic', '', [1])] });
  assert.equal((await cycle.read()).truncated, true);
  const edges = fixture(root, { 1: root.childIds.map(i => node(i, 'generic', '', root.childIds)) });
  assert.ok((await edges.read()).acquisition.edges <= axReadLimits.edges);
});
test('AX oversize names are omitted without manufacturing shortened control identities', async () => {
  const f = fixture(node(1, 'RootWebArea', '', [2, 3]), { 1: [node(2, 'button', 'x'.repeat(axReadLimits.name + 1)), node(3, 'button', 'Valid')] });
  const r = await f.read(); assert.equal(r.truncated, true);
  assert.deepEqual(r.nodes.map(n => n.name.value), ['', 'Valid']);
  const large = fixture(node(1, 'RootWebArea', '', Array.from({ length: 100 }, (_, i) => i + 2)),
    { 1: Array.from({ length: 100 }, (_, i) => node(i + 2, 'StaticText', '中'.repeat(16000))) });
  const result = await large.read();
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= axReadLimits.bytes);
  assert.ok(result.acquisition.retainedBytes <= axReadLimits.retainedBytes);
});
test('AX reads stop at frame boundaries and do not descend foreign-frame roots', async () => {
  const f = fixture(node(1, 'RootWebArea', '', [2, 3]), { 1: [node(2, 'Iframe', '', [9]),
    { ...node(3, 'RootWebArea', 'Foreign', [8]), frameId: 'other' }] });
  const r = await f.read(); assert.equal(r.truncated, true); assert.equal(r.acquisition.calls, 2);
  assert.equal(r.nodes.some(n => n.name.value === 'Foreign'), false);
});
test('AX cancellation/errors do not fall back or turn into a partial success', async () => {
  const f = fixture(node(1, 'RootWebArea', '', [2]), { 1: [node(2, 'button', 'Inside')] });
  f.controller.abort(); await assert.rejects(f.read(), e => e.code === 'CANCELLED'); assert.equal(f.calls.length, 0);
  const controller = new AbortController();
  await assert.rejects(readAXTree({ frameId: 'frame' }, async () => { controller.abort(); return { node: node(1, 'RootWebArea') }; }, controller.signal), e => e.code === 'CANCELLED');
  const error = new Error('CDP failed');
  await assert.rejects(readAXTree({ frameId: 'frame' }, async () => { throw error; }, new AbortController().signal), e => e === error);
  for (const value of [{}, { frameId: 'f', backendNodeId: -1 }, { frameId: 'f', depth: -1 }, { frameId: 'f', objectId: 'x' }]) assert.throws(() => axReadRequest(value));
});
