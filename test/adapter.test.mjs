import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { setImmediate as ioTurn } from 'node:timers/promises';

async function untilIo(check) {
  for (let n = 0; n < 1000; n++) { if (check()) return; await ioTurn(); }
  assert.fail('Socket work did not settle');
}

async function fixture(t, config = {}, brokerOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-adapter-'));
  const broker = await startBroker({ directory, allowedOrigins: brokerOptions.accessMode === 'personal' ? [] : ['https://example.test'], ...brokerOptions });
  const provider = new FakeProvider(); broker.runtime.register(provider);
  const definitions = new Map(), hooks = new Map(), effects = [], services = new Map();
  let foregroundHandler;
  services.set('connection', { rpc: { handle: (channel, handler, options) => {
    assert.equal(channel, '/dsh-native-browser');
    assert.deepEqual(options, { authority: 'trusted-host' });
    foregroundHandler = handler;
    return async () => { foregroundHandler = undefined; };
  } } });
  const ctx = { tools: { register: tool => definitions.set(tool.name, tool) },
    on: (event, handler) => hooks.set(event, handler), effect: callback => effects.push(callback()), get: name => services.get(name) };
  // Existing approval-boundary cases deliberately exercise explicit per-action mode.
  apply(ctx, { approvalMode: 'per-action', runtimeDirectory: directory, ...config });
  t.after(async () => { for (const dispose of effects) await dispose(); await broker.close(); await rm(directory, { recursive: true }); });
  let count = 0;
  const prepare = (name, args, sessionId = 'session') => {
    const exec = { name, callId: `call-${++count}`, signal: AbortSignal.timeout(3000), agent: { session: { id: sessionId } } };
    const decision = hooks.get('tools/pre-execute')(exec, () => ({ kind: 'allow' }));
    return { exec, decision, run: () => definitions.get(name).execute(args, exec) };
  };
  return { provider, broker, prepare, definitions, services, preExecute: hooks.get('tools/pre-execute'),
    rpc: (endpoint, payload) => foregroundHandler(endpoint, payload, AbortSignal.timeout(3000)),
    foreground: (payload, signal = AbortSignal.timeout(3000)) => foregroundHandler('foreground', payload, signal),
    end: (id = 'session', kind) => hooks.get('session/event')({ id }, { type: 'turn/end', ...(kind ? { data: { reason: { kind } } } : {}) }),
    disposeSession: id => hooks.get('session/disposed')({ id }),
    dispose: () => { for (const dispose of effects) dispose(); } };
}
const claimArgs = { instanceId: 'fake-1', tab: 'tab-1' };
test('personal mode maintains a live lease past its original deadline and foreground switching stops maintenance', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  let count = 0;
  f.provider.renew = async (_previous, _next, signal) => { assert.equal(signal.aborted, false); count++; };
  const lease = await f.prepare('native_browser_claim', claimArgs, 'chat-a').run();
  t.mock.timers.tick(150_000); await untilIo(() => count === 1);
  // Waiting for an ordinary read also fences the completed renewal ACK.
  await f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run();
  t.mock.timers.tick(150_001);
  await f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run();
  assert.ok(Date.now() > lease.expiresAt); assert.ok(count >= 2);
  await f.foreground({ clientId: '11111111-1111-4111-8111-111111111111', revision: 1, issuedAt: Date.now(), sessionId: 'chat-b' });
  await untilIo(() => f.provider.grants.size === 0);
  const stopped = count; t.mock.timers.tick(150_000);
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run(), { code: 'LEASE_REVOKED' });
  assert.equal(count, stopped); assert.equal(f.provider.calls.length, 0);
});

for (const boundary of ['handoff', 'release_all', 'completed', 'unknown-end', 'stop', 'dispose']) {
  test(`personal keepalive stops at ${boundary} without another claim`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
    let count = 0; f.provider.renew = async () => { count++; };
    const lease = await f.prepare('native_browser_claim', claimArgs).run();
    if (boundary === 'handoff') await f.prepare('native_browser_handoff', { leaseId: lease.id }).run();
    else if (boundary === 'release_all') await f.prepare('native_browser_release_all', {}).run();
    else if (boundary === 'completed') await f.end('session', 'completed');
    else if (boundary === 'unknown-end') f.end();
    else if (boundary === 'stop') await f.broker.runtime.providerRevoked('fake-1', lease.id);
    else f.disposeSession('session');
    if (!['unknown-end', 'dispose'].includes(boundary)) await f.prepare('native_browser_list', {}).run();
    t.mock.timers.tick(150_000);
    await f.prepare('native_browser_list', {}).run();
    assert.equal(count, 0);
  });
}
test('restricted approval modes keep their original fixed lease expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await fixture(t); let count = 0; f.provider.renew = async () => { count++; };
  const lease = await f.prepare('native_browser_claim', claimArgs).run();
  t.mock.timers.tick(300_001);
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: lease.id }).run(), { code: 'LEASE_REVOKED' });
  assert.equal(count, 0);
});
test('task status preserves an unverified action receipt across reads without replaying input', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  const lease = await f.prepare('native_browser_claim', claimArgs).run();
  f.provider.failAfterDispatch = true;
  const result = await f.prepare('native_browser_act', { leaseId: lease.id, requestId: 'uncertain-status',
    documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'private-input-must-not-enter-status' } }).run();
  assert.equal(result.outcome, 'unknown'); assert.equal(f.provider.calls.length, 1);
  const status = () => f.prepare('native_browser_task', { action: 'status' }).run();
  let task = await status();
  assert.equal(task.phase, 'attention'); assert.equal(task.attention, 'verify-result');
  assert.deepEqual(task.lastResult, { outcome: result.outcome, dispatch: result.dispatch, postcondition: result.postcondition });
  assert.doesNotMatch(JSON.stringify(task), /private-input|example.test|Fixture/);
  await f.prepare('native_browser_observe', { leaseId: lease.id }).run();
  task = await status(); assert.equal(task.phase, 'attention'); assert.equal(task.attention, 'verify-result');
  assert.equal(f.provider.calls.length, 1);
  f.provider.failAfterDispatch = false;
  const verified = await f.prepare('native_browser_act', { leaseId: lease.id, requestId: 'verified-status',
    documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'verified' } }).run();
  assert.equal(verified.outcome, 'succeeded');
  task = await status(); assert.equal(task.phase, 'ready'); assert.equal(task.attention, undefined);
});
test('task status distinguishes failed postconditions from stale-target recovery', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  const lease = await f.prepare('native_browser_claim', claimArgs).run();
  f.provider.postcondition = 'failed';
  const result = await f.prepare('native_browser_act', { leaseId: lease.id, requestId: 'failed-condition',
    documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'bounded' } }).run();
  assert.equal(result.postcondition, 'failed');
  let task = await f.prepare('native_browser_task', { action: 'status' }).run();
  assert.equal(task.attention, 'verify-result'); assert.equal(task.lastResult.postcondition, 'failed');
  f.provider.observe = async () => { throw new BrowserError('STALE_TARGET', 'private-stale-details'); };
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: lease.id }).run(), { code: 'STALE_TARGET' });
  task = await f.prepare('native_browser_task', { action: 'status' }).run();
  assert.equal(task.attention, 'refresh-target'); assert.equal(task.error, 'STALE_TARGET');
  assert.equal(f.provider.calls.length, 1);
});
test('an undispatched stale action requests fresh targets rather than business-result verification', async t => {
  const f = await fixture(t), lease = await f.prepare('native_browser_claim', claimArgs).run();
  const result = await f.prepare('native_browser_act', { leaseId: lease.id, requestId: 'stale-no-input',
    documentEpoch: 'old-document', action: { kind: 'fill', ref: 'node-1', text: 'must-not-type' } }).run();
  assert.equal(result.dispatch, 'notDispatched'); assert.equal(result.code, 'STALE_TARGET');
  const task = await f.prepare('native_browser_task', { action: 'status' }).run();
  assert.equal(task.attention, 'refresh-target'); assert.equal(f.provider.calls.length, 0);
});
test('actual client foreground projection unlocks the same visible conversation through authenticated host bridge', async t => {
  const f = await fixture(t); let definition;
  await f.foreground({clientId:'11111111-1111-4111-8111-111111111111',revision:1,issuedAt:Date.now(),sessionId:null});
  const selected = 'visible-chat'; let synchronized;
  const synchronizedPromise = new Promise(resolve => { synchronized = resolve; });
  const window = {__ModuleLoader__:{load:value=>{definition=value;}},addEventListener(){},removeEventListener(){}};
  const document = {visibilityState:'visible',hasFocus:()=>true,addEventListener(){},removeEventListener(){}};
  vm.runInNewContext(await readFile(new URL('../client.js',import.meta.url),'utf8'),
    {window,document,crypto:webcrypto,AbortController,AbortSignal,Date,Promise,Object,Number,Symbol});
  const disposers=[];
  definition.factory().apply({
    sessions:{list:{getSnapshot:()=>({phase:'ready',byId:{[selected]:{id:selected,retainedBy:{mainView:1}}}}),subscribe:()=>()=>{}}},
    connection:{rpc:{call:async(_channel,endpoint,payload)=>{
      assert.equal(endpoint,'dsh-native-browser/foreground'); assert.equal(payload.sessionId,selected);
      const result=await f.foreground(payload);synchronized();return result;
    }}},on:()=>()=>{},effect:callback=>disposers.push(callback()),
  });
  await synchronizedPromise;
  const listed=f.prepare('native_browser_list',{},selected);
  assert.notEqual(listed.decision.kind,'deny'); assert.equal((await listed.run())[0].id,'fake-1');
  for(const dispose of disposers)dispose();
});
test('explicit no-selection denial is not a busy lease; selecting the active chat restores listing', async t => {
  const f = await fixture(t), clientId = '11111111-1111-4111-8111-111111111111';
  await f.foreground({clientId,revision:1,issuedAt:Date.now(),sessionId:null});
  const blocked = f.prepare('native_browser_list', {}, 'chat-a');
  assert.equal(blocked.decision.kind, 'deny'); assert.match(blocked.decision.reason, /NOT a busy tab lease/);
  assert.equal(f.provider.grants.size,0);
  await f.foreground({clientId,revision:2,issuedAt:Date.now(),sessionId:'chat-a'});
  const restored = f.prepare('native_browser_list', {}, 'chat-a'); assert.notEqual(restored.decision.kind,'deny');
  assert.equal((await restored.run())[0].id,'fake-1');
});
test('completed personal turn closes temporary task pages, preserves marked and user pages, and releases control', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  const run = (name, args) => f.prepare(`native_browser_${name}`, args).run();
  const user = await run('claim', claimArgs);
  const temp = await run('open', { instanceId: 'fake-1', url: 'https://example.test/search' });
  const result = await run('open', { instanceId: 'fake-1', url: 'https://example.test/result' });
  const waiting = await run('open', { instanceId: 'fake-1', url: 'https://example.test/login' });
  await run('task', { action: 'mark', leaseId: result.id, purpose: 'deliverable' });
  await run('task', { action: 'mark', leaseId: waiting.id, purpose: 'handoff' });
  await assert.rejects(run('task', { action: 'mark', leaseId: user.id, purpose: 'temporary' }), { code: 'POLICY_DENIED' });
  await f.end('session', 'completed');
  assert.equal(f.provider.opened.some(p => p.id === temp.tab), false);
  assert.equal(f.provider.opened.length, 2); assert.equal(f.provider.grants.size, 0);
  assert.equal((await run('task', { action: 'status' })).phase, 'completed');
  await f.end('session', 'completed'); assert.equal(f.provider.opened.length, 2);
});
test('interrupted, unknown and background endings never close task pages; UI rejects other conversation cleanup', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  await f.prepare('native_browser_open', { instanceId: 'fake-1', url: 'https://example.test/' }, 'a').run();
  await f.end('a', 'interrupted'); await f.end('a'); assert.equal(f.provider.opened.length, 1);
  await f.foreground({ clientId: '11111111-1111-4111-8111-111111111111', revision: 1, issuedAt: Date.now(), sessionId: 'b' });
  await f.end('a', 'completed'); assert.equal(f.provider.opened.length, 1);
  await assert.rejects(f.rpc('task.finish', { sessionId: 'a' }), { code: 'POLICY_DENIED' });
  assert.equal((await f.rpc('task.status', { sessionId: 'a' })).value.phase, 'handed-off');
  await assert.rejects(f.rpc('task.stop', { sessionId: 'a', extra: true }), { code: 'INVALID_REQUEST' });
});
test('Stop and expired authority are skipped, never silently reclaimed for cleanup', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  const lease = await f.prepare('native_browser_open', { instanceId: 'fake-1', url: 'https://example.test/' }).run();
  await f.broker.runtime.providerRevoked('fake-1', lease.id);
  await until(() => f.provider.grants.size === 0);
  const result = await f.prepare('native_browser_task', { action: 'finish' }).run();
  assert.equal(result.closed, 0); assert.equal(result.skipped, 1); assert.equal(f.provider.opened.length, 1);
});
test('setup uses the authenticated Host RPC channel and registers no model installation tool', async t => {
  const f = await fixture(t);
  assert.equal([...f.definitions.keys()].some(name => /setup|install/.test(name)), false);
  const status = await f.rpc('setup.status', {});
  assert.equal(status.ok, true);
  assert.equal(status.value.report.connection.connected, true);
  assert.equal((await f.rpc('setup.install', {})).error.code, 'gateway/bad-request');
  assert.equal((await f.rpc('setup.status', { directory: '/other' })).ok, false);
});
test('optional legacy aliases retain approval ownership without replacing canonical names', async t => {
  const f = await fixture(t, { legacyToolNames: true });
  assert.ok(f.definitions.has('native_browser_claim'));
  assert.ok(f.definitions.has('browser_claim'));
  const claim = f.prepare('browser_claim', claimArgs);
  assert.equal(claim.decision.kind, 'ask');
  const lease = await claim.run();
  assert.equal((await f.prepare('browser_observe', { leaseId: lease.id }).run()).tab, 'tab-1');
});
test('claim exposes one explicit public lease ID and hides internal capabilities', async t => {
  const f = await fixture(t), lease = await f.prepare('native_browser_claim', claimArgs).run();
  assert.equal(lease.leaseId, lease.id);
  assert.equal(typeof lease.leaseId, 'string');
  assert.equal(lease.token, undefined);
  assert.equal(lease.owner, undefined);
  assert.equal((await f.prepare('native_browser_observe', { leaseId: lease.leaseId }).run()).tab, 'tab-1');
});
test('per-lease mode asks once at claim and permits later actions, screenshots and batch steps', async t => {
  const f = await fixture(t, { approvalMode: 'per-lease' });
  const pending = f.prepare('native_browser_claim', claimArgs); assert.equal(pending.decision.kind, 'ask');
  const lease = await pending.run();
  const action = f.prepare('native_browser_act', { requestId: 'per-lease-action', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'fill', ref: 'node-1', text: 'trusted lease' } });
  assert.equal(action.decision.kind, 'allow'); assert.equal((await action.run()).outcome, 'succeeded');
  assert.equal(f.prepare('native_browser_screenshot', { leaseId: lease.id }).decision.kind, 'allow');
  const batch = f.prepare('native_browser_batch', { requestId: 'per-lease-batch', leaseId: lease.id, documentEpoch: 'doc-1',
    steps: [{ action: { kind: 'fill', ref: 'node-1', text: 'batch without another prompt' } }] });
  assert.equal(batch.decision.kind, 'allow'); assert.equal((await batch.run()).outcome, 'succeeded');
});
test('trusted mode is prompt-free only for an exact configured tab origin', async t => {
  const f = await fixture(t, { approvalMode: 'trusted', trustedOrigins: ['https://example.test/path-is-normalized'] });
  const claim = f.prepare('native_browser_claim', claimArgs); assert.equal(claim.decision.kind, 'allow');
  const lease = await claim.run(); assert.equal(lease.origin, 'https://example.test');
  const action = f.prepare('native_browser_act', { requestId: 'trusted-action', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'fill', ref: 'node-1', text: 'no prompt' } });
  assert.equal(action.decision.kind, 'allow'); assert.equal((await action.run()).outcome, 'succeeded');
  await f.prepare('native_browser_handoff', { leaseId: lease.id }).run();
  f.provider.tab.url = 'https://untrusted.test/form';
  await assert.rejects(f.prepare('native_browser_claim', claimArgs).run(), { code: 'POLICY_DENIED' });
  assert.equal(f.provider.grants.size, 0);
});
test('trusted mode rejects missing, wildcard and malformed origin configuration', () => {
  const ctx = { tools: { register() {} }, on() {}, effect() {} };
  assert.throws(() => apply(ctx, { approvalMode: 'trusted' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => apply(ctx, { approvalMode: 'trusted', trustedOrigins: ['*'] }));
  assert.throws(() => apply(ctx, { approvalMode: 'everything', trustedOrigins: ['https://example.test'] }), { code: 'INVALID_REQUEST' });
});
test('personal mode is prompt-free, requires a personal Broker and retains control across turns', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  const claim = f.prepare('native_browser_claim', claimArgs, 'chat-a'); assert.equal(claim.decision.kind, 'allow');
  const lease = await claim.run(); assert.equal(lease.scope, 'tab');
  f.end('chat-a');
  assert.equal((await f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run()).tab, 'tab-1');
  f.provider.tab.url = 'https://different.test/next'; f.provider.epoch = 'doc-2';
  assert.equal((await f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run()).url, f.provider.tab.url);
});
test('personal adapter fails closed when the Broker is not in personal access mode', async t => {
  const f = await fixture(t, { approvalMode: 'personal' });
  await assert.rejects(f.prepare('native_browser_claim', claimArgs).run(), { code: 'POLICY_DENIED' });
  assert.equal(f.provider.grants.size, 0);
  await assert.rejects(f.prepare('native_browser_open', { instanceId: 'fake-1', url: 'https://example.test/' }).run(), { code: 'POLICY_DENIED' });
  assert.deepEqual(f.provider.opened, []);
});
test('default personal policy permits consecutive actions, keeps host denials and revokes on handoff/switch', async t => {
  const f = await fixture(t, { approvalMode: undefined }, { accessMode: 'personal' });
  let extraApprovals = 0;
  f.services.set('approval', { request: async () => { extraApprovals++; return 'allowed-once'; } });
  const first = f.prepare('native_browser_claim', claimArgs, 'chat-a');
  assert.equal(first.decision.kind, 'allow');
  const lease = await first.run();
  for (const text of ['first', 'second']) {
    const action = f.prepare('native_browser_act', { requestId: `default-${text}`, leaseId: lease.id, documentEpoch: 'doc-1',
      action: { kind: 'fill', ref: 'node-1', text } }, 'chat-a');
    assert.equal(action.decision.kind, 'allow'); assert.equal((await action.run()).outcome, 'succeeded');
  }
  const batch = f.prepare('native_browser_batch', { requestId: 'default-batch', leaseId: lease.id, documentEpoch: 'doc-1',
    steps: [{ action: { kind: 'fill', ref: 'node-1', text: 'batch-1' } }, { action: { kind: 'fill', ref: 'node-1', text: 'batch-2' } }] }, 'chat-a');
  assert.equal((await batch.run()).outcome, 'succeeded'); assert.equal(extraApprovals, 0);
  f.end('chat-a');
  assert.equal((await f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run()).tab, 'tab-1');
  await f.foreground({ clientId: '11111111-1111-4111-8111-111111111111', revision: 1, issuedAt: Date.now(), sessionId: 'chat-b' });
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run(), { code: 'LEASE_REVOKED' });
  await until(() => f.provider.grants.size === 0);
  const second = await f.prepare('native_browser_claim', claimArgs, 'chat-b').run();
  await f.prepare('native_browser_handoff', { leaseId: second.id }, 'chat-b').run();
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: second.id }, 'chat-b').run(), { code: 'LEASE_REVOKED' });
  const status = await f.rpc('setup.status', {});
  assert.equal(status.value.policy.approvalMode, 'personal');
  assert.equal(status.value.policy.browserAccessMode, 'personal');
  const hostDenial = { kind: 'deny', reason: 'Host permission policy' };
  assert.equal(f.preExecute({ name: 'native_browser_act', callId: 'host-denial', signal: AbortSignal.timeout(1000),
    agent: { session: { id: 'chat-b' } } }, () => hostDenial), hostDenial);
});
test('foreground conversation change revokes the old owner before the new session can claim', async t => {
  const f = await fixture(t), first = await f.prepare('native_browser_claim', claimArgs, 'chat-a').run(), now = Date.now();
  const keep = await f.foreground({ clientId: '11111111-1111-4111-8111-111111111111', revision: 1, issuedAt: now, sessionId: 'chat-a' });
  assert.deepEqual(keep, { ok: true, value: { accepted: true, released: 0 } });
  const moved = await f.foreground({ clientId: '11111111-1111-4111-8111-111111111111', revision: 2, issuedAt: now + 1, sessionId: 'chat-b' });
  assert.deepEqual(moved, { ok: true, value: { accepted: true, released: 1 } });
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: first.id }, 'chat-a').run(), { code: 'LEASE_REVOKED' });
  await until(() => f.provider.grants.size === 0);
  const second = await f.prepare('native_browser_claim', claimArgs, 'chat-b').run();
  assert.equal((await f.prepare('native_browser_observe', { leaseId: second.id }, 'chat-b').run()).tab, 'tab-1');
});
test('foreground bridge rejects malformed and stale updates without revoking the current owner', async t => {
  const f = await fixture(t), lease = await f.prepare('native_browser_claim', claimArgs, 'chat-a').run(), now = Date.now();
  const clientId = '22222222-2222-4222-8222-222222222222';
  assert.equal((await f.foreground({ clientId, revision: 2, issuedAt: now + 2, sessionId: 'chat-a' })).value.accepted, true);
  assert.equal((await f.foreground({ clientId, revision: 1, issuedAt: now + 1, sessionId: 'chat-b' })).value.accepted, false);
  assert.equal((await f.foreground({ clientId: 'forged', revision: 3, issuedAt: now + 3, sessionId: 'chat-b' })).ok, false);
  assert.equal((await f.foreground({ clientId: '22222222-2222-4222-8222-22222222222-', revision: 3, issuedAt: now + 3, sessionId: 'chat-b' })).ok, false);
  assert.equal((await f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run()).tab, 'tab-1');
});

test('background model cannot reclaim or open tabs after handoff; selecting it again permits a fresh claim', async t => {
  const f = await fixture(t, { approvalMode: 'personal' }, { accessMode: 'personal' });
  const clientId = '11111111-1111-4111-8111-111111111111', now = Date.now();
  const first = await f.prepare('native_browser_claim', claimArgs, 'chat-a').run();
  await f.foreground({ clientId, revision: 1, issuedAt: now, sessionId: 'chat-b' });
  await until(() => f.provider.grants.size === 0);
  for (const [name, args] of [['claim', claimArgs], ['open', { instanceId: 'fake-1', url: 'https://example.test' }],
    ['observe', { leaseId: first.id }]]) {
    const attempt = f.prepare(`native_browser_${name}`, args, 'chat-a');
    assert.equal(attempt.decision.kind, 'deny'); assert.match(attempt.decision.reason, /background.*do not reclaim/);
    await assert.rejects(attempt.run(), { code: 'LEASE_REVOKED' });
  }
  assert.equal(f.provider.opened.length, 0); assert.equal(f.provider.grants.size, 0);
  await f.foreground({ clientId, revision: 2, issuedAt: now + 1, sessionId: 'chat-a' });
  const next = f.prepare('native_browser_claim', claimArgs, 'chat-a');
  assert.equal(next.decision.kind, 'allow'); assert.notEqual((await next.run()).id, first.id);
  await f.foreground({ clientId, revision: 3, issuedAt: now + 2, sessionId: null });
  assert.equal(f.prepare('native_browser_claim', claimArgs, 'chat-a').decision.kind, 'deny');
});
test('disposing a DSH conversation releases all of its browser control', async t => {
  const f = await fixture(t), lease = await f.prepare('native_browser_claim', claimArgs, 'chat-a').run();
  f.disposeSession('chat-a'); await until(() => f.provider.grants.size === 0);
  await assert.rejects(f.prepare('native_browser_observe', { leaseId: lease.id }, 'chat-a').run(), { code: 'LEASE_REVOKED' });
});
test('explicit frame click keeps public approval, exact scope schema and Broker deduplication',async t=>{
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),frame={frameId:'child',documentEpoch:'child-doc'};let calls=0;
  f.provider.frames=async l=>({tab:l.tab,documentEpoch:'root-doc',truncated:false,frames:[
    {id:'root',isMain:true,origin:l.origin,documentEpoch:'root-doc',contextStatus:'known'},
    {id:'child',parentId:'root',isMain:false,origin:l.origin,documentEpoch:'child-doc',contextStatus:'known'}]});
  f.provider.actFrame=async(l,r,e)=>{calls++;assert.deepEqual(r.frame,frame);e.onDispatch();return {
    observation:{...await f.provider.observe(l,e.signal),documentEpoch:frame.documentEpoch,scope:{kind:'frame',frameId:frame.frameId}},postcondition:'passed'};};
  const args={requestId:'child-click',leaseId:lease.id,documentEpoch:frame.documentEpoch,frame,action:{kind:'click',ref:'child-node'}};
  const validate=new Ajv({strict:false}).compile(f.definitions.get('native_browser_act').parameters);
  assert.equal(validate(args),true);assert.equal(validate({...args,frame:{...frame,point:{x:1,y:2}}}),false);
  const call=f.prepare('native_browser_act',args);assert.equal(call.decision.kind,'ask');assert.equal((await call.run()).outcome,'succeeded');
  await f.prepare('native_browser_act',args).run();assert.equal(calls,1);assert.equal(f.provider.calls.length,0);
  assert.throws(()=>f.prepare('native_browser_act',{...args,action:{kind:'fill',ref:'r',text:'x'}}).run(),{code:'INVALID_REQUEST'});
});
test('frame-scoped observe schema routes exact child identity and retains normal read lifecycle',async t=>{
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),frame={frameId:'child',documentEpoch:'child-doc'};
  f.provider.frames=async l=>({tab:l.tab,documentEpoch:'doc',truncated:false,frames:[
    {id:'root',isMain:true,origin:l.origin,documentEpoch:'doc',contextStatus:'known'},
    {id:'child',parentId:'root',isMain:false,origin:l.origin,documentEpoch:'child-doc',contextStatus:'known'}]});
  f.provider.observeFrame=async(l,target,s)=>{assert.deepEqual(target,frame);return {...await f.provider.observe(l,s),documentEpoch:target.documentEpoch,scope:{kind:'frame',frameId:target.frameId}};};
  const validate=new Ajv({strict:false}).compile(f.definitions.get('native_browser_observe').parameters);
  assert.equal(validate({leaseId:lease.id,frame}),true);assert.equal(validate({leaseId:lease.id,frame:{...frame,sessionId:'raw'}}),false);
  const prepared=f.prepare('native_browser_observe',{leaseId:lease.id,frame});assert.equal(prepared.decision.kind,'allow');
  assert.deepEqual((await prepared.run()).scope,{kind:'frame',frameId:'child'});
  assert.throws(()=>f.prepare('native_browser_observe',{leaseId:lease.id,frame,rootRef:123}).run(),{code:'INVALID_REQUEST'});
  f.provider.findFrame=async(l,target,query,s)=>({...await f.provider.observeFrame(l,target,s),scope:{kind:'query',frameId:target.frameId,query}});
  const query={name:'Exact',role:'button'};assert.equal(validate({leaseId:lease.id,frame,query}),true);
  const lookup=f.prepare('native_browser_observe',{leaseId:lease.id,frame,query});assert.equal(lookup.decision.kind,'allow');
  assert.deepEqual((await lookup.run()).scope,{kind:'query',frameId:frame.frameId,query});
  f.provider.observeFrameSubtree=async(l,target,rootRef,s)=>({...await f.provider.observeFrame(l,target,s),scope:{kind:'subtree',frameId:target.frameId,rootRef}});
  assert.deepEqual((await f.prepare('native_browser_observe',{leaseId:lease.id,frame,rootRef:'region'}).run()).scope,{kind:'subtree',frameId:'child',rootRef:'region'});
  const old=f.prepare('native_browser_observe',{leaseId:lease.id,frame});await f.end();await assert.rejects(old.run(),{code:'LEASE_REVOKED'});
});
test('frame tool exposes metadata-only schema through Broker and ends with the owning turn', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();
  f.provider.frames=async l=>({tab:l.tab,documentEpoch:'doc',truncated:false,frames:[
    {id:'frame-root',isMain:true,documentEpoch:'doc',origin:l.origin,contextStatus:'known',sessionId:'private'}]});
  const validate=new Ajv({strict:false}).compile(f.definitions.get('native_browser_frames').parameters);
  assert.equal(validate({leaseId:lease.id}),true);
  for(const extra of [{sessionId:'raw'},{frameId:'raw'},{includeText:true}])assert.equal(validate({leaseId:lease.id,...extra}),false);
  const call=f.prepare('native_browser_frames',{leaseId:lease.id});assert.equal(call.decision.kind,'allow');
  assert.equal((await call.run()).frames[0].sessionId,undefined);
  const old=f.prepare('native_browser_frames',{leaseId:lease.id});await f.end();await assert.rejects(old.run(),{code:'LEASE_REVOKED'});
});
const until = async check => {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Condition did not settle');
};

test('child page public schema carries exact frame/root/token through the Broker and turn lifecycle',async t=>{
 const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),frame={frameId:'child',documentEpoch:'child-doc'};
 f.provider.frames=async l=>({tab:l.tab,documentEpoch:'doc',truncated:false,frames:[
  {id:'root',isMain:true,origin:l.origin,documentEpoch:'doc',contextStatus:'known'},
  {id:'child',parentId:'root',isMain:false,origin:l.origin,documentEpoch:'child-doc',contextStatus:'known'}]});
 f.provider.readFramePage=async(l,o,s)=>{assert.deepEqual(o,{frame,rootRef:'region',continuation:'token'});return {...await f.provider.observe(l,s),
  documentEpoch:frame.documentEpoch,scope:{kind:'subtree',frameId:frame.frameId,rootRef:o.rootRef},page:{index:1,incomplete:false}};};
 const args={leaseId:lease.id,frame,rootRef:'region',continuation:'token'},validate=new Ajv({strict:false}).compile(f.definitions.get('native_browser_read_page').parameters);
 assert.equal(validate(args),true);for(const extra of [{sessionId:'raw'},{documentEpoch:''}])assert.equal(validate({...args,frame:{...frame,...extra}}),false);
 const call=f.prepare('native_browser_read_page',args);assert.equal(call.decision.kind,'allow');assert.equal((await call.run()).page.index,1);
 const late=f.prepare('native_browser_read_page',args);await f.end();await assert.rejects(late.run(),{code:'LEASE_REVOKED'});
});
test('page tool validates its independent window schema and keeps the owning turn', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),seen=[];
  f.provider.readPage=async(l,options,signal)=>{seen.push(options);return {...await f.provider.observe(l,signal),page:{index:0,incomplete:false}};};
  const validate=new Ajv({strict:false}).compile(f.definitions.get('native_browser_read_page').parameters);
  assert.equal(validate({leaseId:lease.id}),true);
  for(const extra of [{cursor:'delta'},{query:{name:'x'}},{offset:20}])assert.equal(validate({leaseId:lease.id,...extra}),false);
  const prepared=f.prepare('native_browser_read_page',{leaseId:lease.id,continuation:'opaque'});assert.equal(prepared.decision.kind,'allow');
  assert.equal((await prepared.run()).page.index,0);assert.deepEqual(seen,[{continuation:'opaque'}]);
  const old=f.prepare('native_browser_read_page',{leaseId:lease.id});await f.end();await assert.rejects(old.run(),{code:'LEASE_REVOKED'});
});

test('state postconditions retain per-action approval, strict public schema and request-ID payload fencing', async t => {
  const f = await fixture(t), lease = await f.prepare('native_browser_claim', claimArgs).run();
  const args = { requestId: 'state-adapter', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'click', ref: 'node-1',
    expected: { kind: 'state', ref: 'node-1', state: 'enabled' } } };
  const validate = new Ajv({ strict: false }).compile(f.definitions.get('native_browser_act').parameters);
  assert.equal(validate(args), true);
  for (const expected of [{ ...args.action.expected, state: 'custom-script' }, { ...args.action.expected, objectId: 'forged' }])
    assert.equal(validate({ ...args, action: { ...args.action, expected } }), false);
  assert.equal(validate({ ...args, action: { kind: 'navigate', url: 'https://example.test/', expected: args.action.expected } }), false);
  const call = f.prepare('native_browser_act', args); assert.equal(call.decision.kind, 'ask');
  const result = await call.run(); assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(f.provider.calls[0].expected, args.action.expected); // Portable seam only, not a state oracle.
  assert.deepEqual(await f.prepare('native_browser_act', args).run(), result); assert.equal(f.provider.calls.length, 1);
  await assert.rejects(f.prepare('native_browser_act', { ...args, action: { ...args.action,
    expected: { ...args.action.expected, state: 'disabled' } } }).run(), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(f.provider.calls.length, 1);
});

test('batch reverse approvals are per-step, linked to the outer call and contain no input payload in reasons', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),asks=[];
  f.services.set('approval',{request:async req=>{asks.push(req);return 'allowed-once';}});
  const args={requestId:'adapter-batch',leaseId:lease.id,documentEpoch:'doc-1',steps:[
    {action:{kind:'fill',ref:'node-1',text:'private-text-one'}},{action:{kind:'fill',ref:'node-1',text:'private-text-two'}}]};
  const call=f.prepare('native_browser_batch',args);assert.equal(call.decision.kind,'allow');
  const result=await call.run();assert.equal(result.outcome,'succeeded');assert.equal(asks.length,2);
  assert.ok(asks.every(a=>a.toolName==='native_browser_batch'&&a.callId===call.exec.callId&&a.agent.session.id==='session'&&!a.reason.includes('private-text')));
  assert.match(asks[0].reason,/step 1\/2/);assert.match(asks[1].reason,/step 2\/2/);
  assert.deepEqual(await f.prepare('native_browser_batch',args).run(),result);assert.equal(asks.length,2);assert.equal(f.provider.calls.length,2);
});

test('missing, rejecting, cancelled or invalid batch approval cannot dispatch or advance', async t => {
  for(const outcome of [undefined,'rejected','unavailable','cancelled','invalid']){
    const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();let asks=0;
    if(outcome!==undefined)f.services.set('approval',{request:async()=>{asks++;return outcome;}});
    const args={requestId:'batch-denial',leaseId:lease.id,documentEpoch:'doc-1',steps:[{action:{kind:'fill',ref:'node-1',text:'never'}}]};
    const r=await f.prepare('native_browser_batch',args).run();assert.notEqual(r.outcome,'succeeded');assert.equal(f.provider.calls.length,0);
    assert.equal(r.code,outcome==='cancelled'?'CANCELLED':'POLICY_DENIED');assert.equal(asks,outcome===undefined?0:1);
  }
});

test('turn/end invalidates a batch waiting for step approval even if the answer arrives late', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();let entered,finish;
  const started=new Promise(resolve=>{entered=resolve;});
  f.services.set('approval',{request:()=>new Promise(resolve=>{finish=resolve;entered();})});
  const args={requestId:'batch-end',leaseId:lease.id,documentEpoch:'doc-1',steps:[{action:{kind:'fill',ref:'node-1',text:'never'}}]};
  const call=f.prepare('native_browser_batch',args),pending=call.run(),rejected=assert.rejects(pending,{code:'LEASE_REVOKED'});
  await started;f.end();finish('allowed-once');await rejected;assert.equal(f.provider.calls.length,0);
  await until(()=>f.provider.grants.size===0);
});

test('batch approval callbacks reject out-of-range, skipped and repeated step indices', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();let asks=0;
  f.services.set('approval',{request:async()=>{asks++;return 'allowed-once';}});
  f.broker.runtime.batch=async(_owner,request,signal,approve)=>{
    await assert.rejects(approve(9,signal),{code:'POLICY_DENIED'});
    await assert.rejects(approve(1,signal),{code:'POLICY_DENIED'});
    assert.equal(await approve(0,signal),true);
    await assert.rejects(approve(0,signal),{code:'POLICY_DENIED'});
    return {requestId:request.requestId,totalSteps:request.steps.length,outcome:'unknown',dispatch:'notDispatched',postcondition:'unverified'};
  };
  await f.prepare('native_browser_batch',{requestId:'callback-bounds',leaseId:lease.id,documentEpoch:'doc-1',steps:[
    {action:{kind:'fill',ref:'node-1',text:'one'}},{action:{kind:'fill',ref:'node-1',text:'two'}}]}).run();
  assert.equal(asks,1);assert.equal(f.provider.calls.length,0);
});

test('at most eight batch approval contexts are retained, including queued work', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();let finish;
  f.services.set('approval',{request:()=>new Promise(resolve=>{finish=resolve;})});
  const args=id=>({requestId:id,leaseId:lease.id,documentEpoch:'doc-1',steps:[{action:{kind:'fill',ref:'node-1',text:'never'}}]});
  const pending=Array.from({length:8},(_,i)=>f.prepare('native_browser_batch',args(`pending-${i}`)).run().then(value=>({value}),error=>({error})));
  await until(()=>f.broker.runtime.journalUsage().identities===8);
  await assert.rejects(f.prepare('native_browser_batch',args('overflow')).run(),{code:'QUEUE_FULL'});
  f.end();finish?.('allowed-once');await Promise.all(pending);assert.equal(f.provider.calls.length,0);
});

test('adapter refuses tool body calls that bypass the owning pre-execute boundary', async t => {
  const f = await fixture(t);
  await assert.rejects(f.definitions.get('native_browser_list').execute({}, { name: 'native_browser_list', callId: 'unbound',
    signal: new AbortController().signal, agent: { session: { id: 'session' } } }), e => e.code === 'POLICY_DENIED');
});

test('approval resolved after turn/end cannot create a connection or grant a lease', async t => {
  const f = await fixture(t), pending = f.prepare('native_browser_claim', claimArgs);
  assert.equal(pending.decision.kind, 'ask');
  f.end();
  await assert.rejects(pending.run(), e => e.code === 'LEASE_REVOKED');
  assert.equal(f.provider.grants.size, 0);
});

test('a new turn uses a new wire owner and old cleanup does not revoke the new lease', async t => {
  const f = await fixture(t);
  const old = await f.prepare('native_browser_claim', claimArgs).run();
  const lateOldCall = f.prepare('native_browser_observe', { leaseId: old.id });
  f.end(); await until(() => f.provider.grants.size === 0);
  const next = await f.prepare('native_browser_claim', claimArgs).run();
  assert.notEqual(old.leaseId, next.leaseId);
  assert.equal(old.owner, undefined); assert.equal(next.owner, undefined);
  assert.equal(old.token, undefined); assert.equal(next.token, undefined);
  await assert.rejects(lateOldCall.run(), e => e.code === 'LEASE_REVOKED');
  assert.equal((await f.prepare('native_browser_observe', { leaseId: next.id }).run()).tab, 'tab-1');
});

test('turn/end during an in-flight provider grant cancels and does not leave control behind', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.provider.grant = async (_lease, signal) => {
    entered();
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
  };
  const pending = f.prepare('native_browser_claim', claimArgs).run();
  const rejection = assert.rejects(pending, e => ['CANCELLED', 'LEASE_REVOKED'].includes(e.code));
  await started; f.end(); await rejection;
  assert.equal(f.provider.grants.size, 0);
});

test('a screenshot finishing storage after turn/end is not returned to the old execution', async t => {
  const f = await fixture(t); const lease = await f.prepare('native_browser_claim', claimArgs).run();
  f.provider.capture = async () => ({ data: '/9j/', mimeType: 'image/jpeg', tab: 'tab-1', documentEpoch: 'doc-1',
    capturedAt: Date.now(), viewport: { width: 100, height: 100, pageX: 0, pageY: 0 },
    redaction: { policy: 'cross-origin-frames', frames: 0, regions: 0 } });
  let entered, finish;
  const storing = new Promise(resolve => { entered = resolve; });
  f.services.set('attachments', { saveImage: () => new Promise(resolve => { finish = resolve; entered(); }), readImage: async () => { throw new Error('Ended screenshot must not be read'); } });
  const pending = f.prepare('native_browser_screenshot', { leaseId: lease.id }).run();
  const rejection = assert.rejects(pending, e => e.code === 'LEASE_REVOKED');
  await storing; f.end(); finish({ id: 'image', width: 100, height: 100 });
  await rejection;
});

test('dispose invalidates an execution still waiting for approval', async t => {
  const f = await fixture(t), pending = f.prepare('native_browser_claim', claimArgs);
  f.dispose(); await assert.rejects(pending.run(), e => e.code === 'CONNECTION_LOST');
  assert.equal(f.provider.grants.size, 0);
});

test('handoff during Host image storage prevents late screenshot publication', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();
  const data=Buffer.from('canonical fixture'),attachment={attachmentId:`sha256:${createHash('sha256').update(data).digest('hex')}`,width:100,height:100};
  f.provider.capture=async()=>({data:'/9j/',mimeType:'image/jpeg',tab:'tab-1',documentEpoch:'doc-1',capturedAt:Date.now(),
    viewport:{width:100,height:100,pageX:0,pageY:0},redaction:{policy:'cross-origin-frames',frames:0,regions:0}});
  let entered,finish;const storing=new Promise(resolve=>{entered=resolve;});
  f.services.set('attachments',{saveImage:()=>new Promise(resolve=>{finish=resolve;entered();}),readImage:async()=>({data})});
  const pending=f.prepare('native_browser_screenshot',{leaseId:lease.id}).run();
  await storing;await f.prepare('native_browser_handoff',{leaseId:lease.id}).run();
  finish(attachment);
  await assert.rejects(pending,{code:'LEASE_REVOKED'});
});

function captureStore(f,stage='save') {
  const data=Buffer.from('canonical fixture'),attachment={attachmentId:`sha256:${createHash('sha256').update(data).digest('hex')}`,width:100,height:100};
  f.provider.capture=async()=>({data:'/9j/',mimeType:'image/jpeg',tab:'tab-1',documentEpoch:'doc-1',capturedAt:Date.now(),
    viewport:{width:100,height:100,pageX:0,pageY:0},redaction:{policy:'cross-origin-frames',frames:0,regions:0}});
  let enter,finish,readSignal;const entered=new Promise(resolve=>{enter=resolve;});
  f.services.set('attachments',{
    saveImage:async()=>{if(stage==='save')await new Promise(resolve=>{finish=resolve;enter();});return attachment;},
    readImage:async(_attachment,signal)=>{readSignal=signal;if(stage==='read')await new Promise(resolve=>{finish=resolve;enter();});return {data};},
  });
  return {entered,finish:()=>finish(),readSignal:()=>readSignal};
}

test('provider Stop during Host canonical read aborts the pending image via the real Broker event', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),store=captureStore(f,'read');
  const pending=f.prepare('native_browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;await f.broker.runtime.providerRevoked('fake-1',lease.id);
  await until(()=>store.readSignal().aborted);store.finish();
  await assert.rejects(pending,{code:'LEASE_REVOKED'});
});

test('Broker disconnect during storage prevents publication and never reconnects the old image', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),store=captureStore(f);
  const pending=f.prepare('native_browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;await f.broker.close();store.finish();
  await assert.rejects(pending,{code:'CONNECTION_LOST'});
});

test('final image publication checks current origin even without a revocation notification', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),store=captureStore(f);
  const pending=f.prepare('native_browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;f.provider.tab.url='https://unapproved.test/';store.finish();
  await assert.rejects(pending,{code:'POLICY_DENIED'});
});

test('another Session cannot cancel the owning Session screenshot through handoff', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run(),store=captureStore(f);
  const pending=f.prepare('native_browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;
  await assert.rejects(f.prepare('native_browser_handoff',{leaseId:lease.id},'different-session').run(),{code:'LEASE_REVOKED'});
  store.finish();assert.equal((await pending).screenshot.leaseId,lease.id);
});

test('at most eight Host screenshot publications remain pending, including cancelled storage', async t => {
  const f=await fixture(t),lease=await f.prepare('native_browser_claim',claimArgs).run();captureStore(f);
  const finishes=[];f.services.get('attachments').saveImage=()=>new Promise(resolve=>{finishes.push(resolve);});
  const pending=Array.from({length:8},()=>f.prepare('native_browser_screenshot',{leaseId:lease.id}).run());
  await until(()=>finishes.length===8);
  await assert.rejects(f.prepare('native_browser_screenshot',{leaseId:lease.id}).run(),{code:'QUEUE_FULL'});
  await f.prepare('native_browser_handoff',{leaseId:lease.id}).run();
  await assert.rejects(f.prepare('native_browser_screenshot',{leaseId:lease.id}).run(),{code:'QUEUE_FULL'});
  const rejected=pending.map(p=>assert.rejects(p,{code:'LEASE_REVOKED'}));
  for(const finish of finishes)finish({});await Promise.all(rejected);
  const next=await f.prepare('native_browser_claim',claimArgs).run();
  const store=captureStore(f);const restored=f.prepare('native_browser_screenshot',{leaseId:next.id}).run();
  await store.entered;store.finish();assert.equal((await restored).screenshot.leaseId,next.id);
});

test('native_browser_act advertises a bounded JavaScript dialog action and postcondition schema', async t => {
  const f = await fixture(t), lease = await f.prepare('native_browser_claim', claimArgs).run();
  const validate = new Ajv({ strict: false }).compile(f.definitions.get('native_browser_act').parameters);
  const base = { requestId: 'dialog-schema', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'dialog', accept: true, promptText: 'Longmiaoo', expected: { kind: 'text', text: 'Accepted' } } };
  assert.equal(validate(base), true);
  assert.equal(validate({ ...base, action: { kind: 'dialog', accept: false } }), true);
  for (const action of [
    { kind: 'dialog' }, { kind: 'dialog', accept: 'yes' }, { kind: 'dialog', accept: true, promptText: 'x'.repeat(1001) },
    { kind: 'dialog', accept: true, expected: { kind: 'value', value: 'x' } },
    { kind: 'dialog', accept: true, expected: { kind: 'url', url: 'https://example.test/' } },
    { kind: 'dialog', accept: true, extra: true },
  ]) assert.equal(validate({ ...base, action }), false);
});

for (const mode of ['personal', 'per-lease', 'per-action']) {
  test(`${mode}: file actions need their own approval and the Broker confines uploads to allowed folders`, async t => {
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-upload-root-')));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const allowed = path.join(folder, 'resume.pdf'); await writeFile(allowed, 'ok');
    const f = await fixture(t, { approvalMode: mode }, { ...(mode === 'personal' ? { accessMode: 'personal' } : {}), uploadRoots: [folder] });
    const reasons = []; let answer = 'denied';
    f.services.set('approval', { request: async request => { reasons.push(request.reason); return answer; } });
    const lease = await f.prepare('native_browser_claim', claimArgs).run();
    const act = (requestId, action) => f.prepare('native_browser_act', { requestId, leaseId: lease.id, documentEpoch: 'doc-1', action });
    const uploads = () => f.provider.calls.filter(call => call.kind === 'upload');
    answer = 'allowed-once';
    if (mode === 'per-action') {
      // Already asked by the Host for this exact call; no second, duplicate prompt.
      const call = act('u-ok', { kind: 'upload', ref: 'node-1', files: [allowed] });
      assert.equal(call.decision.kind, 'ask'); assert.equal((await call.run()).outcome, 'succeeded');
      assert.equal(reasons.length, 0); assert.deepEqual(uploads().at(-1).files, [allowed]);
      await assert.rejects(act('u-out', { kind: 'upload', ref: 'node-1', files: ['/etc/hosts'] }).run(), { code: 'POLICY_DENIED' });
      assert.equal(uploads().length, 1);
      return;
    }
    assert.equal((await act('click', { kind: 'click', ref: 'node-1' }).run()).outcome, 'succeeded');
    assert.equal(reasons.length, 0, 'ordinary actions keep the configured low-friction policy');
    answer = 'denied';
    await assert.rejects(act('u-denied', { kind: 'upload', ref: 'node-1', files: [allowed] }).run(), { code: 'POLICY_DENIED' });
    assert.ok(reasons.at(-1).includes(allowed), 'the prompt shows the exact local path');
    answer = 'cancelled';
    await assert.rejects(act('u-cancel', { kind: 'choose', ref: 'node-1', files: [allowed] }).run(), { code: 'CANCELLED' });
    assert.equal(uploads().length, 0);
    answer = 'allowed-once';
    assert.equal((await act('u-ok', { kind: 'upload', ref: 'node-1', files: [allowed] }).run()).outcome, 'succeeded');
    assert.deepEqual(uploads().at(-1).files, [allowed]);
    // Approval cannot widen the Broker's folder allowlist.
    await assert.rejects(act('u-out', { kind: 'upload', ref: 'node-1', files: ['/etc/hosts'] }).run(), { code: 'POLICY_DENIED' });
    assert.equal(uploads().length, 1);
    // Downloads are no longer gated; they never raise a prompt.
    answer = 'denied'; const asked = reasons.length;
    const download = await act('d-free', { kind: 'download', ref: 'node-1' }).run();
    assert.ok(['succeeded', 'unknown'].includes(download.outcome));
    assert.equal(reasons.length, asked);
    f.services.delete('approval');
    await assert.rejects(act('u-noservice', { kind: 'upload', ref: 'node-1', files: [allowed] }).run(), { code: 'POLICY_DENIED' });
    assert.equal(uploads().length, 1);
  });
}
