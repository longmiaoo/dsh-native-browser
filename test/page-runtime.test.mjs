import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
import { pageReadOptions } from '../dist/packages/contracts/src/validation.js';
import { clientRequirements, providerCapabilities } from '../dist/packages/contracts/src/wire.js';
const signal=()=>new AbortController().signal;
async function fixture(t){const runtime=new BrowserRuntime(async()=>true),provider=new FakeProvider();runtime.register(provider);t.after(()=>runtime.dispose());
  const lease=await runtime.claim('owner','fake-1','tab-1',signal());return {runtime,provider,lease};}
test('portable page seam requires provider support, strict options and negotiated capabilities',async t=>{
  const f=await fixture(t);await assert.rejects(f.runtime.readPage('owner',f.lease.id,{},signal()),{code:'UNSUPPORTED_CAPABILITY'});
  for(const options of [{cursor:'not-a-page'},{continuation:''},{rootRef:'x',query:{name:'x'}}])assert.throws(()=>pageReadOptions(options),{code:'INVALID_REQUEST'});
  assert.ok(clientRequirements.includes('runtime.page.v1'));assert.ok(providerCapabilities.includes('ax.page.v1'));
});
test('windows do not replace or poison whole-scope observation baselines',async t=>{
  const f=await fixture(t),before=await f.runtime.observe('owner',f.lease.id,signal());
  f.provider.readPage=async(lease,options,s)=>({...await f.provider.observe(lease,s),nodes:[],text:['window'],truncated:true,page:{index:0,incomplete:false,continuation:'next'}});
  const page=await f.runtime.readPage('owner',f.lease.id,{},signal());assert.equal(page.cursor,undefined);assert.equal(page.format,undefined);
  const current=await f.runtime.observe('owner',f.lease.id,signal(),{cursor:before.cursor});
  assert.equal(current.resyncRequired,false);assert.equal(current.nodes.remove?.length??0,0);
  page.text[0]='caller mutation';assert.equal((await f.runtime.readPage('owner',f.lease.id,{},signal())).text[0],'window');
});
test('page authority and post-read cancellation prevent foreign or late payload delivery',async t=>{
  const f=await fixture(t);let entered,finish;const started=new Promise(resolve=>entered=resolve);
  f.provider.readPage=async(lease,options,s)=>{const snapshot=await f.provider.observe(lease,s);entered();await new Promise(resolve=>finish=resolve);return {...snapshot,page:{index:0,incomplete:false}};};
  await assert.rejects(f.runtime.readPage('foreign',f.lease.id,{},signal()),{code:'LEASE_REVOKED'});
  const pending=f.runtime.readPage('owner',f.lease.id,{},signal());await started;const ending=f.runtime.release('owner',f.lease.id);finish();
  await assert.rejects(pending,{code:'LEASE_REVOKED'});await ending;
});
test('page result must match exact requested root, live origin and bounded metadata',async t=>{
  const f=await fixture(t),snapshot=await f.provider.observe(f.lease,signal());
  for(const override of [{scope:{kind:'subtree',rootRef:'wrong'}},{url:'https://foreign.test/'},{page:{index:-1,incomplete:false}},
    {page:{index:0,incomplete:'yes'}},{page:{index:0,incomplete:false,continuation:'x'.repeat(129)}},{text:['x'.repeat(100000)]},
    {nodes:[null]},{text:[null]},{page:{index:0,incomplete:true},truncated:false},{nodes:[{id:'duplicate',role:'button',name:'x'},{id:'duplicate',role:'button',name:'y'}]}]){
    f.provider.readPage=async()=>({...snapshot,page:{index:0,incomplete:false},...override});
    await assert.rejects(f.runtime.readPage('owner',f.lease.id,{},signal()));
  }
});
