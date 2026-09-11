import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-adapter-'));
  const broker = await startBroker({ directory, allowedOrigins: ['https://example.test'] });
  const provider = new FakeProvider(); broker.runtime.register(provider);
  const definitions = new Map(), hooks = new Map(), effects = [], services = new Map();
  const ctx = { tools: { register: tool => definitions.set(tool.name, tool) },
    on: (event, handler) => hooks.set(event, handler), effect: callback => effects.push(callback()), get: name => services.get(name) };
  apply(ctx, { runtimeDirectory: directory });
  t.after(async () => { for (const dispose of effects) dispose(); await broker.close(); await rm(directory, { recursive: true }); });
  let count = 0;
  const prepare = (name, args, sessionId = 'session') => {
    const exec = { name, callId: `call-${++count}`, signal: AbortSignal.timeout(3000), agent: { session: { id: sessionId } } };
    const decision = hooks.get('tools/pre-execute')(exec, () => ({ kind: 'allow' }));
    return { exec, decision, run: () => definitions.get(name).execute(args, exec) };
  };
  return { provider, broker, prepare, definitions, services,
    end: (id = 'session') => hooks.get('session/event')({ id }, { type: 'turn/end' }),
    dispose: () => { for (const dispose of effects) dispose(); } };
}
const claimArgs = { instanceId: 'fake-1', tab: 'tab-1' };
const until = async check => {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Condition did not settle');
};

test('adapter refuses tool body calls that bypass the owning pre-execute boundary', async t => {
  const f = await fixture(t);
  await assert.rejects(f.definitions.get('browser_list').execute({}, { name: 'browser_list', callId: 'unbound',
    signal: new AbortController().signal, agent: { session: { id: 'session' } } }), e => e.code === 'POLICY_DENIED');
});

test('approval resolved after turn/end cannot create a connection or grant a lease', async t => {
  const f = await fixture(t), pending = f.prepare('browser_claim', claimArgs);
  assert.equal(pending.decision.kind, 'ask');
  f.end();
  await assert.rejects(pending.run(), e => e.code === 'LEASE_REVOKED');
  assert.equal(f.provider.grants.size, 0);
});

test('a new turn uses a new wire owner and old cleanup does not revoke the new lease', async t => {
  const f = await fixture(t);
  const old = await f.prepare('browser_claim', claimArgs).run();
  const lateOldCall = f.prepare('browser_observe', { leaseId: old.id });
  f.end(); await until(() => f.provider.grants.size === 0);
  const next = await f.prepare('browser_claim', claimArgs).run();
  assert.notEqual(old.owner, next.owner); assert.notEqual(old.token, next.token);
  await assert.rejects(lateOldCall.run(), e => e.code === 'LEASE_REVOKED');
  assert.equal((await f.prepare('browser_observe', { leaseId: next.id }).run()).tab, 'tab-1');
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
  const pending = f.prepare('browser_claim', claimArgs).run();
  const rejection = assert.rejects(pending, e => ['CANCELLED', 'LEASE_REVOKED'].includes(e.code));
  await started; f.end(); await rejection;
  assert.equal(f.provider.grants.size, 0);
});

test('a screenshot finishing storage after turn/end is not returned to the old execution', async t => {
  const f = await fixture(t); const lease = await f.prepare('browser_claim', claimArgs).run();
  f.provider.capture = async () => ({ data: '/9j/', mimeType: 'image/jpeg', tab: 'tab-1', documentEpoch: 'doc-1',
    capturedAt: Date.now(), viewport: { width: 100, height: 100, pageX: 0, pageY: 0 } });
  let entered, finish;
  const storing = new Promise(resolve => { entered = resolve; });
  f.services.set('attachments', { saveImage: () => new Promise(resolve => { finish = resolve; entered(); }), readImage: async () => { throw new Error('Ended screenshot must not be read'); } });
  const pending = f.prepare('browser_screenshot', { leaseId: lease.id }).run();
  const rejection = assert.rejects(pending, e => e.code === 'LEASE_REVOKED');
  await storing; f.end(); finish({ id: 'image', width: 100, height: 100 });
  await rejection;
});

test('dispose invalidates an execution still waiting for approval', async t => {
  const f = await fixture(t), pending = f.prepare('browser_claim', claimArgs);
  f.dispose(); await assert.rejects(pending.run(), e => e.code === 'CONNECTION_LOST');
  assert.equal(f.provider.grants.size, 0);
});

test('handoff during Host image storage prevents late screenshot publication', async t => {
  const f=await fixture(t),lease=await f.prepare('browser_claim',claimArgs).run();
  const data=Buffer.from('canonical fixture'),attachment={attachmentId:`sha256:${createHash('sha256').update(data).digest('hex')}`,width:100,height:100};
  f.provider.capture=async()=>({data:'/9j/',mimeType:'image/jpeg',tab:'tab-1',documentEpoch:'doc-1',capturedAt:Date.now(),
    viewport:{width:100,height:100,pageX:0,pageY:0}});
  let entered,finish;const storing=new Promise(resolve=>{entered=resolve;});
  f.services.set('attachments',{saveImage:()=>new Promise(resolve=>{finish=resolve;entered();}),readImage:async()=>({data})});
  const pending=f.prepare('browser_screenshot',{leaseId:lease.id}).run();
  await storing;await f.prepare('browser_handoff',{leaseId:lease.id}).run();
  finish(attachment);
  await assert.rejects(pending,{code:'LEASE_REVOKED'});
});

function captureStore(f,stage='save') {
  const data=Buffer.from('canonical fixture'),attachment={attachmentId:`sha256:${createHash('sha256').update(data).digest('hex')}`,width:100,height:100};
  f.provider.capture=async()=>({data:'/9j/',mimeType:'image/jpeg',tab:'tab-1',documentEpoch:'doc-1',capturedAt:Date.now(),viewport:{width:100,height:100,pageX:0,pageY:0}});
  let enter,finish,readSignal;const entered=new Promise(resolve=>{enter=resolve;});
  f.services.set('attachments',{
    saveImage:async()=>{if(stage==='save')await new Promise(resolve=>{finish=resolve;enter();});return attachment;},
    readImage:async(_attachment,signal)=>{readSignal=signal;if(stage==='read')await new Promise(resolve=>{finish=resolve;enter();});return {data};},
  });
  return {entered,finish:()=>finish(),readSignal:()=>readSignal};
}

test('provider Stop during Host canonical read aborts the pending image via the real Broker event', async t => {
  const f=await fixture(t),lease=await f.prepare('browser_claim',claimArgs).run(),store=captureStore(f,'read');
  const pending=f.prepare('browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;await f.broker.runtime.providerRevoked('fake-1',lease.id);
  await until(()=>store.readSignal().aborted);store.finish();
  await assert.rejects(pending,{code:'LEASE_REVOKED'});
});

test('Broker disconnect during storage prevents publication and never reconnects the old image', async t => {
  const f=await fixture(t),lease=await f.prepare('browser_claim',claimArgs).run(),store=captureStore(f);
  const pending=f.prepare('browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;await f.broker.close();store.finish();
  await assert.rejects(pending,{code:'CONNECTION_LOST'});
});

test('final image publication checks current origin even without a revocation notification', async t => {
  const f=await fixture(t),lease=await f.prepare('browser_claim',claimArgs).run(),store=captureStore(f);
  const pending=f.prepare('browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;f.provider.tab.url='https://unapproved.test/';store.finish();
  await assert.rejects(pending,{code:'POLICY_DENIED'});
});

test('another Session cannot cancel the owning Session screenshot through handoff', async t => {
  const f=await fixture(t),lease=await f.prepare('browser_claim',claimArgs).run(),store=captureStore(f);
  const pending=f.prepare('browser_screenshot',{leaseId:lease.id}).run();
  await store.entered;
  await assert.rejects(f.prepare('browser_handoff',{leaseId:lease.id},'different-session').run(),{code:'LEASE_REVOKED'});
  store.finish();assert.equal((await pending).screenshot.leaseId,lease.id);
});

test('at most eight Host screenshot publications remain pending, including cancelled storage', async t => {
  const f=await fixture(t),lease=await f.prepare('browser_claim',claimArgs).run();captureStore(f);
  const finishes=[];f.services.get('attachments').saveImage=()=>new Promise(resolve=>{finishes.push(resolve);});
  const pending=Array.from({length:8},()=>f.prepare('browser_screenshot',{leaseId:lease.id}).run());
  await until(()=>finishes.length===8);
  await assert.rejects(f.prepare('browser_screenshot',{leaseId:lease.id}).run(),{code:'QUEUE_FULL'});
  await f.prepare('browser_handoff',{leaseId:lease.id}).run();
  await assert.rejects(f.prepare('browser_screenshot',{leaseId:lease.id}).run(),{code:'QUEUE_FULL'});
  const rejected=pending.map(p=>assert.rejects(p,{code:'LEASE_REVOKED'}));
  for(const finish of finishes)finish({});await Promise.all(rejected);
  const next=await f.prepare('browser_claim',claimArgs).run();
  const store=captureStore(f);const restored=f.prepare('browser_screenshot',{leaseId:next.id}).run();
  await store.entered;store.finish();assert.equal((await restored).screenshot.leaseId,next.id);
});
