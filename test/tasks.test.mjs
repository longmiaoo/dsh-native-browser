import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTasks } from '../dist/packages/dsh-adapter/src/tasks.js';
const signal = () => new AbortController().signal;
const lease = i => ({ tab: `tab-${i}`, instanceId: 'browser', leaseId: `lease-${i}` });
test('cleanup closes only owned live temporary pages, retaining deliverables and handoffs', async () => {
  const tasks = new BrowserTasks(), closed = [];
  for (let i = 0; i < 4; i++) tasks.opened('a', 'scope', lease(i));
  tasks.mark('a', 'scope', 'lease-1', 'deliverable'); tasks.mark('a', 'scope', 'lease-2', 'handoff');
  tasks.revoked('lease-3');
  const result = await tasks.finish('a', 'scope', async id => closed.push(id), signal());
  assert.deepEqual(closed, ['lease-0']); assert.equal(result.closed, 1); assert.equal(result.retained, 2); assert.equal(result.skipped, 1);
  assert.equal(result.status.phase, 'attention');
  assert.throws(() => tasks.mark('other', 'scope', 'lease-1', 'temporary'), { code: 'POLICY_DENIED' });
  assert.throws(() => tasks.mark('a', 'other-scope', 'lease-1', 'temporary'), { code: 'POLICY_DENIED' });
});
test('handoff and a new owner never auto-reclaim cleanup authority; an explicit fresh claim can rebind', async () => {
  const tasks = new BrowserTasks(); tasks.opened('a', 'old', lease(0)); tasks.interrupted('a');
  let closed = 0;
  const finish = scope => tasks.finish('a', scope, async () => closed++, signal());
  assert.equal((await finish('new')).skipped, 1); assert.equal(closed, 0);
  tasks.claimed('b', 'new', { tab: 'tab-0', leaseId: 'lease-new' });
  await tasks.finish('b', 'new', async () => closed++, signal()); assert.equal(closed, 0);
  tasks.claimed('a', 'new', { tab: 'tab-0', leaseId: 'lease-new' });
  assert.equal((await finish('new')).closed, 1); assert.equal(closed, 1);
  assert.equal((await finish('new')).closed, 0); assert.equal(closed, 1);
});
test('failed close is reported once and is never automatically replayed', async () => {
  const tasks = new BrowserTasks(); tasks.opened('a', 'scope', lease(0)); let attempts = 0;
  const finish = () => tasks.finish('a', 'scope', async () => { attempts++; throw Error('lost acknowledgement'); }, signal());
  assert.equal((await finish()).skipped, 1); await finish(); assert.equal(attempts, 1);
});
test('running actions block UI cleanup; cancellation leaves recoverable pages and clears finishing', async () => {
  const tasks = new BrowserTasks(); tasks.opened('a', 'scope', lease(0));
  const settle = tasks.begin('a', 'act');
  await assert.rejects(tasks.finish('a', 'scope', async () => assert.fail('must not close'), signal()), { code: 'LEASE_BUSY' });
  settle(); const control = new AbortController(); control.abort();
  await assert.rejects(tasks.finish('a', 'scope', async () => assert.fail('must not close'), control.signal));
  assert.equal(tasks.status('a').phase, 'attention');
  assert.equal((await tasks.finish('a', 'scope', async () => {}, signal())).closed, 1);
});
test('simultaneous finish shares one close, and status carries no page content or input', async () => {
  const tasks = new BrowserTasks(); tasks.opened('a', 'scope', lease(0)); let unblock, closes = 0;
  const close = () => { closes++; return new Promise(resolve => { unblock = resolve; }); };
  const first = tasks.finish('a', 'scope', close, signal()), second = tasks.finish('a', 'scope', close, signal());
  assert.throws(() => tasks.begin('a', 'act'), { code: 'LEASE_BUSY' }); unblock();
  assert.deepEqual(await first, await second); assert.equal(closes, 1);
  assert.doesNotMatch(JSON.stringify(tasks.status('a')), /scope|instanceId|https:|text|token/);
});
test('new work remains fenced until final release acknowledgement, even when no pages need closing', async () => {
  const tasks = new BrowserTasks(); let release;
  const finishing = tasks.finish('a', 'scope', async () => {}, signal(), 0,
    () => new Promise(resolve => { release = resolve; }));
  assert.throws(() => tasks.begin('a', 'open'), { code: 'LEASE_BUSY' });
  release(); await finishing;
  const settle = tasks.begin('a', 'open'); settle();
});
