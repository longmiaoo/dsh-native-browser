import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
const signal = () => new AbortController().signal;
const matches = code => error => error.code === code;
async function fixture(t, authorize = async () => true, limits) {
  const provider = new FakeProvider();
  const runtime = new BrowserRuntime(authorize, limits);
  runtime.register(provider);
  t.after(() => runtime.dispose());
  const lease = await runtime.claim('session-a', provider.instance.id, provider.tab.id, signal());
  const request = { requestId: 'request-1', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'fill', ref: 'node-1', text: 'Alice', expected: { kind: 'value', value: 'Alice' } } };
  return { runtime, provider, lease, request };
}

test('core accepts a non-Chromium provider and completes a verified action', async t => {
  const { runtime, request, provider } = await fixture(t);
  const result = await runtime.act('session-a', request, signal());
  assert.equal(runtime.instances()[0].family, 'other');
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.dispatch, 'observed');
  assert.equal(provider.nodes[0].value, 'Alice');
});

test('lease validation rechecks current owner/origin/policy without reading pixels or renewing authority', async t => {
  let allowed=true;const {runtime,provider,lease}=await fixture(t,async()=>allowed);
  let reads=0;provider.observe=provider.capture=async()=>{reads++;throw new Error('Authority validation must not read content');};
  assert.deepEqual(await runtime.validateLease('session-a',lease.id,signal()),{valid:true});
  assert.equal(reads,0);
  await assert.rejects(runtime.validateLease('other',lease.id,signal()),{code:'LEASE_REVOKED'});
  allowed=false;await assert.rejects(runtime.validateLease('session-a',lease.id,signal()),{code:'POLICY_DENIED'});
  allowed=true;provider.tab.url='https://elsewhere.test/';
  await assert.rejects(runtime.validateLease('session-a',lease.id,signal()),{code:'POLICY_DENIED'});
  await runtime.release('session-a',lease.id);
  await assert.rejects(runtime.validateLease('session-a',lease.id,signal()),{code:'LEASE_REVOKED'});
});

test('revocation during an asynchronous authority check cannot return valid', async t => {
  let pending,entered,hold=false;const started=new Promise(resolve=>{entered=resolve;});
  const {runtime,lease}=await fixture(t,async()=>{if(hold){entered();await new Promise(resolve=>{pending=resolve;});}return true;});
  hold=true;const checking=runtime.validateLease('session-a',lease.id,signal());
  await started;await runtime.release('session-a',lease.id);pending();
  await assert.rejects(checking,{code:'LEASE_REVOKED'});
});

test('lease events are immutable, metadata-only and emitted once before blocked provider cleanup', async t => {
  const {runtime,provider,lease}=await fixture(t);const events=[];
  runtime.onLeaseRevoked(()=>{throw new Error('Broken delivery');});
  const unsubscribe=runtime.onLeaseRevoked(event=>{assert.ok(Object.isFrozen(event));events.push(event);});
  let finish;provider.revoke=()=>new Promise(resolve=>{finish=resolve;});
  const releasing=runtime.release('session-a',lease.id);
  assert.deepEqual(events,[{owner:'session-a',scope:'session-a',leaseId:lease.id}]);
  await assert.rejects(runtime.validateLease('session-a',lease.id,signal()),{code:'LEASE_REVOKED'});
  await runtime.release('session-a',lease.id);assert.equal(events.length,1);
  finish();await releasing;unsubscribe();
});

test('lease listeners have bounded admission and disposal releases their slots', async t => {
  const {runtime}=await fixture(t);const removers=Array.from({length:128},()=>runtime.onLeaseRevoked(()=>{}));
  assert.throws(()=>runtime.onLeaseRevoked(()=>{}),{code:'QUEUE_FULL'});
  removers[0]();const remove=runtime.onLeaseRevoked(()=>{});remove();
  for(const dispose of removers)dispose();await runtime.dispose();
  assert.throws(()=>runtime.onLeaseRevoked(()=>{}),{code:'CONNECTION_LOST'});
});

test('simultaneous claims reserve the tab before the asynchronous grant', async t => {
  const runtime = new BrowserRuntime(async () => true);
  const provider = new FakeProvider();
  runtime.register(provider); t.after(() => runtime.dispose());
  const results = await Promise.allSettled(['a', 'b'].map(owner => runtime.claim(owner, 'fake-1', 'tab-1', signal())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'LEASE_BUSY');
});

test('another session cannot use or release the lease', async t => {
  const { runtime, request, lease } = await fixture(t);
  assert.throws(() => runtime.act('session-b', request, signal()), matches('LEASE_REVOKED'));
  await assert.rejects(runtime.release('session-b', lease.id), matches('LEASE_REVOKED'));
});

test('duplicate concurrent requests execute once and return immutable copies', async t => {
  const { runtime, request, provider } = await fixture(t);
  const [a, b] = await Promise.all([runtime.act('session-a', request, signal()), runtime.act('session-a', request, signal())]);
  assert.equal(provider.calls.length, 1);
  a.observation.nodes[0].name = 'tampered';
  assert.equal(b.observation.nodes[0].name, 'Name');
  assert.equal((await runtime.act('session-a', request, signal())).observation.nodes[0].name, 'Name');
});

test('same request ID cannot authorize a different payload', async t => {
  const { runtime, request } = await fixture(t);
  await runtime.act('session-a', request, signal());
  assert.throws(() => runtime.act('session-a', { ...request, action: { ...request.action, text: 'Bob' } }, signal()), matches('REQUEST_ID_CONFLICT'));
});

test('lost acknowledgement yields unknown and retry never repeats input', async t => {
  const { runtime, request, provider } = await fixture(t);
  provider.failAfterDispatch = true;
  const result = await runtime.act('session-a', request, signal());
  assert.equal(result.outcome, 'unknown'); assert.equal(result.dispatch, 'dispatched');
  await runtime.act('session-a', request, signal());
  assert.equal(provider.calls.length, 1);
});

test('postcondition absence is not reported as success', async t => {
  const { runtime, request, provider } = await fixture(t);
  provider.postcondition = 'unverified';
  assert.equal((await runtime.act('session-a', request, signal())).outcome, 'unknown');
});

test('policy denial happens before input and is retained in journal', async t => {
  const { runtime, request, provider } = await fixture(t, async r => r.operation !== 'act');
  const result = await runtime.act('session-a', request, signal());
  assert.equal(result.code, 'POLICY_DENIED'); assert.equal(result.dispatch, 'notDispatched');
  assert.equal(provider.calls.length, 0);
});

test('cross-origin navigation invalidates access, even with a live lease', async t => {
  const { runtime, provider, lease, request } = await fixture(t);
  provider.tab.url = 'https://unapproved.test/';
  await assert.rejects(runtime.observe('session-a', lease.id, signal()), matches('POLICY_DENIED'));
  assert.equal((await runtime.act('session-a', request, signal())).code, 'POLICY_DENIED');
  assert.equal(provider.calls.length, 0);
});

test('tab-scoped personal lease rebinds to the same allowed tab after an external cross-origin navigation', async t => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true, undefined, undefined, { leaseScope: 'tab' });
  runtime.register(provider); t.after(() => runtime.dispose());
  const lease = await runtime.claim('session-a', provider.instance.id, provider.tab.id, signal());
  assert.equal(lease.scope, 'tab');
  provider.tab.url = 'https://different.test/account'; provider.epoch = 'doc-2';
  const observation = await runtime.observe('session-a', lease.id, signal());
  assert.equal(observation.url, provider.tab.url);
  assert.deepEqual(await runtime.validateLease('session-a', lease.id, signal()), { valid: true });
});

test('tab-scoped navigation publishes and retains only the declared destination origin', async t => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true, undefined, undefined, { leaseScope: 'tab' });
  runtime.register(provider); t.after(() => runtime.dispose());
  const lease = await runtime.claim('session-a', provider.instance.id, provider.tab.id, signal());
  provider.act = async (current, request, execution) => {
    execution.onDispatch(); provider.tab.url = request.action.url; provider.epoch = 'doc-2';
    return { observation: await provider.observe({ ...current, origin: new URL(request.action.url).origin }, execution.signal), postcondition: 'passed' };
  };
  const result = await runtime.act('session-a', { requestId: 'personal-nav', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'navigate', url: 'https://different.test/path' } }, signal());
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.observation.url, provider.tab.url);
  assert.deepEqual(await runtime.validateLease('session-a', lease.id, signal()), { valid: true });
});

test('navigation replaces document refs but unrelated observation does not', async t => {
  const { runtime, provider, lease, request } = await fixture(t);
  await runtime.observe('session-a', lease.id, signal());
  assert.equal((await runtime.act('session-a', request, signal())).outcome, 'succeeded');
  provider.epoch = 'doc-2';
  const result = await runtime.act('session-a', { ...request, requestId: 'next' }, signal());
  assert.equal(result.code, 'STALE_TARGET'); assert.equal(provider.calls.length, 1);
});

test('release aborts running and queued actions before dispatch', async t => {
  const { runtime, provider, lease, request } = await fixture(t);
  provider.delay = 100;
  const a = runtime.act('session-a', request, signal());
  const b = runtime.act('session-a', { ...request, requestId: 'next' }, signal());
  await runtime.release('session-a', lease.id);
  assert.equal((await a).dispatch, 'notDispatched'); assert.equal((await b).dispatch, 'notDispatched');
  assert.equal(provider.calls.length, 0); assert.equal(provider.grants.size, 0);
});

test('deadline bounds execution and reports no input before dispatch', async t => {
  const { runtime, provider, request } = await fixture(t);
  provider.delay = 100;
  const result = await runtime.act('session-a', { ...request, timeoutMs: 10 }, signal());
  assert.equal(result.code, 'DEADLINE_EXCEEDED'); assert.equal(provider.calls.length, 0);
});

test('caller cannot mutate an action while queued', async t => {
  const { runtime, provider, request } = await fixture(t);
  provider.delay = 5;
  const result = runtime.act('session-a', request, signal());
  request.action.text = 'Tampered';
  await result;
  assert.equal(provider.calls[0].text, 'Alice');
});

test('journal and queue bounds fail closed without evicting requests', async t => {
  const { runtime, provider, request } = await fixture(t, async () => true,
    { leaseMs: 1000, queueSize: 1, journalSize: 2, actionMs: 1000 });
  provider.delay = 10;
  const first = runtime.act('session-a', request, signal());
  const second = await runtime.act('session-a', { ...request, requestId: 'second' }, signal());
  assert.equal(second.code, 'QUEUE_FULL');
  assert.throws(() => runtime.act('session-a', { ...request, requestId: 'third' }, signal()), matches('JOURNAL_FULL'));
  await first;
  await runtime.act('session-a', request, signal());
  assert.equal(provider.calls.length, 1);
});

test('disconnect revokes control; reconnect does not resurrect the lease', async t => {
  const { runtime, provider, request } = await fixture(t);
  await runtime.disconnect(provider.instance.id);
  runtime.register(provider);
  assert.throws(() => runtime.act('session-a', request, signal()), matches('LEASE_REVOKED'));
  assert.equal(provider.calls.length, 0);
});

test('runtime exposes action-result cursors and preserves authorization on delta reads', async t => {
  const { runtime, provider, lease, request } = await fixture(t);
  provider.nodes = Array.from({ length: 30 }, (_, i) => ({ id: `node-${i}`, role: 'textbox', name: `Input ${i}`, value: '' }));
  const result = await runtime.act('session-a', request, signal());
  assert.equal(result.observation.format, 'full'); assert.ok(result.observation.cursor);
  const delta = await runtime.observe('session-a', lease.id, signal(), { cursor: result.observation.cursor });
  assert.equal(delta.format, 'delta'); assert.deepEqual(delta.nodes.upsert, []);
  await assert.rejects(runtime.observe('session-b', lease.id, signal(), { cursor: delta.cursor }), matches('LEASE_REVOKED'));
  provider.tab.url = 'https://unapproved.test/';
  await assert.rejects(runtime.observe('session-a', lease.id, signal(), { cursor: delta.cursor }), matches('POLICY_DENIED'));
});

test('runtime rejects unsupported or misreported subtree reads without a full-page fallback', async t => {
  const { runtime, provider, lease } = await fixture(t);
  let fullReads = 0;
  const original = provider.observe.bind(provider);
  provider.observe = (...args) => { fullReads++; return original(...args); };
  await assert.rejects(runtime.observe('session-a', lease.id, signal(), { rootRef: 'region' }), matches('UNSUPPORTED_CAPABILITY'));
  assert.equal(fullReads, 0);
  provider.observeSubtree = (lease, _root, s) => original(lease, s); // Misbehaving provider returns a full page.
  await assert.rejects(runtime.observe('session-a', lease.id, signal(), { rootRef: 'region' }), matches('INVALID_REQUEST'));
  assert.equal(fullReads, 0);
});

test('scoped observation options are captured before queuing and retain owner/origin checks', async t => {
  const { runtime, provider, lease } = await fixture(t);
  let reads = 0;
  provider.observeSubtree = async (l, rootRef, s) => {
    reads++; return { ...await provider.observe(l, s), scope: { kind: 'subtree', rootRef } };
  };
  const options = { rootRef: 'region-a' }, pending = runtime.observe('session-a', lease.id, signal(), options);
  options.rootRef = 'region-b';
  assert.deepEqual((await pending).scope, { kind: 'subtree', rootRef: 'region-a' });
  await assert.rejects(runtime.observe('session-b', lease.id, signal(), options), matches('LEASE_REVOKED'));
  provider.tab.url = 'https://unapproved.test/';
  await assert.rejects(runtime.observe('session-a', lease.id, signal(), options), matches('POLICY_DENIED'));
  assert.equal(reads, 1);
});

test('invalid scoped roots and late subtree completions cannot enter the observation cache', async t => {
  const { runtime, provider, lease } = await fixture(t);
  for (const rootRef of ['', 'x'.repeat(129), null, 42]) {
    await assert.rejects(runtime.observe('session-a', lease.id, signal(), { rootRef }), matches('INVALID_REQUEST'));
  }
  let finish, started;
  const reading = new Promise(resolve => { started = resolve; });
  provider.observeSubtree = async (l, rootRef, s) => {
    const o = await provider.observe(l, s);
    await new Promise(resolve => { finish = resolve; started(); });
    return { ...o, scope: { kind: 'subtree', rootRef } };
  };
  const pending = runtime.observe('session-a', lease.id, signal(), { rootRef: 'region' });
  const rejected = assert.rejects(pending, matches('LEASE_REVOKED'));
  await reading;
  // Release invalidates even a provider that ignores abort.
  const releasing = runtime.release('session-a', lease.id);
  finish();
  await rejected;
  await releasing;
  assert.equal(runtime.observations.size, 0);
});
