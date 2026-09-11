import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

const signal = () => new AbortController().signal;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tabs = provider => [{ ...provider.tab }, { ...provider.tab, id: 'tab-2' }];
function fixture(t, limits = {}, authorize = async () => true) {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(authorize, limits);
  runtime.register(provider); t.after(() => runtime.dispose());
  return { runtime, provider };
}

test('provider limits reject new instances without evicting active ones; settings are immutable', async t => {
  const limits = { providers: 1 }; const { runtime, provider } = fixture(t, limits);
  limits.providers = 20;
  const second = new FakeProvider(); second.instance = { ...second.instance, id: 'fake-2' };
  assert.throws(() => runtime.register(second), { code: 'QUEUE_FULL' });
  assert.equal(runtime.instances()[0].id, provider.instance.id);
  await runtime.disconnect(provider.instance.id); runtime.register(second);
  assert.deepEqual(runtime.resourceUsage(), { providers: 1, leases: 0, claims: 0 });
  for (const value of [0, -1, 1.5, NaN, Infinity, 65]) {
    assert.throws(() => new BrowserRuntime(async () => true, { providers: value }), { code: 'INVALID_REQUEST' });
  }
});

test('simultaneous different-tab claims reserve global lease capacity before yielding grant', async t => {
  const { runtime, provider } = fixture(t, { leases: 1 });
  provider.listTabs = async () => tabs(provider);
  const gate = deferred(), entered = deferred();
  const grant = provider.grant.bind(provider);
  provider.grant = async (...args) => { entered.resolve(); await gate.promise; return grant(...args); };
  const first = runtime.claim('a', 'fake-1', 'tab-1', signal()); await entered.promise;
  await assert.rejects(runtime.claim('b', 'fake-1', 'tab-2', signal()), { code: 'QUEUE_FULL' });
  assert.equal(provider.grants.size, 0); assert.equal(runtime.resourceUsage().leases, 1);
  gate.resolve(); const lease = await first;
  await runtime.release('a', lease.id);
  const next = await runtime.claim('b', 'fake-1', 'tab-2', signal()); assert.equal(next.tab, 'tab-2');
});

test('pending claim limit rejects before provider work; cancellation retains the slot until work settles', async t => {
  const { runtime, provider } = fixture(t, { claims: 1 });
  const gate = deferred(); let calls = 0;
  provider.listTabs = async () => { calls++; await gate.promise; return tabs(provider); };
  const first = runtime.claim('a', 'fake-1', 'tab-1', signal());
  const rejected = assert.rejects(first, { code: 'LEASE_REVOKED' });
  await runtime.releaseOwner('a');
  await assert.rejects(runtime.claim('b', 'fake-1', 'tab-2', signal()), { code: 'QUEUE_FULL' });
  assert.equal(calls, 1); assert.equal(runtime.resourceUsage().claims, 1);
  gate.resolve(); await rejected;
  assert.equal(provider.grants.size, 0); assert.equal(runtime.resourceUsage().claims, 0);
  await runtime.claim('b', 'fake-1', 'tab-2', signal());
});

test('owner release cancels pending authorization, but a later explicit claim remains possible', async t => {
  const gate = deferred(), entered = deferred(); let requests = 0;
  const { runtime, provider } = fixture(t, {}, async () => {
    if (++requests === 1) { entered.resolve(); await gate.promise; } return true;
  });
  const first = runtime.claim('same-owner', 'fake-1', 'tab-1', signal());
  const rejected = assert.rejects(first, { code: 'LEASE_REVOKED' }); await entered.promise;
  await runtime.releaseOwner('same-owner'); gate.resolve(); await rejected;
  assert.equal(provider.grants.size, 0);
  const next = await runtime.claim('same-owner', 'fake-1', 'tab-1', signal());
  assert.equal(provider.grants.get('tab-1'), next.token);
});

test('claim timeout has a typed deadline and cannot grant after a late provider read', async t => {
  const { runtime, provider } = fixture(t, { actionMs: 5 }); const gate = deferred();
  provider.listTabs = async () => { await gate.promise; return tabs(provider); };
  const first = runtime.claim('a', 'fake-1', 'tab-1', signal());
  const rejected = assert.rejects(first, { code: 'DEADLINE_EXCEEDED' });
  await new Promise(resolve => setTimeout(resolve, 20)); gate.resolve(); await rejected;
  assert.equal(provider.grants.size, 0); assert.equal(runtime.resourceUsage().claims, 0);
});

test('expired leases release capacity without retaining a historical owner index', async t => {
  const { runtime, provider } = fixture(t, { leases: 1, leaseMs: 10 });
  await runtime.claim('expired-owner', 'fake-1', 'tab-1', signal());
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(runtime.resourceUsage().leases, 0); assert.equal(provider.grants.size, 0);
  await runtime.claim('next-owner', 'fake-1', 'tab-1', signal());
});

test('connection scope release cancels its pending claims and leases without touching another scope', async t => {
  const { runtime, provider } = fixture(t);
  provider.listTabs = async () => tabs(provider);
  const first = await runtime.claim('a', 'fake-1', 'tab-1', signal(), 'connection-a');
  const second = await runtime.claim('b', 'fake-1', 'tab-2', signal(), 'connection-b');
  const gate = deferred(); provider.listTabs = async () => { await gate.promise; return tabs(provider); };
  const waiting = runtime.claim('c', 'fake-1', 'tab-1', signal(), 'connection-a');
  const rejected = assert.rejects(waiting, { code: 'LEASE_REVOKED' });
  await runtime.releaseScope('connection-a'); gate.resolve(); await rejected;
  assert.equal(provider.grants.has(first.tab), false);
  assert.equal(provider.grants.get(second.tab), second.token);
  assert.deepEqual(runtime.resourceUsage(), { providers: 1, leases: 1, claims: 0 });
});

test('disconnect and same-ID provider replacement cannot finish an old claim', async t => {
  const { runtime, provider } = fixture(t); const gate = deferred();
  provider.listTabs = async () => { await gate.promise; return tabs(provider); };
  const waiting = runtime.claim('a', 'fake-1', 'tab-1', signal());
  const rejected = assert.rejects(waiting, { code: 'LEASE_REVOKED' });
  await runtime.disconnect('fake-1'); const next = new FakeProvider(); runtime.register(next);
  const lease = await runtime.claim('new-owner', 'fake-1', 'tab-1', signal());
  gate.resolve(); await rejected;
  assert.equal(provider.grants.size, 0); assert.equal(next.grants.get('tab-1'), lease.token);
});

test('late non-cooperative grant is re-revoked after prior release, without clearing a newer token', async t => {
  const { runtime, provider } = fixture(t); const gate = deferred(), entered = deferred();
  let calls = 0, lateLease;
  provider.grant = async lease => {
    if (++calls === 1) { lateLease = lease; entered.resolve(); await gate.promise; }
    // A fenced provider never overwrites a successor, but its late first grant still resolves.
    if (!provider.grants.has(lease.tab)) provider.grants.set(lease.tab, lease.token);
  };
  const first = runtime.claim('a', 'fake-1', 'tab-1', signal());
  const rejected = assert.rejects(first, { code: 'LEASE_REVOKED' }); await entered.promise;
  await runtime.releaseOwner('a');
  const next = await runtime.claim('b', 'fake-1', 'tab-1', signal()); gate.resolve(); await rejected;
  assert.notEqual(lateLease.token, next.token); assert.equal(provider.grants.get('tab-1'), next.token);
  assert.equal(runtime.resourceUsage().claims, 0);
});

test('late grant after dispose cannot leave remote control behind', async t => {
  const { runtime, provider } = fixture(t); const gate = deferred(), entered = deferred();
  provider.grant = async lease => { entered.resolve(); await gate.promise; provider.grants.set(lease.tab, lease.token); };
  const first = runtime.claim('a', 'fake-1', 'tab-1', signal());
  const rejected = assert.rejects(first, { code: 'LEASE_REVOKED' }); await entered.promise;
  await runtime.dispose(); gate.resolve(); await rejected;
  assert.equal(provider.grants.size, 0);
  assert.deepEqual(runtime.resourceUsage(), { providers: 0, leases: 0, claims: 0 });
});

test('provider Stop only releases its own live lease, and churn retains no historical control index', async t => {
  const { runtime, provider } = fixture(t);
  for (let i = 0; i < 100; i++) {
    const lease = await runtime.claim(`owner-${i}`, 'fake-1', 'tab-1', signal(), `scope-${i}`);
    await runtime.providerRevoked('different-provider', lease.id);
    assert.equal(provider.grants.get('tab-1'), lease.token);
    await runtime.providerRevoked('fake-1', lease.id);
    await runtime.providerRevoked('fake-1', lease.id);
    assert.deepEqual(runtime.resourceUsage(), { providers: 1, leases: 0, claims: 0 });
  }
});
