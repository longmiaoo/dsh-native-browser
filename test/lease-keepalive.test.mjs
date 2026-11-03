import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaseKeepAlive } from '../dist/packages/dsh-adapter/src/lease-keepalive.js';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(t, renew, idleMs = 1000) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const controller = new AbortController();
  const keeper = new LeaseKeepAlive(renew, controller.signal, idleMs);
  t.after(() => keeper.stop());
  return { keeper, controller, tick: async ms => { t.mock.timers.tick(ms); await flush(); } };
}
test('host maintenance spans multiple original deadlines without dispatching or claiming', async t => {
  const seen = [];
  const f = fixture(t, async id => { seen.push(id); return { expiresAt: Date.now() + 200 }; });
  f.keeper.track('one', Date.now() + 200);
  for (let i = 0; i < 5; i++) await f.tick(100);
  assert.deepEqual(seen, Array(5).fill('one'));
});
test('idle budget stops keepalive; a status-free touch does not resurrect retired leases', async t => {
  let count = 0;
  const f = fixture(t, async () => { count++; return { expiresAt: Date.now() + 200 }; }, 250);
  f.keeper.track('one', Date.now() + 200);
  await f.tick(100); await f.tick(100); await f.tick(50);
  assert.equal(count, 2);
  f.keeper.touch(); await f.tick(1000); assert.equal(count, 2);
});
test('new browser work extends idle budget but expiry, failure and disposal never retry', async t => {
  let count = 0;
  const f = fixture(t, async () => { count++; if (count === 3) throw new Error('lost ACK'); return { expiresAt: Date.now() + 200 }; }, 250);
  f.keeper.track('one', Date.now() + 200);
  await f.tick(100); await f.tick(100); f.keeper.touch(); await f.tick(50); await f.tick(50);
  assert.equal(count, 3); await f.tick(1000); assert.equal(count, 3);
  f.keeper.track('expired', Date.now() - 1); await f.tick(1000); assert.equal(count, 3);
  f.keeper.stop(); f.keeper.track('late', Date.now() + 200); await f.tick(1000); assert.equal(count, 3);
});
test('forget, abort and a late renewal ACK cannot schedule successor maintenance', async t => {
  let finish, pendingSignal, count = 0;
  const f = fixture(t, async (_id, signal) => { count++; pendingSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  f.keeper.track('one', Date.now() + 200); await f.tick(100);
  f.keeper.forget('one'); assert.equal(pendingSignal.aborted, true);
  finish({ expiresAt: Date.now() + 200 }); await flush(); await f.tick(1000); assert.equal(count, 1);
  f.keeper.track('two', Date.now() + 200); f.controller.abort(); await f.tick(1000); assert.equal(count, 1);
});
