import assert from 'node:assert/strict';
import test from 'node:test';
import { AXPager, axPageLimits, axPageRequest } from '../dist/packages/provider-chromium/src/ax-pager.js';
const signal=()=>new AbortController().signal;
const node=(id,role='button',children=[])=>({nodeId:String(id),backendDOMNodeId:Number(id),role:{value:role},name:{value:'node-'+id},childIds:children.map(String)});
function fixture(count=450) {
  const all=new Map([['1',node(1,'RootWebArea',Array.from({length:count},(_,i)=>i+2))],...Array.from({length:count},(_,i)=>[String(i+2),node(i+2)])]);
  const calls=[];
  const send=async(method,params)=>{calls.push({method,params});
    if(method==='Accessibility.getRootAXNode')return {node:all.get('1')};
    if(method==='Accessibility.getPartialAXTree')return {nodes:[all.get(String(params.backendNodeId))].filter(Boolean)};
    assert.equal(method,'Accessibility.getChildAXNodes');return {nodes:all.get(params.id).childIds.map(id=>all.get(id))};};
  const pager=new AXPager();return {all,calls,send,pager,read:(continuation,root={frameId:'f'},binding='lease|doc')=>pager.read({...root,...(continuation?{continuation}:{})},binding,send,signal())};
}
test('AX windows exhaust a wide tree without duplicates and never transfer a full raw tree',async()=>{
  const f=fixture(4000),ids=[],pages=[];let continuation;
  do {const page=await f.read(continuation);pages.push(page);ids.push(...page.nodes.map(n=>n.backendDOMNodeId));continuation=page.page.continuation;
    assert.ok(page.nodes.length<=axPageLimits.nodes);assert.ok(page.acquisition.calls<=axPageLimits.calls);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<20*1024);assert.equal(page.page.incomplete,false);
  }while(continuation);
  assert.equal(ids.length,4001);assert.equal(new Set(ids).size,4001);assert.equal(pages.at(-1).truncated,false);
  assert.deepEqual(pages.map(p=>p.page.index),pages.map((_,i)=>i));assert.equal(f.pager.size,0);
  assert.equal(f.calls.some(c=>c.method.includes('FullAX')||c.method.includes('queryAX')),false);
});
test('tokens are single-use and bound to the exact lease/document/root',async()=>{
  const f=fixture(),first=await f.read(),token=first.page.continuation;
  await assert.rejects(f.read(token,{frameId:'f'},'foreign|doc'),{code:'STALE_TARGET'});
  await assert.rejects(f.read(token,{frameId:'f',backendNodeId:2}),{code:'STALE_TARGET'});
  const next=await f.read(token);assert.equal(next.page.index,1);
  await assert.rejects(f.read(token),{code:'STALE_TARGET'});assert.ok(next.page.continuation);
  f.pager.revoke('lease|');assert.equal(f.pager.size,0);await assert.rejects(f.read(next.page.continuation),{code:'STALE_TARGET'});
});
test('changed active child order and replaced roots invalidate rather than skip or rebind windows',async()=>{
  for(const change of ['order','root']){const f=fixture(),first=await f.read();
    if(change==='order')f.all.get('1').childIds.reverse();else f.all.get('1').nodeId='replacement';
    await assert.rejects(f.read(first.page.continuation),{code:'STALE_TARGET'});assert.equal(f.pager.size,0);
  }
});
test('windows re-read unvisited node content and do not retain text in continuations',async()=>{
  const f=fixture(),first=await f.read();f.all.get('150').name.value='fresh later content';
  const next=await f.read(first.page.continuation);assert.ok(next.nodes.some(n=>n.name.value==='fresh later content'));
  const retained=[...f.pager.walks.values()].map(w=>({...w,seen:[...w.seen]}));
  assert.equal(JSON.stringify(retained).includes('fresh later content'),false);assert.equal(JSON.stringify(retained).includes('node-'),false);
});
test('page boundaries retain pending nodes and honor named-region and UTF-8 budgets',async()=>{
  const f=fixture(60);for(const [id,n] of f.all)if(id!=='1'){n.role.value='region';n.name.value='区'.repeat(250);}
  const ids=[];let continuation;do{const p=await f.read(continuation);ids.push(...p.nodes.map(n=>n.backendDOMNodeId));
    assert.ok(p.nodes.filter(n=>n.role.value==='region').length<=24);assert.equal(p.page.incomplete,false);continuation=p.page.continuation;
  }while(continuation);assert.equal(ids.length,61);assert.equal(new Set(ids).size,61);
});
test('foreign frames and oversized text stay explicitly incomplete without leaking payloads',async()=>{
  const f=fixture(3);f.all.get('2').frameId='other';f.all.get('2').name.value='foreign secret';
  f.all.get('3').name.value='x'.repeat(20000);f.all.get('4').value={value:'password'};
  const p=await f.read();assert.equal(p.page.continuation,undefined);assert.equal(p.truncated,true);assert.equal(p.page.incomplete,true);
  assert.equal(JSON.stringify(p).includes('foreign secret'),false);assert.equal(JSON.stringify(p).includes('password'),false);
});
test('TTL is not renewed; context capacity fails without evicting existing readers',async()=>{
  let now=0;const f=fixture(),pager=new AXPager(()=>now);const read=continuation=>pager.read({frameId:'f',...(continuation?{continuation}:{})},'lease|doc',f.send,signal());
  const tokens=[];for(let i=0;i<8;i++)tokens.push((await read()).page.continuation);
  await assert.rejects(read(),{code:'QUEUE_FULL'});assert.equal(pager.size,8);
  now=100;const next=await read(tokens[0]);now=axPageLimits.ttlMs+1;
  await assert.rejects(read(next.page.continuation),{code:'STALE_TARGET'});assert.equal(pager.size,0);
});
test('Stop or cancellation during source acquisition never resurrects retained state',async()=>{
  for(const mode of ['stop','cancel']){const f=fixture(),controller=new AbortController();let calls=0;
    await assert.rejects(f.pager.read({frameId:'f'},'lease|doc',async(...args)=>{const result=await f.send(...args);if(++calls===2){if(mode==='stop')f.pager.revoke('lease|');else controller.abort();}return result;},controller.signal),
      {code:mode==='stop'?'LEASE_REVOKED':'CANCELLED'});assert.equal(f.pager.size,0);
  }
});
test('cycles, excessively wide siblings and forged raw options fail closed',async()=>{
  const f=fixture(2);f.all.get('2').childIds=['1'];await assert.rejects(f.read(),{code:'STALE_TARGET'});
  const wide=fixture(axPageLimits.children+1);await assert.rejects(wide.read(),{code:'QUEUE_FULL'});
  for(const raw of [{frameId:'f',offset:100},{frameId:'f',continuation:''},{frameId:'f',query:{}},null])assert.throws(()=>axPageRequest(raw),{code:'INVALID_REQUEST'});
});
