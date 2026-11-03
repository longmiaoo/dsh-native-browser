import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { BrowserError, checkAbort } from '../dist/packages/contracts/src/index.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

function fixture(t, authorize = async () => true) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const provider = new FakeProvider(); let renewals = 0;
  provider.renew = async (previous, next, signal) => {
    checkAbort(signal); assert.equal(provider.grants.get(previous.tab), previous.token);
    assert.equal(next.token, previous.token); renewals++;
  };
  const runtime = new BrowserRuntime(authorize, { leaseMs: 200 });
  runtime.register(provider); t.after(() => runtime.dispose());
  const signal = new AbortController().signal;
  return { runtime, provider, signal, count: () => renewals };
}
test('renewal keeps owner/token and cached references across the original deadline', async t => {
  const f = fixture(t), lease = await f.runtime.claim('owner', 'fake-1', 'tab-1', f.signal);
  const before = await f.runtime.observe('owner', lease.id, f.signal);
  t.mock.timers.tick(100);
  const next = await f.runtime.renew('owner', lease.id, f.signal);
  assert.deepEqual({ ...next, expiresAt: lease.expiresAt }, lease);
  assert.equal(next.expiresAt, lease.expiresAt + 100); assert.equal(f.count(), 1);
  t.mock.timers.tick(110);
  const after = await f.runtime.observe('owner', lease.id, f.signal, { cursor: before.cursor });
  assert.equal(after.resyncRequired, false); assert.equal(f.provider.calls.length, 0);
  t.mock.timers.tick(100);
  await assert.rejects(f.runtime.renew('owner', lease.id, f.signal), { code: 'LEASE_REVOKED' });
});
test('wrong owner, changed origin, denied policy and unsupported provider cannot extend authority', async t => {
  let allowed = true;
  const f = fixture(t, async () => allowed), lease = await f.runtime.claim('owner', 'fake-1', 'tab-1', f.signal);
  await assert.rejects(f.runtime.renew('intruder', lease.id, f.signal), { code: 'LEASE_REVOKED' });
  allowed = false; await assert.rejects(f.runtime.renew('owner', lease.id, f.signal), { code: 'POLICY_DENIED' });
  allowed = true; f.provider.tab.url = 'https://other.test/';
  await assert.rejects(f.runtime.renew('owner', lease.id, f.signal), { code: 'POLICY_DENIED' });
  f.provider.tab.url = 'https://example.test/form'; f.provider.instance.capabilities.leaseRenewal = false;
  await assert.rejects(f.runtime.renew('owner', lease.id, f.signal), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(f.count(), 0); assert.equal(f.provider.grants.size, 1);
});
test('Stop during a delayed renewal ACK removes authority before cleanup and rejects the late ACK', async t => {
  const f = fixture(t), lease = await f.runtime.claim('owner', 'fake-1', 'tab-1', f.signal);
  let finish, entered; const started = new Promise(resolve => { entered = resolve; });
  f.provider.renew = async () => { entered(); await new Promise(resolve => { finish = resolve; }); };
  const pending = f.runtime.renew('owner', lease.id, f.signal);
  const denied = assert.rejects(pending, { code: 'LEASE_REVOKED' }); await started;
  const releasing = f.runtime.release('owner', lease.id);
  assert.equal(f.runtime.resourceUsage().leases, 0);
  finish(); await denied; await releasing;
  assert.equal(f.provider.grants.size, 0);
  await assert.rejects(f.runtime.renew('owner', lease.id, f.signal), { code: 'LEASE_REVOKED' });
});
test('expiration or lost renewal ACK retires the fence without input replay or another grant', async t => {
  const f = fixture(t), lease = await f.runtime.claim('owner', 'fake-1', 'tab-1', f.signal);
  f.provider.renew = async () => { throw new BrowserError('CONNECTION_LOST', 'lost ACK'); };
  await assert.rejects(f.runtime.renew('owner', lease.id, f.signal), { code: 'CONNECTION_LOST' });
  assert.equal(f.runtime.resourceUsage().leases, 0); assert.equal(f.provider.calls.length, 0);
  const next = await f.runtime.claim('owner', 'fake-1', 'tab-1', f.signal);
  assert.notEqual(next.token, lease.token);
  t.mock.timers.tick(201);
  await assert.rejects(f.runtime.renew('owner', next.id, f.signal), { code: 'LEASE_REVOKED' });
});
