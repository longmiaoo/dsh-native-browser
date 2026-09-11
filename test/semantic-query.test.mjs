import assert from 'node:assert/strict';
import test from 'node:test';
import { axFindRequest, findAXNodes } from '../dist/packages/provider-chromium/src/ax-query.js';
import { semanticQuery, observeOptions, observationScope, sameScope } from '../dist/packages/contracts/src/validation.js';
import { applyObservationUpdate } from '../dist/packages/contracts/src/observations.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
const signal = () => new AbortController().signal;
const query = { name: '保存', role: 'button' };
const candidate = id => ({ backendDOMNodeId: id, role: { value: 'button' }, name: { value: '保存' },
  value: { value: 'private-value' }, properties: [{ name: 'url', value: { value: 'private-url' } }] });
test('semantic query validates literal names and optional roles without regex/selector extensions', () => {
  assert.deepEqual(semanticQuery({ name: 'A.*', role: 'button' }), { name: 'A.*', role: 'button' });
  for (const invalid of [{}, { name: '' }, { name: '  ' }, { name: 'a'.repeat(1001) }, { name: 'a', exact: false },
    { name: 'a', selector: '*' }, { name: 'a', role: 'button.*' }, { name: 'a', role: null }]) assert.throws(() => semanticQuery(invalid));
  assert.deepEqual(observeOptions({ query, rootRef: 'r', cursor: 'c' }), { query, rootRef: 'r', cursor: 'c' });
  assert.throws(() => axFindRequest({ frameId: 'f', query, expression: 'code' }));
  assert.throws(() => axFindRequest({ frameId: 'f', query, backendNodeId: 0 }));
});
test('source query uses exact browser filters and preserves every duplicate candidate without action', async () => {
  const calls = [];
  const result = await findAXNodes({ frameId: 'f', query }, async (method, params) => {
    calls.push({ method, params });
    return method === 'DOM.getDocument' ? { root: { backendNodeId: 10 } } : { nodes: [candidate(1), candidate(2), candidate(2), { ...candidate(3), ignored: true }] };
  }, signal());
  assert.deepEqual(calls, [
    { method: 'DOM.getDocument', params: { depth: 0, pierce: false } },
    { method: 'Accessibility.queryAXTree', params: { backendNodeId: 10, accessibleName: '保存', role: 'button' } },
  ]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.nodes.map(n => n.backendDOMNodeId), [1, 2]);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('source query honors the exact subtree, rejects mismatches and marks omitted foreign frames', async () => {
  const request = { frameId: 'f', backendNodeId: 40, query };
  const r = await findAXNodes(request, async (method, params) => {
    assert.equal(method, 'Accessibility.queryAXTree'); assert.equal(params.backendNodeId, 40);
    return { nodes: [candidate(1), { ...candidate(2), frameId: 'other' }] };
  }, signal());
  assert.equal(r.truncated, true); assert.equal(r.nodes.length, 1);
  for (const changed of [{ name: { value: '保存其它' } }, { role: { value: 'link' } }]) {
    await assert.rejects(findAXNodes(request, async () => ({ nodes: [{ ...candidate(1), ...changed }] }), signal()), e => e.code === 'STALE_TARGET');
  }
});

test('semantic query preserves bounded checked-state evidence but not arbitrary property values', async () => {
  const q = { name: '保存', role: 'checkbox' };
  const result = await findAXNodes({ frameId: 'f', backendNodeId: 40, query: q }, async () => ({ nodes: [{
    ...candidate(1), role: { value: 'checkbox' }, properties: [{ name:'checked',value:{value:'mixed'} },
      {name:'checked',value:{value:'arbitrary-secret'}}, {name:'url',value:{value:'private-url'}}],
  }] }), signal());
  assert.deepEqual(result.nodes[0].properties, [{name:'checked',value:{value:'mixed'}}]);
});
test('source query bounds duplicate-heavy output and shares cancellation without fallback', async () => {
  const r = await findAXNodes({ frameId: 'f', backendNodeId: 1, query }, async () => ({ nodes: Array.from({ length: 4000 }, (_, i) => candidate(i + 1)) }), signal());
  assert.equal(r.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 192 * 1024);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(findAXNodes({ frameId: 'f', query }, async () => { throw new Error('must not run'); }, controller.signal), e => e.code === 'CANCELLED');
  const error = new Error('Browser query failed'); let calls = 0;
  await assert.rejects(findAXNodes({ frameId: 'f', backendNodeId: 1, query }, async () => { calls++; throw error; }, signal()), e => e === error);
  assert.equal(calls, 1);
});
test('query scope equality binds literal name, role presence and optional contextual root', () => {
  const scope = observationScope({ kind: 'query', query, rootRef: 'one' });
  assert.ok(sameScope(scope, { kind: 'query', rootRef: 'one', query: { role: 'button', name: '保存' } }));
  for (const changed of [{ kind: 'document' }, { kind: 'subtree', rootRef: 'one' }, { ...scope, rootRef: 'two' },
    { ...scope, query: { name: '保存' } }, { ...scope, query: { name: '保存其它', role: 'button' } }]) assert.equal(sameScope(scope, changed), false);
  assert.throws(() => observationScope({ ...scope, selector: '*' }));
});
async function runtimeFixture(t) {
  let deny = false;
  const runtime = new BrowserRuntime(async () => !deny), provider = new FakeProvider();
  runtime.register(provider); t.after(() => runtime.dispose());
  const lease = await runtime.claim('owner', 'fake-1', 'tab-1', signal());
  return { runtime, provider, lease, deny: () => { deny = true; } };
}
test('runtime query is optional, authorized, scope-checked and isolated from ordinary observation cursors', async t => {
  const f = await runtimeFixture(t); let calls = 0;
  await assert.rejects(f.runtime.observe('owner', f.lease.id, signal(), { query }), e => e.code === 'UNSUPPORTED_CAPABILITY');
  f.provider.find = async (lease, q, s, rootRef) => {
    calls++; const o = await f.provider.observe(lease, s);
    return { ...o, scope: { kind: 'query', query: q, ...(rootRef ? { rootRef } : {}) },
      nodes: Array.from({ length: 20 }, (_, i) => ({ id: `found-${i}`, name: q.name, role: q.role ?? 'button' })) };
  };
  const doc = await f.runtime.observe('owner', f.lease.id, signal());
  const first = await f.runtime.observe('owner', f.lease.id, signal(), { query, cursor: doc.cursor });
  assert.equal(first.resyncReason, 'scope-changed');
  const update = await f.runtime.observe('owner', f.lease.id, signal(), { query, cursor: first.cursor });
  assert.equal(update.format, 'delta');
  assert.deepEqual(applyObservationUpdate(first, update).scope, { kind: 'query', query });
  assert.throws(() => applyObservationUpdate({ ...first, scope: { kind: 'query', query: { name: 'other' } } }, update));
  const scoped = await f.runtime.observe('owner', f.lease.id, signal(), { query, rootRef: 'context', cursor: update.cursor });
  assert.equal(scoped.resyncReason, 'scope-changed');
  const back = await f.runtime.observe('owner', f.lease.id, signal(), { cursor: scoped.cursor });
  assert.equal(back.resyncReason, 'scope-changed');
  f.deny(); const before = calls;
  await assert.rejects(f.runtime.observe('owner', f.lease.id, signal(), { query }), e => e.code === 'POLICY_DENIED');
  await assert.rejects(f.runtime.observe('other', f.lease.id, signal(), { query }), e => e.code === 'LEASE_REVOKED');
  assert.equal(calls, before);
});
test('runtime rejects a provider that widens query scope to an ordinary page read', async t => {
  const f = await runtimeFixture(t);
  f.provider.find = async (lease, _query, s) => f.provider.observe(lease, s);
  await assert.rejects(f.runtime.observe('owner', f.lease.id, signal(), { query }), e => e.code === 'INVALID_REQUEST');
});
