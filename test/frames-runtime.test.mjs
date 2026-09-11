import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
import { frameInventory } from '../dist/packages/contracts/src/frames.js';
import { observeOptions, sameScope } from '../dist/packages/contracts/src/validation.js';
import { applyObservationUpdate } from '../dist/packages/contracts/src/observations.js';
const signal = () => new AbortController().signal;
const inventory = lease => ({ tab: lease.tab, documentEpoch: 'root-doc', truncated: false, frames: [
  { id: 'root', isMain: true, origin: lease.origin, documentEpoch: 'root-doc', contextStatus: 'known' },
  { id: 'child', parentId: 'root', isMain: false, origin: 'https://foreign.test', documentEpoch: 'child-doc', contextStatus: 'known' },
  { id: 'opaque', parentId: 'child', isMain: false, contextStatus: 'unavailable' }] });
test('frame-query scopes include filters and frame identity and never reuse whole-frame or root-query bases',async t=>{
 const f=await fixture(t),frame={frameId:'child',documentEpoch:'child-doc'},query={name:'Exact',role:'button'};let disabled=false;
 f.provider.frames=async lease=>{const graph=inventory(lease);graph.frames[1].origin=lease.origin;return graph;};
 f.provider.findFrame=async(lease,target,q,s)=>({...await f.provider.observe(lease,s),documentEpoch:target.documentEpoch,
  scope:{kind:'query',frameId:target.frameId,query:q},nodes:Array.from({length:20},(_,i)=>({id:'c-'+i,role:'button',name:q.name,disabled:i===0&&disabled})),text:[]});
 f.provider.find=async()=>{throw Error('no root fallback');};
 const first=await f.runtime.observe('owner',f.lease.id,signal(),{frame,query});disabled=true;
 const delta=await f.runtime.observe('owner',f.lease.id,signal(),{frame,query,cursor:first.cursor});assert.equal(delta.format,'delta');assert.equal(applyObservationUpdate(first,delta).nodes[0].disabled,true);
 assert.equal((await f.runtime.observe('owner',f.lease.id,signal(),{frame,query:{name:'Another'},cursor:first.cursor})).resyncRequired,true);
 assert.equal(sameScope(first.scope,{kind:'query',query}),false);assert.equal(sameScope(first.scope,{...first.scope,frameId:'another'}),false);
 assert.deepEqual(observeOptions({frame,query}),{frame,query});
});
test('frame query is optional, never falls back, and revalidates frame authority after the provider read',async t=>{
 const f=await fixture(t),frame={frameId:'child',documentEpoch:'child-doc'},query={name:'Exact'};let foreign=false;
 f.provider.frames=async lease=>{const graph=inventory(lease);graph.frames[1].origin=foreign?'https://foreign.test':lease.origin;return graph;};
 f.provider.find=async()=>{throw Error('root fallback');};await assert.rejects(f.runtime.observe('owner',f.lease.id,signal(),{frame,query}),{code:'UNSUPPORTED_CAPABILITY'});
 for(const mode of ['origin','scope','epoch']){
  foreign=false;f.provider.findFrame=async(lease,target,q,s)=>{if(mode==='origin')foreign=true;return {...await f.provider.observe(lease,s),
   documentEpoch:mode==='epoch'?'wrong':target.documentEpoch,scope:mode==='scope'?{kind:'query',query:q}:{kind:'query',query:q,frameId:target.frameId}};};
  await assert.rejects(f.runtime.observe('owner',f.lease.id,signal(),{frame,query}));
 }
});
async function fixture(t) {
  const operations = [], runtime = new BrowserRuntime(async request => { operations.push(request.operation); return true; }), provider = new FakeProvider();
  runtime.register(provider); t.after(() => runtime.dispose());
  const lease = await runtime.claim('owner', 'fake-1', 'tab-1', signal()); return { runtime, provider, lease, operations };
}
test('child subtree and contextual-query scopes route optional seams without root fallback or cursor mixing',async t=>{
 const f=await fixture(t),frame={frameId:'child',documentEpoch:'child-doc'},rootRef='region',query={name:'Exact'};
 f.provider.frames=async lease=>{const graph=inventory(lease);graph.frames[1].origin=lease.origin;return graph;};
 await assert.rejects(f.runtime.observe('owner',f.lease.id,signal(),{frame,rootRef}),{code:'UNSUPPORTED_CAPABILITY'});
 f.provider.observeSubtree=async()=>{throw Error('must not use root seam');};
 f.provider.observeFrameSubtree=async(l,target,root,s)=>({...await f.provider.observe(l,s),documentEpoch:target.documentEpoch,
  scope:{kind:'subtree',frameId:target.frameId,rootRef:root},nodes:Array.from({length:20},(_,i)=>({id:'n'+i,role:'button',name:'Exact'}))});
 f.provider.findFrame=async(l,target,q,s,root)=>({...await f.provider.observeFrameSubtree(l,target,root,s),scope:{kind:'query',frameId:target.frameId,rootRef:root,query:q}});
 const first=await f.runtime.observe('owner',f.lease.id,signal(),{frame,rootRef});assert.deepEqual(first.scope,{kind:'subtree',frameId:'child',rootRef});
 const delta=await f.runtime.observe('owner',f.lease.id,signal(),{frame,rootRef,cursor:first.cursor});assert.equal(delta.format,'delta');assert.deepEqual(applyObservationUpdate(first,delta).scope,first.scope);
 assert.equal((await f.runtime.observe('owner',f.lease.id,signal(),{frame,rootRef:'other',cursor:first.cursor})).resyncRequired,true);
 const found=await f.runtime.observe('owner',f.lease.id,signal(),{frame,rootRef,query,cursor:first.cursor});assert.equal(found.resyncRequired,true);
 assert.deepEqual(found.scope,{kind:'query',frameId:'child',rootRef,query});assert.equal(sameScope(first.scope,{kind:'subtree',rootRef}),false);
});
test('frame observations preserve independent portable scopes and exact-base delta reconstruction',async t=>{
  const f=await fixture(t),frame={frameId:'child',documentEpoch:'child-doc'};let content='before';
  f.provider.frames=async lease=>{const graph=inventory(lease);graph.frames[1].origin=lease.origin;return graph;};
  f.provider.observeFrame=async(lease,target,s)=>({...await f.provider.observe(lease,s),documentEpoch:target.documentEpoch,
    scope:{kind:'frame',frameId:target.frameId},text:[content],nodes:Array.from({length:15},(_,i)=>({id:'child-'+i,role:'button',name:'Child control '+i}))});
  const root=await f.runtime.observe('owner',f.lease.id,signal()),first=await f.runtime.observe('owner',f.lease.id,signal(),{frame});
  content='after';const delta=await f.runtime.observe('owner',f.lease.id,signal(),{frame,cursor:first.cursor});assert.equal(delta.format,'delta');
  assert.deepEqual(applyObservationUpdate(first,delta).text,['after']);assert.throws(()=>applyObservationUpdate(root,delta));
  assert.equal((await f.runtime.observe('owner',f.lease.id,signal(),{cursor:root.cursor})).resyncRequired,false);
  assert.equal((await f.runtime.observe('owner',f.lease.id,signal(),{frame,cursor:root.cursor})).resyncRequired,true);
  assert.equal(sameScope({kind:'frame',frameId:'a'},{kind:'frame',frameId:'b'}),false);
});
test('frame content policy rejects stale, main, foreign, opaque and foreign-ancestor scopes before provider read',async t=>{
  const f=await fixture(t);let reads=0;f.provider.observeFrame=async()=>{reads++;throw Error('must not read');};
  for(const mode of ['stale','main','foreign','opaque','ancestor','incomplete','context']){
    const graph=inventory(f.lease);graph.frames[1].origin=f.lease.origin;
    const frame={frameId:'child',documentEpoch:'child-doc'};
    if(mode==='stale')frame.documentEpoch='old';if(mode==='main'){frame.frameId='root';frame.documentEpoch='root-doc';}
    if(mode==='foreign')graph.frames[1].origin='https://foreign.test';if(mode==='opaque')delete graph.frames[1].origin;
    if(mode==='context')graph.frames[1].contextStatus='unavailable';if(mode==='incomplete')graph.truncated=true;
    if(mode==='ancestor'){graph.frames[1].origin='https://foreign.test';Object.assign(graph.frames[2],{origin:f.lease.origin,documentEpoch:'inner',contextStatus:'known'});frame.frameId='opaque';frame.documentEpoch='inner';}
    f.provider.frames=async()=>graph;await assert.rejects(f.runtime.observe('owner',f.lease.id,signal(),{frame}));
  }
  assert.equal(reads,0);
  for(const options of [{frame:{frameId:'x'}},{frame:{frameId:'x',documentEpoch:'d',sessionId:'raw'}},
    {frame:{frameId:'x',documentEpoch:'d'},query:{name:'x',regex:true}},{frame:{frameId:'x',documentEpoch:'d'},rootRef:123}])
    assert.throws(()=>observeOptions(options),{code:'INVALID_REQUEST'});
});
test('frame response cannot change document/scope or publish after lease revocation',async t=>{
  const f=await fixture(t),frame={frameId:'child',documentEpoch:'child-doc'};
  f.provider.frames=async lease=>{const graph=inventory(lease);graph.frames[1].origin=lease.origin;return graph;};
  for(const mode of ['document','scope','stop']){
    f.provider.observeFrame=async(lease,target,s)=>{const o=await f.provider.observe(lease,s);
      if(mode==='stop')void f.runtime.release('owner',lease.id);
      return {...o,documentEpoch:mode==='document'?'wrong':target.documentEpoch,scope:mode==='scope'?{kind:'document'}:{kind:'frame',frameId:target.frameId}};};
    await assert.rejects(f.runtime.observe('owner',f.lease.id,signal(),{frame}));
  }
});
test('portable frames are optional and require current owner/read authority without poisoning observation baselines', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.frames('owner', f.lease.id, signal()), { code: 'UNSUPPORTED_CAPABILITY' });
  const before = await f.runtime.observe('owner', f.lease.id, signal()); f.provider.frames = async lease => inventory(lease);
  await assert.rejects(f.runtime.frames('foreign', f.lease.id, signal()), { code: 'LEASE_REVOKED' });
  const result = await f.runtime.frames('owner', f.lease.id, signal());
  assert.deepEqual(result.frames.map(frame => frame.originRelation), ['same-origin', 'cross-origin', 'opaque']);
  assert.equal(f.operations.at(-1), 'observe'); assert.equal(result.cursor, undefined);
  const after = await f.runtime.observe('owner', f.lease.id, signal(), { cursor: before.cursor }); assert.equal(after.resyncRequired, false);
});
test('portable inventory strips provider-private content and rejects URLs, cycles, orphan and invalid roots', () => {
  const lease = { tab: 'tab', origin: 'https://example.test' }, raw = inventory(lease);
  raw.url = 'secret'; raw.frames[1].sessionId = 'private-session'; raw.frames[1].context = { id: 1 }; raw.frames[1].title = 'private-title';
  raw.frames[1].originRelation = 'same-origin';
  const clean = frameInventory(raw, lease); assert.doesNotMatch(JSON.stringify(clean), /secret|private|sessionId/);
  assert.equal(clean.frames[1].originRelation, 'cross-origin'); clean.frames[1].id = 'mutated'; assert.equal(raw.frames[1].id, 'child');
  for (const change of [r => r.frames.push(null), r => r.frames.push(r.frames[0]), r => r.frames[1].parentId = 'missing',
    r => r.frames[1].parentId = 'opaque', r => r.frames[1].isMain = true, r => r.frames[0].parentId = 'child',
    r => r.frames[0].origin = 'https://foreign.test', r => r.frames[0].documentEpoch = 'different',
    r => r.frames[1].origin = 'https://foreign.test/private?secret', r => r.frames[1].contextStatus = 'trusted',
    r => r.frames[1].documentEpoch = 'x'.repeat(513), r => r.frames = [], r => r.truncated = 'true']) {
    const candidate = inventory(lease); change(candidate); assert.throws(() => frameInventory(candidate, lease));
  }
});
test('revocation while discovery is pending suppresses late frame metadata', async t => {
  const f = await fixture(t); let finish, entered; const started = new Promise(resolve => entered = resolve);
  f.provider.frames = async lease => { entered(); await new Promise(resolve => finish = resolve); return inventory(lease); };
  const pending = f.runtime.frames('owner', f.lease.id, signal()); await started;
  const end = f.runtime.release('owner', f.lease.id); finish(); await assert.rejects(pending, { code: 'LEASE_REVOKED' }); await end;
});
