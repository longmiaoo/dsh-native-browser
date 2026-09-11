import assert from 'node:assert/strict';
import test from 'node:test';
import {FrameSessions} from '../dist/packages/provider-chromium/src/frame-sessions.js';
import {readFrameGeometry,frameGeometryRequest} from '../dist/packages/provider-chromium/src/frame-geometry-read.js';
import {frameTargetGeometryFunction,frameBoundOwnerHitFunction,frameOwnerMetricsFunction} from '../dist/packages/provider-chromium/src/frame-geometry-functions.js';
import {frameClick,frameClickRequest} from '../dist/packages/provider-chromium/src/frame-click.js';
import {BrowserError} from '../dist/packages/contracts/src/index.js';
const signal=()=>new AbortController().signal,origin='https://example.test';
const request={binding:{frameId:'leaf',loaderId:'leaf-doc',contextUniqueId:'leaf-context',rootFrameId:'root',rootLoaderId:'root-doc'},backendNodeId:17};
async function fixture(){
  const leaf={frame:{id:'leaf',parentId:'parent',loaderId:'leaf-doc',url:origin+'/leaf'}},
    parent={frame:{id:'parent',parentId:'root',loaderId:'parent-doc',url:origin+'/parent'},childFrames:[leaf]},
    root={frame:{id:'root',loaderId:'root-doc',url:origin+'/'},childFrames:[parent]};
  const f={root,parent,leaf,calls:[],late:undefined,override:undefined,fatals:0};
  f.graph=new FrameSessions(async(session,method,params,s,gate)=>{
    await f.late?.(method,params);gate?.();f.calls.push({session,method,params});
    const override=await f.override?.(method,params,session);if(override!==undefined)return override;
    if(method==='Page.getFrameTree')return {frameTree:root};
    if(method==='Accessibility.getPartialAXTree')return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'}}]};
    if(method==='DOM.resolveNode')return {object:{objectId:'obj-'+params.backendNodeId+'-c'+params.executionContextId}};
    if(method==='DOM.getFrameOwner')return {backendNodeId:params.frameId==='leaf'?11:12};
    if(method==='DOM.getBoxModel')return {model:{content:params.objectId==='obj-11-c2'?[260,180,460,180,460,380,260,380]:[200,100,800,100,800,700,200,700]}};
    if(method==='Runtime.callFunctionOn'){
      if(params.functionDeclaration===frameTargetGeometryFunction)return {result:{value:{ok:params.objectId==='obj-17-c3',x:20,y:30,left:10,top:20,width:20,height:20}}};
      if(params.functionDeclaration===frameOwnerMetricsFunction)return {result:{value:params.objectId==='obj-11-c2'
        ?{viewport:{width:100,height:100},parentViewport:{width:300,height:300},scale:1}
        :{viewport:{width:300,height:300},parentViewport:{width:1000,height:800},scale:1}}};
      if(params.functionDeclaration===frameBoundOwnerHitFunction)return {result:{value:true}};
    }
    return {};
  },()=>f.fatals++);
  await f.graph.start(signal());
  for(const [index,id] of ['root','parent','leaf'].entries())f.graph.event('','Runtime.executionContextCreated',
    {context:{id:index+1,uniqueId:id+'-context',auxData:{isDefault:true,frameId:id}}});
  return f;
}
const cleanup=f=>f.calls.filter(c=>c.method==='Runtime.releaseObjectGroup');
test('source geometry binds each object in its ancestor context, hits the leaf and every owner, then releases one private group',async()=>{
  const f=await fixture(),result=await readFrameGeometry(f.graph,request,origin,signal());
  assert.deepEqual(result.local,{x:20,y:30});assert.equal(result.depth,2);
  assert.ok(Math.abs(result.point.x-300)<1e-6&&Math.abs(result.point.y-240)<1e-6);
  const resolutions=f.calls.filter(c=>c.method==='DOM.resolveNode');
  assert.deepEqual(resolutions.map(c=>[c.params.backendNodeId,c.params.executionContextId]),[[17,3],[11,2],[12,1]]);
  assert.equal(new Set(resolutions.map(c=>c.params.objectGroup)).size,1);assert.equal(cleanup(f).length,1);
  assert.equal(cleanup(f)[0].params.objectGroup,resolutions[0].params.objectGroup);
  assert.equal(f.calls.filter(c=>c.params.functionDeclaration===frameBoundOwnerHitFunction).length,4);
  assert.equal(f.calls.filter(c=>c.params.functionDeclaration===frameTargetGeometryFunction).length,2);
  assert.ok(f.calls.every(c=>!c.method.startsWith('Input.')));assert.doesNotMatch(JSON.stringify(result),/objectId|sessionId|context|obj-|private/);
  f.graph.dispose();
});
test('stale/foreign/incomplete ancestor authority fails before any DOM or geometry read',async()=>{
  for(const mode of ['loader','context','root','foreign','opaque','missing-context']){
    const f=await fixture(),raw=structuredClone(request);
    if(mode==='loader')raw.binding.loaderId='old';if(mode==='context')raw.binding.contextUniqueId='old';if(mode==='root')raw.binding.rootLoaderId='old';
    if(mode==='foreign')f.parent.frame.url='https://other.test/';if(mode==='opaque')f.parent.frame.url='about:blank';
    if(mode==='missing-context')f.graph.event('','Runtime.executionContextDestroyed',{executionContextId:2});
    await assert.rejects(readFrameGeometry(f.graph,raw,origin,signal()));
    assert.equal(f.calls.some(c=>c.method.startsWith('DOM.')||c.method==='Runtime.callFunctionOn'),false);f.graph.dispose();
  }
});
test('a node resolved in the requested context must actually belong to that document',async()=>{
  const f=await fixture();await assert.rejects(readFrameGeometry(f.graph,{...request,backendNodeId:99},origin,signal()),{code:'NOT_ACTIONABLE'});
  assert.equal(f.calls.some(c=>c.method==='DOM.getFrameOwner'),false);assert.equal(cleanup(f).length,1);f.graph.dispose();
});
test('foreign siblings do not widen reads or block an independently authorized same-origin ancestor chain',async()=>{
  const f=await fixture();f.root.childFrames.push({frame:{id:'foreign',parentId:'root',loaderId:'foreign-doc',url:'https://foreign.test/private'}});
  const result=await readFrameGeometry(f.graph,request,origin,signal());assert.equal(result.depth,2);
  assert.ok(f.calls.filter(c=>c.method==='DOM.getFrameOwner').every(c=>['leaf','parent'].includes(c.params.frameId)));f.graph.dispose();
});
test('same-origin but remote-session geometry is explicitly unsupported before any DOM read',async()=>{
  const f=await fixture();f.parent.childFrames=[];
  f.override=(method,_params,session)=>method==='Page.getFrameTree'&&session==='remote'?{frameTree:f.leaf}:undefined;
  f.graph.event('','Target.attachedToTarget',{sessionId:'remote',targetInfo:{type:'iframe'}});
  f.graph.event('remote','Runtime.executionContextCreated',{context:{id:3,uniqueId:'leaf-context',auxData:{isDefault:true,frameId:'leaf'}}});
  await assert.rejects(readFrameGeometry(f.graph,request,origin,signal()),{code:'UNSUPPORTED_CAPABILITY'});
  assert.equal(f.calls.some(c=>c.method.startsWith('DOM.')),false);f.graph.dispose();
});
test('navigation during async dispatch preparation sends no stale DOM resolution and still releases its group',async()=>{
  const f=await fixture();f.late=method=>{if(method==='DOM.resolveNode')f.graph.event('','Page.frameNavigated',{frame:{id:'leaf'}});};
  await assert.rejects(readFrameGeometry(f.graph,request,origin,signal()),{code:'STALE_TARGET'});
  assert.equal(f.calls.some(c=>c.method==='DOM.resolveNode'),false);assert.equal(cleanup(f).length,1);f.graph.dispose();
});
test('navigation, context change, cancellation and Stop during a read prevent further acquisition',async()=>{
  for(const mode of ['navigation','context','cancel','stop']){
    const f=await fixture(),controller=new AbortController();
    f.override=method=>{if(method==='DOM.resolveNode'){
      if(mode==='navigation')f.graph.event('','Page.frameNavigated',{frame:{id:'leaf'}});
      if(mode==='context')f.graph.event('','Runtime.executionContextCreated',{context:{id:3,uniqueId:'new-context',auxData:{isDefault:true,frameId:'leaf'}}});
      if(mode==='cancel')controller.abort();if(mode==='stop')f.graph.dispose();
    }};
    await assert.rejects(readFrameGeometry(f.graph,request,origin,controller.signal));
    assert.equal(f.calls.some(c=>c.method==='Runtime.callFunctionOn'),false);
    assert.equal(cleanup(f).length,mode==='stop'?0:1);f.graph.dispose();
  }
});
test('leaf movement, owner overlays and document change at final snapshot discard geometry and release handles',async()=>{
  for(const mode of ['leaf-move','overlay','final-document']){
    const f=await fixture();let reads=0,trees=0;
    f.override=(method,p)=>{
      if(mode==='leaf-move'&&p.functionDeclaration===frameTargetGeometryFunction&&++reads===2)
        return {result:{value:{ok:true,x:20,y:30,left:10.01,top:20,width:20,height:20}}};
      if(mode==='overlay'&&p.functionDeclaration===frameBoundOwnerHitFunction)return {result:{value:false}};
      if(mode==='final-document'&&method==='Page.getFrameTree'&&++trees===2)f.leaf.frame.loaderId='new-doc';
    };
    await assert.rejects(readFrameGeometry(f.graph,request,origin,signal()));assert.equal(cleanup(f).length,1);f.graph.dispose();
  }
});
test('failed object-group cleanup fails the graph closed instead of accumulating hidden handles',async()=>{
  const f=await fixture();f.override=method=>{if(method==='Runtime.releaseObjectGroup')throw Error('fixture cleanup failure');};
  await assert.rejects(readFrameGeometry(f.graph,request,origin,signal()));assert.equal(f.fatals,1);
  await assert.rejects(f.graph.snapshot(signal()),{code:'STALE_TARGET'});f.graph.dispose();
});
test('navigation or cancellation during object cleanup cannot publish an outgoing-document measurement',async()=>{
  for(const mode of ['navigation','cancel']){
    const f=await fixture(),controller=new AbortController();
    f.override=method=>{if(method==='Runtime.releaseObjectGroup'){
      if(mode==='navigation')f.leaf.frame.loaderId='next-doc';else controller.abort();
    }};
    await assert.rejects(readFrameGeometry(f.graph,request,origin,controller.signal));assert.equal(cleanup(f).length,1);f.graph.dispose();
  }
});
test('geometry scope rejects scripts, input, foreign groups and argument tricks; closing is idempotent',async()=>{
  const f=await fixture(),before=await f.graph.snapshot(signal()),scope=f.graph.openGeometryRead('',before.revision,signal());
  for(const [method,params] of [
    ['Input.dispatchMouseEvent',{type:'mousePressed',x:1,y:1}],['Runtime.evaluate',{expression:'document.body'}],
    ['DOM.resolveNode',{backendNodeId:17,executionContextId:3,objectGroup:'foreign'}],
    ['Runtime.callFunctionOn',{objectId:'obj',functionDeclaration:'function(){this.click()}',arguments:[],returnByValue:true}],
    ['Runtime.callFunctionOn',{objectId:'obj',functionDeclaration:frameBoundOwnerHitFunction,arguments:[{objectId:'foreign'}],returnByValue:true}],
    ['Runtime.releaseObjectGroup',{objectGroup:'foreign'}]
  ])await assert.rejects(scope.send(method,params),{code:'POLICY_DENIED'});
  await scope.close();await scope.close();assert.equal(cleanup(f).length,1);
  await assert.rejects(scope.send('DOM.getFrameOwner',{frameId:'leaf'}),{code:'STALE_TARGET'});f.graph.dispose();
});
test('geometry read scopes have explicit concurrency and call budgets',async()=>{
  const f=await fixture(),before=await f.graph.snapshot(signal()),scopes=[];
  for(let i=0;i<8;i++)scopes.push(f.graph.openGeometryRead('',before.revision,signal()));
  assert.throws(()=>f.graph.openGeometryRead('',before.revision,signal()),{code:'QUEUE_FULL'});
  for(let i=0;i<1024;i++)await scopes[0].send('DOM.getFrameOwner',{frameId:'leaf'});
  await assert.rejects(scopes[0].send('DOM.getFrameOwner',{frameId:'leaf'}),{code:'QUEUE_FULL'});
  for(const scope of scopes)await scope.close();const next=f.graph.openGeometryRead('',before.revision,signal());await next.close();f.graph.dispose();
});
test('wire geometry request admits only an exact document binding and positive backend identity',()=>{
  for(const extra of [{sessionId:'x'},{objectId:'x'},{point:{x:1,y:1}},{script:'anything'}])
    assert.throws(()=>frameGeometryRequest({...request,...extra}),{code:'INVALID_REQUEST'});
  for(const backendNodeId of [0,-1,1.2,'17',Infinity])assert.throws(()=>frameGeometryRequest({...request,backendNodeId}),{code:'INVALID_REQUEST'});
});
const clickRequest={...request,role:'button',name:'Child button'};
test('child click preparation is read-only; dispatch binds semantics and sends exactly one guarded pair before cleanup',async()=>{
  for(const dispatch of [false,true]){
    const f=await fixture();assert.deepEqual(await frameClick(f.graph,clickRequest,origin,signal(),dispatch),{acknowledged:dispatch});
    const input=f.calls.filter(c=>c.method==='Input.dispatchMouseEvent');assert.equal(input.length,dispatch?2:0);
    if(dispatch){assert.deepEqual(input.map(c=>c.params.type),['mousePressed','mouseReleased']);assert.ok(input.every(c=>c.session===''&&Math.abs(c.params.x-300)<1e-6&&Math.abs(c.params.y-240)<1e-6));}
    assert.equal(cleanup(f).length,1);f.graph.dispose();
  }
});
test('renamed, disabled, replaced or stale-semantic child targets cannot dispatch',async()=>{
  for(const mode of ['name','role','disabled','replaced','late-name']){
    const f=await fixture();let reads=0;
    f.override=method=>{if(method==='Accessibility.getPartialAXTree'){
      reads++;const n={backendDOMNodeId:mode==='replaced'?99:17,role:{value:mode==='role'?'link':'button'},name:{value:mode==='name'||mode==='late-name'&&reads===2?'Changed':'Child button'},
        properties:mode==='disabled'?[{name:'disabled',value:{value:true}}]:[]};return {nodes:[n]};
    }};
    await assert.rejects(frameClick(f.graph,clickRequest,origin,signal(),true));assert.equal(f.calls.some(c=>c.method.startsWith('Input.')),false);f.graph.dispose();
  }
});
test('frame change or Stop during final async input authority lookup sends no mouse down',async()=>{
  for(const mode of ['navigation','stop']){
    const f=await fixture();f.late=method=>{if(method==='Input.dispatchMouseEvent'){
      if(mode==='stop')f.graph.dispose();else f.graph.event('','Page.frameNavigated',{frame:{id:'leaf'}});
    }};
    await assert.rejects(frameClick(f.graph,clickRequest,origin,signal(),true));assert.equal(f.calls.some(c=>c.method.startsWith('Input.')),false);f.graph.dispose();
  }
});
test('loss or navigation after mouse down prevents a replay or further input',async()=>{
  for(const mode of ['loss','navigation']){
    const f=await fixture();f.override=(method,p)=>{if(method==='Input.dispatchMouseEvent'&&p.type==='mousePressed'){
      if(mode==='loss')throw new BrowserError('CONNECTION_LOST','fixture lost acknowledgement');
      f.graph.event('','Page.frameNavigated',{frame:{id:'leaf'}});
    }};
    await assert.rejects(frameClick(f.graph,clickRequest,origin,signal(),true));assert.equal(f.calls.filter(c=>c.method.startsWith('Input.')).length,1);f.graph.dispose();
  }
});
test('frame click input request cannot supply a point, session, script, object or non-control role',()=>{
  for(const extra of [{point:{x:1,y:1}},{sessionId:'other'},{objectId:'other'},{script:'click()'},{role:'region'}])
    assert.throws(()=>frameClickRequest({...clickRequest,...extra}),{code:'INVALID_REQUEST'});
});
