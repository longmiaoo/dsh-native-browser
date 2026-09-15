import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameSessions } from '../dist/packages/provider-chromium/src/frame-sessions.js';
import { AXPager } from '../dist/packages/provider-chromium/src/ax-pager.js';
import { readFramePage, framePageRequest } from '../dist/packages/provider-chromium/src/frame-page.js';
import { frameQueryDocumentFunction } from '../dist/packages/provider-chromium/src/frame-query-functions.js';
const signal=()=>new AbortController().signal,origin='https://example.test';
const binding={frameId:'child',loaderId:'child-doc',contextUniqueId:'context',rootFrameId:'root',rootLoaderId:'root-doc'};
const node=(id,role,children=[])=>({nodeId:String(id),backendDOMNodeId:id,role:{value:role},name:{value:'Name '+id},childIds:children.map(String)});
async function fixture(remote=false){
 const children=Array.from({length:450},(_,i)=>node(i+3,'button'));
 const region=node(2,'region',children.map(n=>n.backendDOMNodeId)),doc={...node(1,'RootWebArea',[2]),frameId:'child'};
 const f={calls:[],nodes:new Map([doc,region,...children].map(n=>[n.backendDOMNodeId,n])),root:{backendNodeId:2,role:'region',name:'Name 2',editable:false}};
 const child={frame:{id:'child',parentId:'root',loaderId:'child-doc',url:origin}},root={frame:{id:'root',loaderId:'root-doc',url:origin},childFrames:[child]};
 f.graph=new FrameSessions(async(session,method,p,s,gate)=>{
  await f.before?.(method,p);gate?.();f.calls.push({session,method,p});const override=await f.override?.(method,p);if(override!==undefined)return override;
  if(method==='Page.getFrameTree')return {frameTree:session?child:root};
  if(method==='Accessibility.getRootAXNode')return {node:doc};
  if(method==='Accessibility.getPartialAXTree')return {nodes:[f.nodes.get(Number(p.objectId.split('-')[1]))].filter(Boolean)};
  if(method==='Accessibility.getChildAXNodes')return {nodes:f.nodes.get(Number(p.id)).childIds.map(id=>f.nodes.get(Number(id)))};
  if(method==='DOM.resolveNode')return {object:{objectId:'o-'+p.backendNodeId}};
  if(method==='Runtime.callFunctionOn')return {result:{value:p.functionDeclaration===frameQueryDocumentFunction?p.objectId==='o-1':p.objectId!=='o-1'}};
  return {};
 });await f.graph.start(signal());if(remote)f.graph.event('','Target.attachedToTarget',{sessionId:'child-session',targetInfo:{type:'iframe'}});
 f.graph.event(remote?'child-session':'','Runtime.executionContextCreated',{context:{id:2,uniqueId:'context',auxData:{isDefault:true,frameId:'child'}}});
 f.pager=new AXPager();f.read=(continuation,root=f.root,lease='lease')=>readFramePage(f.graph,{binding,...(root?{root}:{}),...(continuation?{continuation}:{})},origin,signal(),f.pager,lease);
 return f;
}
test('child windows exhaust exact region/document through bound objects and share the global pager',async()=>{
 for(const remote of [false,true])for(const scoped of [false,true]){
  const f=await fixture(remote),ids=[];let next;do{const p=await f.read(next,scoped?f.root:null);ids.push(...p.nodes.map(n=>n.backendDOMNodeId));
   assert.equal(p.page.incomplete,false);next=p.page.continuation;assert.ok(p.nodes.length<=100);assert.ok(p.acquisition.calls<=128);
  }while(next);
  assert.equal(ids.length,scoped?451:452);assert.equal(new Set(ids).size,ids.length);assert.equal(f.pager.size,0);
  assert.ok(f.calls.filter(c=>c.method==='Accessibility.getPartialAXTree').every(c=>c.p.objectId&&!c.p.backendNodeId));
  assert.ok(f.calls.filter(c=>c.method.startsWith('Accessibility.')).every(c=>c.session===(remote?'child-session':'')));
  assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,5);f.graph.dispose();
 }
});
test('child tokens cannot change lease, root, scope or context; valid tokens stay single-use',async()=>{
 const f=await fixture(),first=await f.read(),token=first.page.continuation;
 await assert.rejects(f.read(token,null),{code:'STALE_TARGET'});await assert.rejects(f.read(token,f.root,'another'),{code:'STALE_TARGET'});
 await assert.rejects(readFramePage(f.graph,{binding:{...binding,contextUniqueId:'old'},root:f.root,continuation:token},origin,signal(),f.pager,'lease'),{code:'STALE_TARGET'});
 const next=await f.read(token);assert.equal(next.page.index,1);await assert.rejects(f.read(token),{code:'STALE_TARGET'});
 f.pager.revoke('lease|');assert.equal(f.pager.size,0);await assert.rejects(f.read(next.page.continuation));f.graph.dispose();
});
test('ownership omissions remain incomplete on the final child window',async()=>{
 const f=await fixture();f.override=(method,p)=>method==='Runtime.callFunctionOn'&&p.objectId==='o-3'?{result:{value:false}}:undefined;
 let next,last;do{last=await f.read(next);assert.equal(last.page.incomplete,true);assert.ok(!last.nodes.some(n=>n.backendDOMNodeId===3));next=last.page.continuation;}while(next);
 assert.equal(last.truncated,true);assert.equal(f.pager.size,0);f.graph.dispose();
});
test('post-acquisition root, cleanup and graph failures discard only the newly created continuation',async()=>{
 for(const mode of ['root','cleanup','graph','stop','identity']){
  const f=await fixture(),other=(await f.read()).page.continuation;let rootChecks=0;
  f.override=(method,p)=>{
   if(mode==='root'&&method==='Runtime.callFunctionOn'&&p.objectId==='o-2'&&++rootChecks===3)return {result:{value:false}};
   if(mode==='identity'&&method==='Accessibility.getPartialAXTree'&&p.objectId==='o-3')return {nodes:[{...f.nodes.get(3),name:{value:'changed'}}]};
   if(method==='Runtime.releaseObjectGroup'){
    if(mode==='cleanup')throw Error('cleanup unavailable');
    if(mode==='graph')f.graph.event('','Page.frameNavigated',{frame:{id:'child'}});
    if(mode==='stop')f.pager.revoke('lease|');
   }
  };
  await assert.rejects(f.read());if(mode==='stop')assert.equal(f.pager.size,0);else{assert.equal(f.pager.size,1);assert.ok(f.pager.walks.has(other));}
  f.graph.dispose();
 }
});
test('frame page schema rejects caller transport/runtime authority and shared capacity stays at eight',async()=>{
 for(const extra of [{sessionId:'raw'},{backendNodeId:1},{objectId:'o-1'},{query:{name:'x'}},{continuation:''}])assert.throws(()=>framePageRequest({binding,...extra}),{code:'INVALID_REQUEST'});
 const f=await fixture();for(let i=0;i<8;i++)await f.read();await assert.rejects(f.read(),{code:'QUEUE_FULL'});assert.equal(f.pager.size,8);f.graph.dispose();
});
