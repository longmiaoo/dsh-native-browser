import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionResultCache } from '../dist/packages/runtime-core/src/action-results.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

const sample = (id = 'r', text = '秘密 😀') => ({ requestId: id, outcome: 'succeeded', dispatch: 'observed', postcondition: 'passed',
  observation: { text: [text] } });
const signal = () => new AbortController().signal;
async function fixture(t, limits = {}, durable) {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true, limits, durable);
  runtime.register(provider); t.after(() => runtime.dispose());
  const lease = await runtime.claim('owner', provider.instance.id, provider.tab.id, signal());
  const request = { requestId: 'first', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'private-page-text' } };
  return { runtime, provider, lease, request };
}

test('action cache bounds actual retained UTF-8 bytes and returns independent values', () => {
  const input = sample(), size = Buffer.byteLength(JSON.stringify(input));
  const cache = new ActionResultCache({ maxBytes: size * 2, maxResultBytes: size, maxEntries: 10 });
  assert.equal(cache.put('a', 'lease', input), true);
  assert.deepEqual(cache.usage(), { entries: 1, serializedBytes: size });
  input.observation.text[0] = 'mutated input';
  const read = cache.get('a'); assert.equal(read.observation.text[0], '秘密 😀');
  read.observation.text[0] = 'mutated result'; assert.equal(cache.get('a').observation.text[0], '秘密 😀');
  cache.put('b', 'lease', sample()); cache.put('c', 'lease', sample());
  assert.equal(cache.get('a'), undefined); assert.equal(cache.usage().serializedBytes, size * 2);
  assert.equal(cache.put('oversize', 'lease', sample('r', 'x'.repeat(size))), false);
  assert.equal(cache.usage().entries, 2);
});

test('action cache LRU does not extend TTL and lease revocation preserves other payloads', () => {
  let now = 100; const cache = new ActionResultCache({ maxEntries: 2, ttlMs: 10 }, () => now);
  cache.put('a', 'lease-a', sample()); cache.put('b', 'lease-b', sample());
  now = 105; assert.ok(cache.get('a')); cache.put('c', 'lease-c', sample());
  assert.equal(cache.get('b'), undefined);
  now = 110; assert.equal(cache.get('a'), undefined); assert.ok(cache.get('c'));
  cache.put('d', 'lease-d', sample()); cache.revokeLease('lease-c'); assert.equal(cache.get('c'), undefined);
  assert.ok(cache.get('d')); cache.clear(); assert.deepEqual(cache.usage(), { entries: 0, serializedBytes: 0 });
});

test('cache rejects invalid budgets and copies limits rather than trusting caller mutations', () => {
  for (const limits of [{ maxEntries: 0 }, { maxBytes: Infinity }, { ttlMs: -1 }, { maxEntries: 4097 }, { maxResultBytes: 1048577 }]) {
    assert.throws(() => new ActionResultCache(limits), { code: 'INVALID_REQUEST' });
  }
  const limits = { maxEntries: 1 }, cache = new ActionResultCache(limits); limits.maxEntries = 100;
  cache.put('a', 'l', sample()); cache.put('b', 'l', sample()); assert.equal(cache.usage().entries, 1);
});

test('payload eviction keeps identity/hash fences and requires fresh observation, never another input', async t => {
  const { runtime, provider, request } = await fixture(t, { resultEntries: 1, journalSize: 2 });
  const first = await runtime.act('owner', request, signal()); assert.ok(first.observation);
  await runtime.act('owner', { ...request, requestId: 'second' }, signal());
  const recovered = await runtime.act('owner', request, signal());
  assert.equal(recovered.code, 'RECOVERY_REQUIRED'); assert.equal(recovered.outcome, 'unknown');
  assert.equal(recovered.recovery.priorOutcome, 'succeeded'); assert.equal(recovered.observation, undefined);
  assert.equal(JSON.stringify(recovered).includes('private-page-text'), false);
  recovered.recovery.priorOutcome = 'failed';
  assert.equal((await runtime.act('owner', request, signal())).recovery.priorOutcome, 'succeeded');
  assert.equal(provider.calls.length, 2);
  assert.throws(() => runtime.act('owner', { ...request, action: { ...request.action, text: 'changed' } }, signal()), { code: 'REQUEST_ID_CONFLICT' });
  assert.throws(() => runtime.act('owner', { ...request, requestId: 'third' }, signal()), { code: 'JOURNAL_FULL' });
  assert.throws(() => runtime.act('other', request, signal()), { code: 'LEASE_REVOKED' });
  assert.equal(runtime.journalUsage().identities, 2); assert.equal(runtime.journalUsage().results.entries, 1);
  // Structural retention check: settled identity entries hold no fulfilled Promise/page object.
  for (const entry of runtime.journal.values()) {
    assert.deepEqual(Object.keys(entry).sort(), ['hash', 'recovery']);
    assert.equal(JSON.stringify(entry).includes('private-page-text'), false);
  }
});

test('uncacheable result is returned once but subsequent duplicates use metadata without replay', async t => {
  const { runtime, provider, request } = await fixture(t, { resultBytes: 1 });
  assert.equal((await runtime.act('owner', request, signal())).outcome, 'succeeded');
  assert.equal((await runtime.act('owner', request, signal())).code, 'RECOVERY_REQUIRED');
  assert.equal(provider.calls.length, 1); assert.equal(runtime.journalUsage().results.serializedBytes, 0);
});

test('expired result cache retains action fences without retaining full observations', async t => {
  const { runtime, provider, request } = await fixture(t, { resultMs: 5 });
  await runtime.act('owner', request, signal()); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await runtime.act('owner', request, signal())).code, 'RECOVERY_REQUIRED');
  assert.equal(provider.calls.length, 1); assert.equal(runtime.journalUsage().results.entries, 0);
});

test('concurrent duplicates still share one execution and immutable full results', async t => {
  const { runtime, provider, request } = await fixture(t, { resultBytes: 1 }); provider.delay = 10;
  const [a, b] = await Promise.all([runtime.act('owner', request, signal()), runtime.act('owner', request, signal())]);
  assert.ok(a.observation); assert.ok(b.observation); a.observation.nodes[0].name = 'mutation';
  assert.equal(b.observation.nodes[0].name, 'Name'); assert.equal(provider.calls.length, 1);
  assert.equal(runtime.journalUsage().pending, 0);
});

test('release purges cached page data and a pending cache read cannot return it after Stop', async t => {
  const { runtime, provider, request, lease } = await fixture(t);
  await runtime.act('owner', request, signal()); assert.equal(runtime.journalUsage().results.entries, 1);
  const duplicate = runtime.act('owner', request, signal());
  await runtime.release('owner', lease.id);
  const recovered = await duplicate;
  assert.equal(recovered.code, 'RECOVERY_REQUIRED'); assert.equal(recovered.observation, undefined);
  assert.equal(runtime.journalUsage().results.serializedBytes, 0); assert.equal(provider.calls.length, 1);
  assert.throws(() => runtime.act('owner', request, signal()), { code: 'LEASE_REVOKED' });
  await runtime.dispose(); assert.deepEqual(runtime.journalUsage(), { identities: 0, pending: 0, results: { entries: 0, serializedBytes: 0 } });
});

test('release during durable settlement prevents both initial and duplicate callers receiving page data', async t => {
  let entered, finish; const started = new Promise(resolve => { entered = resolve; });
  const durable = { lookup() {}, async reserve() { return true; }, async settle() { entered(); await new Promise(resolve => { finish = resolve; }); } };
  const { runtime, provider, request, lease } = await fixture(t, {}, durable);
  const first = runtime.act('owner', request, signal()), duplicate = runtime.act('owner', request, signal());
  await started; await runtime.release('owner', lease.id); finish();
  const results = await Promise.all([first, duplicate]); assert.deepEqual(results[0], results[1]);
  for (const result of results) {
    assert.equal(result.code, 'RECOVERY_REQUIRED'); assert.equal(result.observation, undefined);
    assert.equal(result.recovery.priorOutcome, 'succeeded');
  }
  assert.equal(runtime.journalUsage().results.entries, 0); assert.equal(provider.calls.length, 1);
});

test('rejected execution retains only its stable failure code, not a rejected Promise', async t => {
  const { runtime, provider, request } = await fixture(t); const invalid = { ...request, timeoutMs: -1 };
  await assert.rejects(runtime.act('owner', invalid, signal()), { code: 'INVALID_REQUEST' });
  assert.throws(() => runtime.act('owner', invalid, signal()), { code: 'INVALID_REQUEST' });
  assert.equal(provider.calls.length, 0); assert.equal(runtime.journalUsage().pending, 0);
  const entry = [...runtime.journal.values()][0]; assert.deepEqual(Object.keys(entry).sort(), ['failure', 'hash']);
});
