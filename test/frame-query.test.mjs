import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameSessions } from '../dist/packages/provider-chromium/src/frame-sessions.js';
import { findFrameAX, frameFindRequest } from '../dist/packages/provider-chromium/src/frame-query.js';
import { hasFrameText, frameTextRequest } from '../dist/packages/provider-chromium/src/frame-text.js';
import { frameQueryDocumentFunction, frameQueryNodeFunction } from '../dist/packages/provider-chromium/src/frame-query-functions.js';
import { frameWithinRootFunction } from '../dist/packages/provider-chromium/src/frame-query-functions.js';
import { frameNodeRoot } from '../dist/packages/provider-chromium/src/frame-node-scope.js';
import { readFrameSubtree } from '../dist/packages/provider-chromium/src/frame-subtree.js';
import vm from 'node:vm';
const signal=()=>new AbortController().signal,origin='https://example.test';
const binding={frameId:'child',loaderId:'child-doc',contextUniqueId:'child-context',rootFrameId:'root',rootLoaderId:'root-doc'};
const query={name:'Exact child',role:'button'},request={binding,query};
async function fixture(remote=false){
 const child={frame:{id:'child',parentId:'root',loaderId:'child-doc',url:origin}},root={frame:{id:'root',loaderId:'root-doc',url:origin},childFrames:[child]};
 const f={calls:[],root,child,nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Exact child'},value:{value:'never-copy'}}]};
 const graph=new FrameSessions(async(session,method,p,s,gate)=>{
  await f.before?.(method,p);gate?.();f.calls.push({session,method,p});const override=await f.override?.(method,p);if(override!==undefined)return override;
  if(method==='Page.getFrameTree')return {frameTree:session?child:root};
  if(method==='Accessibility.getRootAXNode')return {node:{frameId:'child',backendDOMNodeId:1}};
  if(method==='DOM.resolveNode')return {object:{objectId:'object-'+p.backendNodeId}};
  if(method==='Runtime.callFunctionOn')return {result:{value:p.functionDeclaration===frameQueryDocumentFunction?p.objectId==='object-1':p.objectId!=='object-99'}};
  if(method==='Accessibility.getPartialAXTree')return {nodes:f.nodes.filter(n=>'object-'+n.backendDOMNodeId===p.objectId)};
  if(method==='Accessibility.queryAXTree')return {nodes:f.nodes};return {};
 });f.graph=graph;await graph.start(signal());if(remote)graph.event('','Target.attachedToTarget',{sessionId:'child-session',targetInfo:{type:'iframe'}});
 graph.event(remote?'child-session':'','Runtime.executionContextCreated',{context:{id:2,uniqueId:'child-context',auxData:{isDefault:true,frameId:'child'}}});await graph.snapshot(signal());return f;
}
test('child query uses a bound document root and filters candidate document ownership in the same-process and flat-session routes',async()=>{
 for(const remote of [false,true]){
  const f=await fixture(remote);f.nodes.push({...f.nodes[0],backendDOMNodeId:99},{...f.nodes[0],backendDOMNodeId:100,frameId:'nested'});
  const result=await findFrameAX(f.graph,request,origin,signal());assert.deepEqual(result.nodes.map(n=>n.backendDOMNodeId),[17]);assert.equal(result.truncated,true);
  assert.doesNotMatch(JSON.stringify(result),/never-copy|object-|session/);
  assert.equal(f.calls.filter(c=>c.method==='Accessibility.queryAXTree').length,1);
  assert.deepEqual(f.calls.find(c=>c.method==='Accessibility.queryAXTree').p,{backendNodeId:1,accessibleName:'Exact child',role:'button'});
  assert.ok(f.calls.filter(c=>c.method==='DOM.resolveNode').every(c=>c.p.executionContextId===2&&c.p.objectGroup.startsWith('dsh-frame-geometry-')));
  assert.ok(f.calls.filter(c=>c.method.startsWith('Accessibility.')).every(c=>c.session===(remote?'child-session':'')));
  assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);f.graph.dispose();
 }
});
test('child text evidence is a document-bound boolean and supports normalized substring matching',async()=>{
 for(const remote of [false,true]){
  const f=await fixture(remote);f.nodes=[{backendDOMNodeId:17,role:{value:'StaticText'},name:{value:'Status: Child   completed'},value:{value:'private'}},
    {backendDOMNodeId:99,role:{value:'StaticText'},name:{value:'Child completed'}}];
  const result=await hasFrameText(f.graph,{binding,text:'Child completed'},origin,signal());assert.deepEqual(result,{present:true});
  assert.doesNotMatch(JSON.stringify(result),/Status|private|object|session/);
  assert.deepEqual(f.calls.find(c=>c.method==='Accessibility.queryAXTree').p,{backendNodeId:1,accessibleName:'Child completed'});
  assert.equal(f.calls.filter(c=>c.method==='DOM.resolveNode').length,3);assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);
  f.graph.dispose();
 }
 const control=await fixture();control.nodes=[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child completed'}}];
 assert.deepEqual(await hasFrameText(control.graph,{binding,text:'Child completed'},origin,signal()),{present:false});control.graph.dispose();
});
test('child text evidence is bounded, rejects raw authority and fails closed on document change',async()=>{
 const f=await fixture();f.nodes=Array.from({length:1000},(_,i)=>({backendDOMNodeId:1000+i,role:{value:'StaticText'},name:{value:'Absent'}}));
 const result=await hasFrameText(f.graph,{binding,text:'Expected'},origin,signal());assert.deepEqual(result,{present:false});
 assert.equal(f.calls.filter(c=>c.method==='DOM.resolveNode').length,129);f.graph.dispose();
 for(const invalid of [{binding,text:' '},{binding,text:'x',sessionId:'raw'},{binding,text:'x'.repeat(1001)}])
  assert.throws(()=>frameTextRequest(invalid),{code:'INVALID_REQUEST'});
 const changed=await fixture();changed.override=method=>{if(method==='Accessibility.queryAXTree')changed.graph.event('','Page.frameNavigated',{frame:{id:'child'}});};
 await assert.rejects(hasFrameText(changed.graph,{binding,text:'Expected'},origin,signal()),{code:'STALE_TARGET'});changed.graph.dispose();
});
test('frame query cannot widen stale/foreign document authority or accept a wrong document root',async()=>{
 for(const mode of ['foreign','old-loader','wrong-root','wrong-object']){
  const f=await fixture(),raw=structuredClone(request);
  if(mode==='foreign')f.child.frame.url='https://foreign.test';if(mode==='old-loader')raw.binding.loaderId='old';
  f.override=(method,p)=>{
   if(mode==='wrong-root'&&method==='Accessibility.getRootAXNode')return {node:{frameId:'root',backendDOMNodeId:1}};
   if(mode==='wrong-object'&&method==='Runtime.callFunctionOn'&&p.functionDeclaration===frameQueryDocumentFunction)return {result:{value:false}};
  };
  await assert.rejects(findFrameAX(f.graph,raw,origin,signal()));assert.equal(f.calls.some(c=>c.method==='Accessibility.queryAXTree'),false);f.graph.dispose();
 }
});
test('frame query navigation at the final dispatch, result or cleanup boundary never publishes late data',async()=>{
 for(const mode of ['before','result','cleanup','stop']){
  const f=await fixture();f.before=method=>{if(mode==='before'&&method==='Accessibility.queryAXTree')f.graph.event('','Page.frameNavigated',{frame:{id:'child'}});};
  f.override=method=>{if((mode==='result'||mode==='stop')&&method==='Accessibility.queryAXTree'||mode==='cleanup'&&method==='Runtime.releaseObjectGroup'){
   if(mode==='stop')f.graph.dispose();else f.graph.event('','Page.frameNavigated',{frame:{id:'child'}});
  }};
  await assert.rejects(findFrameAX(f.graph,request,origin,signal()));if(mode==='before')assert.equal(f.calls.some(c=>c.method==='Accessibility.queryAXTree'),false);f.graph.dispose();
 }
});
test('candidate ownership work is capped at 128 and private groups are released',async()=>{
 const f=await fixture();f.nodes=Array.from({length:1000},(_,i)=>({...f.nodes[0],backendDOMNodeId:1000+i}));
 const result=await findFrameAX(f.graph,request,origin,signal());assert.equal(result.nodes.length,128);assert.equal(result.truncated,true);
 assert.equal(f.calls.filter(c=>c.method==='DOM.resolveNode').length,129);assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);f.graph.dispose();
});
test('candidate AX identity is bound to the resolved object and a changed name cannot inherit query membership',async()=>{
 const f=await fixture();f.override=(method,p)=>{if(method==='Accessibility.getPartialAXTree'){
  assert.deepEqual(p,{objectId:'object-17',fetchRelatives:false});return {nodes:[{...f.nodes[0],name:{value:'Changed'}}]};
 }};
 await assert.rejects(findFrameAX(f.graph,request,origin,signal()),{code:'STALE_TARGET'});
 assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);f.graph.dispose();
});
test('query object scope rejects input, geometry, arbitrary code and caller groups, sharing the global scope budget',async()=>{
 const f=await fixture(),revision=(await f.graph.snapshot(signal())).revision,scope=f.graph.openQueryRead('',revision,signal());
 for(const [method,p]of [['Input.insertText',{text:'bad'}],['Runtime.evaluate',{expression:'document'}],['DOM.getFrameOwner',{frameId:'child'}],
  ['DOM.resolveNode',{backendNodeId:1,executionContextId:2,objectGroup:'caller'}],['Accessibility.queryAXTree',{backendNodeId:1,accessibleName:'Exact child',script:'bad'}],
  ['Runtime.callFunctionOn',{objectId:'o',functionDeclaration:'function(){return 1;}',arguments:[],returnByValue:true}]])await assert.rejects(scope.send(method,p),{code:'POLICY_DENIED'});
 const scopes=Array.from({length:7},()=>f.graph.openGeometryRead('',revision,signal()));assert.throws(()=>f.graph.openQueryRead('',revision,signal()),{code:'QUEUE_FULL'});
 await scope.close();for(const s of scopes)await s.close();f.graph.dispose();
});
test('frame query wire shape rejects caller backend/session/context overrides and nonliteral filters',()=>{
 for(const extra of [{backendNodeId:1},{sessionId:'x'},{rootRef:'x'},{expression:'document'}])assert.throws(()=>frameFindRequest({...request,...extra}),{code:'INVALID_REQUEST'});
 assert.throws(()=>frameFindRequest({...request,query:{name:'x',regex:true}}),{code:'INVALID_REQUEST'});
 assert.equal(frameQueryNodeFunction.includes('ownerDocument===document'),true);
});

async function scopedFixture(){
 const f=await fixture();f.scopeRoot={backendNodeId:20,role:'region',name:'Exact region',editable:false};
 const region={nodeId:'region',backendDOMNodeId:20,role:{value:'region'},name:{value:'Exact region'},childIds:['control','text','outside']};
 const control={...f.nodes[0],nodeId:'control',childIds:[]},text={nodeId:'text',backendDOMNodeId:21,role:{value:'StaticText'},name:{value:'Local text'},childIds:[]};
 const outside={...control,nodeId:'outside',backendDOMNodeId:99};f.nodes=[region,control,text,outside];
 f.override=(method,p)=>{
  if(method==='Accessibility.queryAXTree'){assert.equal(p.backendNodeId,20);return {nodes:[control,outside]};}
  if(method==='Accessibility.getChildAXNodes'){assert.deepEqual(p,{id:'region',frameId:'child'});return {nodes:[control,text,outside]};}
 };
 return f;
}
test('bound child subtree and contextual query filter outside nodes and keep exact root semantics',async()=>{
 const f=await scopedFixture(),request={binding,root:f.scopeRoot};
 const subtree=await readFrameSubtree(f.graph,request,origin,signal());assert.deepEqual(subtree.nodes.map(n=>n.backendDOMNodeId),[20,17,21]);assert.equal(subtree.truncated,true);
 const found=await findFrameAX(f.graph,{...request,query},origin,signal());assert.deepEqual(found.nodes.map(n=>n.backendDOMNodeId),[17]);
 assert.ok(f.calls.filter(c=>c.p.functionDeclaration===frameWithinRootFunction).every(c=>c.p.arguments[0].objectId==='object-20'));
 assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,2);f.graph.dispose();
});
test('child roots renamed, detached, retyped or changed during traversal never widen or publish',async()=>{
 for(const mode of ['name','role','detached','late','editable']){
  const f=await scopedFixture(),base=f.override;let seen=false;
  f.override=(method,p)=>{
   if(method==='Accessibility.getChildAXNodes')seen=true;
   if(method==='Runtime.callFunctionOn'&&p.objectId==='object-20'&&p.functionDeclaration===frameQueryNodeFunction&&mode==='detached')return {result:{value:false}};
   if(method==='Accessibility.getPartialAXTree'&&p.objectId==='object-20'){
    const node=structuredClone(f.nodes[0]);if(mode==='name'||mode==='late'&&seen)node.name.value='changed';if(mode==='role')node.role.value='button';
    return {nodes:[node]};
   }
   return base(method,p);
  };
  await assert.rejects(readFrameSubtree(f.graph,{binding,root:{...f.scopeRoot,editable:mode==='editable'}},origin,signal()),{code:'STALE_TARGET'});
  if(mode!=='late')assert.equal(f.calls.some(c=>c.method==='Accessibility.getChildAXNodes'),false);
  assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);f.graph.dispose();
 }
});
test('composed subtree membership includes shadow/slot paths but rejects other documents, outside nodes and cycles',()=>{
 const document={isConnected:true},root={isConnected:true,ownerDocument:document,parentNode:document};
 const fn=vm.runInNewContext('('+frameWithinRootFunction+')',{document});
 const node={isConnected:true,ownerDocument:document,parentNode:root};assert.equal(fn.call(node,root),true);assert.equal(fn.call(root,root),true);
 const shadow={nodeType:11,host:root},slot={parentNode:shadow};assert.equal(fn.call({...node,parentNode:shadow},root),true);
 assert.equal(fn.call({...node,parentNode:document,assignedSlot:slot},root),true);
 assert.equal(fn.call({...node,parentNode:document},root),false);assert.equal(fn.call({...node,ownerDocument:{}},root),false);
 const cycle={...node};cycle.parentNode=cycle;assert.equal(fn.call(cycle,root),false);
});
test('bound child root schemas permit only cached semantic identity and reject raw runtime authority',()=>{
 const root={backendNodeId:20,role:'region',name:'Exact region',editable:false};assert.deepEqual(frameNodeRoot(root),root);
 for(const extra of [{objectId:'raw'},{sessionId:'raw'},{expression:'script'},{frameId:'other'}])assert.throws(()=>frameNodeRoot({...root,...extra}));
 for(const invalid of [{...root,backendNodeId:0},{...root,editable:'yes'},{...root,name:'x'.repeat(1001)}])assert.throws(()=>frameNodeRoot(invalid));
});
test('child subtree ownership verification caps at 256 projected nodes without expanding the source call budget',async()=>{
 const f=await scopedFixture(),children=Array.from({length:300},(_,i)=>({nodeId:'c'+i,backendDOMNodeId:1000+i,role:{value:'button'},name:{value:'Local '+i},childIds:[]}));
 const root={...f.nodes[0],childIds:children.map(n=>n.nodeId)};f.nodes=[root,...children];
 f.override=method=>method==='Accessibility.getChildAXNodes'?{nodes:children}:undefined;
 const result=await readFrameSubtree(f.graph,{binding,root:f.scopeRoot},origin,signal());assert.equal(result.nodes.length,256);assert.equal(result.truncated,true);
 assert.equal(f.calls.filter(c=>c.method==='DOM.resolveNode').length,258);assert.ok(f.calls.length<1024);
 assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);f.graph.dispose();
});
