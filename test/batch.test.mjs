import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { batchRequest } from '../dist/packages/contracts/src/validation.js';
import { brokerCapabilities, clientRequirements, acceptWelcome } from '../dist/packages/contracts/src/wire.js';
import { FileActionJournal } from '../dist/packages/broker/src/action-journal.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

const signal=()=>new AbortController().signal;
const fill=text=>({action:{kind:'fill',ref:'node-1',text}});
async function fixture(t,{authorize=async()=>true,limits,durable}={}) {
  const runtime=new BrowserRuntime(authorize,limits,durable),provider=new FakeProvider();runtime.register(provider);t.after(()=>runtime.dispose());
  const lease=await runtime.claim('owner','fake-1','tab-1',signal());
  const request={requestId:'batch-case',leaseId:lease.id,documentEpoch:'doc-1',steps:[fill('first'),fill('second'),fill('third')]};
  return {runtime,provider,lease,request};
}
function gate() {
  let open;const promise=new Promise(resolve=>{open=resolve;});
  return {open,promise,async wait(signal){let abort;try{return await Promise.race([promise,new Promise((_,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  })]);}finally{signal.removeEventListener('abort',abort);}}};
}
test('batch validates explicit bounded steps, shared deadlines and final-only navigation',()=>{
  const raw={requestId:'b',leaseId:'l',documentEpoch:'d',steps:[fill('a')]};assert.deepEqual(batchRequest(raw),raw);
  assert.equal(batchRequest({...raw,steps:Array.from({length:8},()=>fill('a')),timeoutMs:30000}).steps.length,8);
  for(const bad of [{...raw,steps:[]},{...raw,steps:Array(9).fill(fill('a'))},{...raw,timeoutMs:30001},
    {...raw,requestId:'batch:reserved'},{...raw,steps:[{...fill('a'),script:'bad'}]},{...raw,code:'bad'},
    {...raw,steps:[{action:{kind:'navigate',url:'https://example.test/'}},fill('a')]}])assert.throws(()=>batchRequest(bad),{code:'INVALID_REQUEST'});
  assert.equal(batchRequest({...raw,steps:[fill('a'),{action:{kind:'navigate',url:'https://example.test/'}}]}).steps.length,2);
  assert.ok(clientRequirements.includes('runtime.batch.v1'));
  assert.throws(()=>acceptWelcome({version:1,connectionEpoch:'e',capabilities:brokerCapabilities.filter(c=>c!=='runtime.batch.v1')},clientRequirements),{code:'PROTOCOL_MISMATCH'});
});
test('batch returns per-step metadata and one last observation, with whole-plan deduplication',async t=>{
  const f=await fixture(t),approved=[],approve=async i=>{approved.push(i);return true;};
  const result=await f.runtime.batch('owner',f.request,signal(),approve);
  assert.equal(result.outcome,'succeeded');assert.equal(result.postcondition,'passed');assert.deepEqual(approved,[0,1,2]);
  assert.equal(f.provider.calls.length,3);assert.ok(result.steps.every(s=>s.status==='attempted'&&!('observation'in s.result)&&!('scroll'in s.result)));
  assert.equal(result.observation.nodes[0].value,'third');assert.equal(result.totalSteps,3);assert.equal(new Set(result.steps.map(s=>s.result.requestId)).size,3);
  assert.deepEqual(await f.runtime.batch('owner',f.request,signal(),approve),result);assert.deepEqual(approved,[0,1,2]);assert.equal(f.provider.calls.length,3);
  assert.throws(()=>f.runtime.batch('owner',{...f.request,steps:[fill('different')]},signal(),approve),{code:'REQUEST_ID_CONFLICT'});
  assert.throws(()=>f.runtime.act('owner',{requestId:result.steps[0].result.requestId,leaseId:f.lease.id,documentEpoch:'doc-1',action:fill('forged').action},signal()),{code:'INVALID_REQUEST'});
  assert.equal(f.runtime.journalUsage().identities,4);
});
test('step denial reports partial progress and cannot resume notRun steps on replay',async t=>{
  const f=await fixture(t),approved=[];
  const first=await f.runtime.batch('owner',f.request,signal(),async i=>{approved.push(i);return i===0;});
  assert.equal(first.outcome,'failed');assert.equal(first.code,'POLICY_DENIED');assert.deepEqual(first.steps.map(s=>s.status),['attempted','attempted','notRun']);
  assert.equal(first.steps[0].result.outcome,'succeeded');assert.equal(first.steps[1].result.dispatch,'notDispatched');
  assert.equal(first.observation,undefined);assert.deepEqual(approved,[0,1]);assert.equal(f.provider.calls.length,1);
  assert.deepEqual(await f.runtime.batch('owner',f.request,signal(),async()=>true),first);assert.equal(f.provider.calls.length,1);
});
test('unknown and unverified child outcomes stop later approval and input',async t=>{
  for(const mode of ['lost-ack','unverified']){
    const f=await fixture(t),approved=[];f.provider.failAfterDispatch=mode==='lost-ack';if(mode==='unverified')f.provider.postcondition='unverified';
    const r=await f.runtime.batch('owner',f.request,signal(),async i=>{approved.push(i);return true;});
    assert.equal(r.outcome,'unknown');assert.deepEqual(approved,[0]);assert.equal(f.provider.calls.length,1);assert.deepEqual(r.steps.map(s=>s.status),['attempted','notRun','notRun']);
  }
});
test('one batch queue slot prevents outside actions interleaving during step approval',async t=>{
  const f=await fixture(t),entered=gate(),proceed=gate();t.after(proceed.open);
  const batch=f.runtime.batch('owner',f.request,signal(),async(i,s)=>{if(i===1){entered.open();await proceed.wait(s);}return true;});
  await entered.promise;
  const other=f.runtime.act('owner',{requestId:'outside',leaseId:f.lease.id,documentEpoch:'doc-1',action:fill('outside').action},signal());
  assert.deepEqual(f.provider.calls.map(a=>a.text),['first']);proceed.open();await batch;await other;
  assert.deepEqual(f.provider.calls.map(a=>a.text),['first','second','third','outside']);
});
test('concurrent duplicate uses original approval lifecycle and the immutable plan',async t=>{
  const f=await fixture(t),entered=gate(),proceed=gate(),original=structuredClone(f.request),approvals=[];t.after(proceed.open);
  const one=f.runtime.batch('owner',f.request,signal(),async(i,s)=>{approvals.push(i);if(i===0){entered.open();await proceed.wait(s);}return true;});
  await entered.promise;
  const two=f.runtime.batch('owner',original,signal(),async()=>assert.fail('No duplicate approval'));
  f.request.steps[0].action.text='changed after approval began';proceed.open();assert.deepEqual(await two,await one);
  assert.deepEqual(approvals,[0,1,2]);assert.equal(f.provider.calls[0].text,'first');
});
test('shared deadline and cancellation interrupt approval without starting the next action',async t=>{
  for(const mode of ['cancel','deadline']){
    const f=await fixture(t),entered=gate(),never=gate(),controller=new AbortController();
    const pending=f.runtime.batch('owner',{...f.request,timeoutMs:mode==='deadline'?40:2000},controller.signal,
      async(i,s)=>{if(i===1){entered.open();await never.wait(s);}return true;});
    await entered.promise;if(mode==='cancel')controller.abort(new BrowserError('CANCELLED','test cancel'));
    const keepAlive=setTimeout(()=>{},2000);const r=await pending;clearTimeout(keepAlive);
    assert.equal(r.code,mode==='cancel'?'CANCELLED':'DEADLINE_EXCEEDED');assert.equal(f.provider.calls.length,1);assert.equal(r.steps[2].status,'notRun');
  }
});
test('Stop and post-approval policy changes block the approved next step',async t=>{
  for(const mode of ['stop','policy']){
    let allowed=true;const f=await fixture(t,{authorize:async()=>allowed}),entered=gate(),proceed=gate();t.after(proceed.open);
    const pending=f.runtime.batch('owner',f.request,signal(),async(i,s)=>{if(i===1){entered.open();await proceed.wait(s);}return true;});
    await entered.promise;if(mode==='stop'){const releasing=f.runtime.release('owner',f.lease.id);proceed.open();await releasing;}else{allowed=false;proceed.open();}
    const r=await pending;assert.notEqual(r.outcome,'succeeded');assert.equal(f.provider.calls.length,1);assert.equal(r.steps?.[2].status,'notRun');
  }
});
test('an unexpected document replacement cuts the batch after its successful child',async t=>{
  const f=await fixture(t),original=f.provider.act.bind(f.provider),approved=[];
  f.provider.act=async(...args)=>{const result=await original(...args);result.observation.documentEpoch='new-document';return result;};
  const r=await f.runtime.batch('owner',f.request,signal(),async i=>{approved.push(i);return true;});
  assert.equal(r.outcome,'unknown');assert.equal(r.code,'STALE_TARGET');assert.deepEqual(approved,[0]);assert.equal(r.steps[1].status,'notRun');assert.equal(f.provider.calls.length,1);
});
test('evicted batch payload leaves a recovery fence, never restarted children',async t=>{
  const f=await fixture(t,{limits:{resultEntries:1}});await f.runtime.batch('owner',f.request,signal(),async()=>true);
  await f.runtime.act('owner',{requestId:'evict',leaseId:f.lease.id,documentEpoch:'doc-1',action:fill('outside').action},signal());
  const r=await f.runtime.batch('owner',f.request,signal(),async()=>assert.fail('No approval on recovery'));
  assert.equal(r.code,'RECOVERY_REQUIRED');assert.equal(r.steps,undefined);assert.equal(r.totalSteps,3);assert.equal(f.provider.calls.length,4);
});
test('outer and child durable fences reopen without payloads and never resume unfinished work',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'dsh-batch-journal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let journal=await FileActionJournal.open(directory,'b'.repeat(64));const f=await fixture(t,{durable:journal}),settle=journal.settle.bind(journal);
  journal.settle=(key,result)=>key===JSON.stringify(['private-scope',f.request.requestId])?Promise.reject(new BrowserError('JOURNAL_UNAVAILABLE','Outer settlement fault')):settle(key,result);
  const first=await f.runtime.batch('owner',f.request,signal(),async i=>i===0,'private-scope');assert.equal(first.code,'JOURNAL_UNAVAILABLE');assert.equal(f.provider.calls.length,1);
  await f.runtime.dispose();await journal.close();const disk=await readFile(path.join(directory,'action-journal.jsonl'),'utf8');
  for(const secret of ['private-scope','first','second','node-1','batch-case','documentEpoch'])assert.equal(disk.includes(secret),false);
  journal=await FileActionJournal.open(directory,'b'.repeat(64));const restarted=new BrowserRuntime(async()=>true,undefined,journal);
  try{const r=await restarted.batch('new-owner',f.request,signal(),async()=>assert.fail('No resumption'),'private-scope');
    assert.equal(r.code,'RECOVERY_REQUIRED');assert.equal(r.recovery.state,'reserved');assert.equal(r.steps,undefined);assert.equal(r.totalSteps,3);assert.equal(restarted.resourceUsage().leases,0);
  }finally{await restarted.dispose();await journal.close();}
});
