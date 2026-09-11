import assert from 'node:assert/strict';
import test from 'node:test';
import {BrowserRuntime} from '../dist/packages/runtime-core/src/runtime.js';
import {BrowserError} from '../dist/packages/contracts/src/index.js';
import {actionRequest,batchRequest} from '../dist/packages/contracts/src/validation.js';
import {FakeProvider} from './helpers/fake-provider.mjs';
const signal=()=>new AbortController().signal,frame={frameId:'child',documentEpoch:'child-doc'};
async function fixture(t){
  const f={calls:0,policy:undefined,after:undefined,origin:'https://example.test',scope:{kind:'frame',frameId:'child'},epoch:'child-doc'};
  f.runtime=new BrowserRuntime(async request=>await f.policy?.(request)??true);f.provider=new FakeProvider();
  f.provider.frames=async lease=>({tab:lease.tab,documentEpoch:'root-doc',truncated:false,frames:[
    {id:'root',isMain:true,documentEpoch:'root-doc',origin:lease.origin,contextStatus:'known'},
    {id:'child',parentId:'root',isMain:false,documentEpoch:'child-doc',origin:f.origin,contextStatus:'known'}]});
  f.provider.actFrame=async(lease,request,execution)=>{f.calls++;execution.onDispatch();f.received=structuredClone(request);await f.after?.();
    return {observation:{...await f.provider.observe(lease,execution.signal),documentEpoch:f.epoch,scope:f.scope,text:['Child result']},postcondition:'passed'};};
  f.runtime.register(f.provider);t.after(()=>f.runtime.dispose());f.lease=await f.runtime.claim('owner','fake-1','tab-1',signal());
  f.request={requestId:'frame-click',leaseId:f.lease.id,documentEpoch:frame.documentEpoch,frame,action:{kind:'click',ref:'child-node',expected:{kind:'text',text:'Child result'}}};
  f.act=(request=f.request)=>f.runtime.act('owner',request,signal());return f;
}
test('frame click contract preserves explicit scope and refuses mixed epochs/actions/expectations or batch smuggling',()=>{
  const raw={requestId:'a',leaseId:'l',documentEpoch:frame.documentEpoch,frame,action:{kind:'click',ref:'r'}};
  assert.deepEqual(actionRequest(raw).frame,frame);
  for(const change of [{documentEpoch:'root-doc'},{frame:{...frame,sessionId:'raw'}},{action:{kind:'fill',ref:'r',text:'x'}},
    ...['value','url','state'].map(kind=>({action:{kind:'click',ref:'r',expected:{kind,value:'x',url:'https://example.test/',ref:'r',state:'visible'}}})),
    {action:{kind:'click',ref:'r',frame}}])assert.throws(()=>actionRequest({...raw,...change}),{code:'INVALID_REQUEST'});
  assert.throws(()=>batchRequest({requestId:'b',leaseId:'l',documentEpoch:'d',steps:[{action:{kind:'click',ref:'r'},frame}]}),{code:'INVALID_REQUEST'});
});
test('portable frame action seam retains child scope and deduplicates without invoking root actions',async t=>{
  const f=await fixture(t),first=await f.act();assert.equal(first.outcome,'succeeded');assert.equal(first.observation.documentEpoch,'child-doc');
  assert.deepEqual(first.observation.scope,{kind:'frame',frameId:'child'});assert.deepEqual(await f.act(),first);
  assert.equal(f.calls,1);assert.equal(f.provider.calls.length,0);
  assert.throws(()=>f.act({...f.request,frame:{...frame,frameId:'other'}}),{code:'REQUEST_ID_CONFLICT'});
});
test('action policy sees an independent frame scope and cannot mutate the frozen request',async t=>{
  const f=await fixture(t);let seen;
  f.policy=request=>{if(request.operation==='act'){seen=structuredClone(request.frame);request.frame.frameId='wrong';request.action.ref='wrong';}return true;};
  assert.equal((await f.act()).outcome,'succeeded');assert.deepEqual(seen,frame);assert.deepEqual(f.received.frame,frame);assert.equal(f.received.action.ref,'child-node');
});
test('denied, stale or unsupported child authority never falls back to root provider act',async t=>{
  for(const mode of ['denied','late-foreign','stale','unsupported']){
    const f=await fixture(t);
    if(mode==='denied')f.policy=r=>r.operation!=='act';
    if(mode==='late-foreign')f.policy=r=>{if(r.operation==='act')f.origin='https://foreign.test';return true;};
    if(mode==='stale')f.request={...f.request,frame:{...frame,documentEpoch:'old'},documentEpoch:'old'};
    if(mode==='unsupported')delete f.provider.actFrame;
    const result=await f.act();assert.equal(result.dispatch,'notDispatched');assert.notEqual(result.outcome,'succeeded');assert.equal(f.calls,0);assert.equal(f.provider.calls.length,0);
  }
});
test('post-dispatch wrong scope/document, foreign ancestry and loss stay unknown with no payload or replay',async t=>{
  for(const mode of ['scope','epoch','foreign','loss']){
    const f=await fixture(t);
    if(mode==='scope')f.scope={kind:'document'};if(mode==='epoch')f.epoch='new';
    if(mode==='foreign')f.after=()=>{f.origin='https://foreign.test';};
    if(mode==='loss')f.after=()=>{throw new BrowserError('CONNECTION_LOST','lost input response');};
    const result=await f.act();assert.equal(result.outcome,'unknown');assert.equal(result.observation,undefined);
    assert.deepEqual(await f.act(),result);assert.equal(f.calls,1);
  }
});
