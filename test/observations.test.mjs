import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationCache } from '../dist/packages/runtime-core/src/observations.js';
import { applyObservationUpdate } from 'dsh-native-browser/observations';

const observation = () => ({ tab: 'tab-a', url: 'https://example.test/form', title: 'Fixture', documentEpoch: 'document-a', revision: 1,
  nodes: Array.from({ length: 40 }, (_, i) => ({ id: `node-${i}`, role: 'button', name: `Fixture action ${i}`, disabled: false })),
  text: Array.from({ length: 40 }, (_, i) => `Visible paragraph ${i}: this is deterministic fixture text.`), truncated: false, scope: { kind: 'document' } });
const content = full => { const { format, cursor, resyncRequired, resyncReason, ...value } = full; return value; };

test('cache limits reject missing or unsafe fields and cannot change after construction', () => {
  const limits = { maxEntries: 2, maxBytes: 18000, maxSnapshotBytes: 9000, ttlMs: 100 };
  for (const invalid of [{}, { ...limits, maxEntries: 0 }, { ...limits, maxBytes: NaN },
    { ...limits, maxSnapshotBytes: 20000 }, { ...limits, ttlMs: Infinity }]) {
    assert.throws(() => new ObservationCache(invalid), e => e.code === 'INVALID_REQUEST');
  }
  const cache = new ObservationCache(limits); limits.maxEntries = 100;
  for (let i = 0; i < 3; i++) cache.publish('owner', 'lease', observation());
  assert.equal(cache.size, 2);
});

test('unchanged page returns a compact delta, not another complete snapshot', () => {
  const cache = new ObservationCache(), a = cache.publish('owner', 'lease', observation());
  const b = cache.publish('owner', 'lease', { ...observation(), revision: 2 }, a.cursor);
  assert.equal(a.format, 'full'); assert.equal(a.resyncRequired, false);
  assert.equal(b.format, 'delta'); assert.equal(b.baseCursor, a.cursor);
  assert.deepEqual(b.nodes, { upsert: [], remove: [] }); assert.equal(b.text, undefined);
  assert.ok(JSON.stringify(b).length < JSON.stringify(a).length * 0.15);
  assert.equal(applyObservationUpdate(a, b).revision, 2);
});

test('node additions, updates, removals, ordering and text splice reconstruct the exact current view', () => {
  const cache = new ObservationCache(), before = observation();
  const a = cache.publish('owner', 'lease', before);
  const after = structuredClone(before); after.revision++;
  after.nodes[3].disabled = true; after.nodes.splice(5, 1); after.nodes.unshift({ id: 'added', role: 'link', name: 'New link' });
  after.text.splice(12, 2, 'Changed visible text');
  const b = cache.publish('owner', 'lease', after, a.cursor);
  assert.equal(b.format, 'delta'); assert.deepEqual(b.nodes.remove, ['node-5']);
  assert.deepEqual(b.nodes.upsert.map(n => n.id), ['added', 'node-3']);
  assert.deepEqual(b.text, { start: 12, deleteCount: 2, insert: ['Changed visible text'] });
  assert.deepEqual(content(applyObservationUpdate(a, b)), after);
});

test('two consumers advance independently from their own exact cursors', () => {
  const cache = new ObservationCache(), state = observation();
  const a = cache.publish('owner', 'lease', state), b = cache.publish('owner', 'lease', state);
  state.text[1] = 'first change'; state.revision++;
  const a2 = cache.publish('owner', 'lease', state, a.cursor);
  state.nodes[0].disabled = true; state.revision++;
  const b2 = cache.publish('owner', 'lease', state, b.cursor);
  const a3 = cache.publish('owner', 'lease', state, a2.cursor);
  assert.equal(b2.text.insert[0], 'first change'); assert.equal(a3.text, undefined);
  assert.deepEqual(content(applyObservationUpdate(b, b2)), state);
  assert.deepEqual(content(applyObservationUpdate(applyObservationUpdate(a, a2), a3)), state);
});

test('foreign owner, foreign lease and guessed cursor all return only a fresh authorized full snapshot', () => {
  const cache = new ObservationCache(), privateState = observation(); privateState.title = 'other task secret';
  const privateSnapshot = cache.publish('private-owner', 'private-lease', privateState);
  for (const [owner, lease, cursor] of [['public-owner', 'private-lease', privateSnapshot.cursor],
    ['private-owner', 'other-lease', privateSnapshot.cursor], ['private-owner', 'private-lease', 'unknown']]) {
    const result = cache.publish(owner, lease, observation(), cursor);
    assert.equal(result.format, 'full'); assert.equal(result.resyncRequired, true);
    assert.equal(result.resyncReason, 'cursor-unavailable'); assert.equal(JSON.stringify(result).includes('other task secret'), false);
  }
});

test('a document replacement resyncs all references rather than constructing a cross-document delta', () => {
  const cache = new ObservationCache(), a = cache.publish('owner', 'lease', observation());
  const changed = { ...observation(), documentEpoch: 'new-document', revision: 1 };
  const result = cache.publish('owner', 'lease', changed, a.cursor);
  assert.equal(result.format, 'full'); assert.equal(result.resyncReason, 'document-changed');
  assert.deepEqual(content(applyObservationUpdate(a, result)), changed);
});

test('document and independent subtree cursors never cross observation scopes', () => {
  const cache = new ObservationCache(), a = cache.publish('owner', 'lease', observation());
  const region = { ...observation(), scope: { kind: 'subtree', rootRef: 'region-a' } };
  const b = cache.publish('owner', 'lease', region, a.cursor);
  assert.equal(b.format, 'full'); assert.equal(b.resyncReason, 'scope-changed');
  const d = cache.publish('owner', 'lease', { ...region, revision: 2 }, b.cursor);
  assert.equal(d.format, 'delta'); assert.deepEqual(d.scope, region.scope);
  assert.deepEqual(content(applyObservationUpdate(b, d)), { ...region, revision: 2 });
  assert.throws(() => applyObservationUpdate({ ...b, scope: { kind: 'subtree', rootRef: 'region-b' } }, d), e => e.code === 'STALE_TARGET');
  const c = cache.publish('owner', 'lease', { ...region, scope: { kind: 'subtree', rootRef: 'region-b' } }, b.cursor);
  assert.equal(c.resyncReason, 'scope-changed');
  assert.equal(cache.publish('owner', 'lease', observation(), d.cursor).resyncReason, 'scope-changed');
  assert.throws(() => cache.publish('owner', 'lease', { ...observation(), scope: { kind: 'subtree' } }), e => e.code === 'INVALID_REQUEST');
});

test('truncation changes are explicit and removed entries describe the bounded view, not DOM deletion', () => {
  const cache = new ObservationCache(), a = cache.publish('owner', 'lease', observation());
  const next = observation(); next.truncated = true; next.nodes.pop();
  const result = cache.publish('owner', 'lease', next, a.cursor);
  assert.equal(result.truncated, true); assert.deepEqual(result.nodes.remove, ['node-39']);
  assert.deepEqual(content(applyObservationUpdate(a, result)), next);
});

test('large changes use full snapshots when a delta is not meaningfully smaller', () => {
  const cache = new ObservationCache(), a = cache.publish('owner', 'lease', observation());
  const next = observation(); next.nodes = next.nodes.map(n => ({ ...n, id: `replacement-${n.id}`, name: 'Completely replaced content' }));
  next.text = next.text.map(t => `Replacement: ${t}`);
  const result = cache.publish('owner', 'lease', next, a.cursor);
  assert.equal(result.format, 'full'); assert.equal(result.resyncRequired, false);
  assert.deepEqual(content(result), next);
});

test('caller mutations cannot poison a baseline or returned delta', () => {
  const cache = new ObservationCache(), state = observation();
  const a = cache.publish('owner', 'lease', state); state.nodes[0].name = 'real new name'; a.text[0] = 'tampered';
  const delta = cache.publish('owner', 'lease', state, a.cursor); assert.equal(delta.text, undefined);
  delta.nodes.upsert[0].name = 'tampered again';
  const next = cache.publish('owner', 'lease', state, delta.cursor);
  assert.deepEqual(next.nodes.upsert, []);
});

test('entry/byte limits, expiry and release evict snapshots with an explicit resync', () => {
  let now = 0;
  const cache = new ObservationCache({ maxEntries: 2, maxBytes: 18000, maxSnapshotBytes: 9000, ttlMs: 100 }, () => now);
  const a = cache.publish('owner', 'lease-a', observation()); cache.publish('owner', 'lease-b', observation()); cache.publish('owner', 'lease-b', observation());
  assert.equal(cache.size, 2); assert.ok(cache.serializedBytes <= 18000);
  assert.equal(cache.publish('owner', 'lease-a', observation(), a.cursor).resyncReason, 'cursor-unavailable');
  cache.revokeLease('lease-a'); assert.equal(cache.size, 1);
  now = 100; assert.equal(cache.size, 0); assert.equal(cache.serializedBytes, 0);
  cache.publish('owner', 'lease-a', observation()); cache.clear(); assert.equal(cache.serializedBytes, 0);
});

test('oversized snapshots and duplicate node IDs fail before cache admission', () => {
  const cache = new ObservationCache();
  const huge = observation(); huge.text = ['x'.repeat(100000)];
  assert.throws(() => cache.publish('owner', 'lease', huge), e => e.code === 'QUEUE_FULL');
  const duplicate = observation(); duplicate.nodes.push(duplicate.nodes[0]);
  assert.throws(() => cache.publish('owner', 'lease', duplicate), e => e.code === 'INVALID_REQUEST');
  assert.equal(cache.size, 0); assert.equal(cache.serializedBytes, 0);
});

test('reducer rejects the wrong base, malformed ordering and invalid text splice', () => {
  const cache = new ObservationCache(), a = cache.publish('owner', 'lease', observation());
  const d = cache.publish('owner', 'lease', observation(), a.cursor);
  assert.throws(() => applyObservationUpdate(undefined, d), e => e.code === 'STALE_TARGET');
  assert.throws(() => applyObservationUpdate({ ...a, cursor: 'different' }, d), e => e.code === 'STALE_TARGET');
  assert.throws(() => applyObservationUpdate(a, { ...d, nodes: { upsert: [], remove: [], order: ['node-1'] } }), e => e.code === 'INVALID_REQUEST');
  assert.throws(() => applyObservationUpdate(a, { ...d, text: { start: 1000, deleteCount: 1, insert: [] } }), e => e.code === 'INVALID_REQUEST');
});

test('300 deterministic mixed mutations round-trip exactly through full/delta responses', () => {
  const cache = new ObservationCache(); let state = observation(), base = cache.publish('owner', 'lease', state), serial = 0;
  for (let step = 0; step < 300; step++) {
    state = structuredClone(state); state.revision++;
    switch (step % 7) {
      case 0: state.text.splice(step % (state.text.length + 1), 0, `insert ${step}`); break;
      case 1: state.nodes[0].disabled = !state.nodes[0].disabled; break;
      case 2: state.nodes.reverse(); break;
      case 3: state.nodes.splice(3, 1, { id: `new-${++serial}`, role: 'button', name: `new button ${serial}` }); break;
      case 4: state.text.splice(step % state.text.length, 1); break;
      case 5: state.title = `Title ${step}`; break;
      case 6: state.truncated = !state.truncated; break;
    }
    const update = cache.publish('owner', 'lease', state, base.cursor);
    base = applyObservationUpdate(base, update);
    assert.deepEqual(content(base), state, `mutation ${step}`);
    assert.ok(cache.size <= 128); assert.ok(cache.serializedBytes <= 8 * 1024 * 1024);
  }
});
