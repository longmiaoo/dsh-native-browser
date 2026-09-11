import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameSessions } from '../dist/packages/provider-chromium/src/frame-sessions.js';
import { readFrameAX, frameReadBinding } from '../dist/packages/provider-chromium/src/frame-read.js';
const signal=()=>new AbortController().signal,origin='https://example.test';
const binding={frameId:'child',loaderId:'child-doc',contextUniqueId:'child-context',rootFrameId:'root',rootLoaderId:'root-doc'};
const tree=(id,parentId,children=[])=>({frame:{id,parentId,loaderId:id+'-doc',url:origin+'/private',securityOrigin:origin},childFrames:children});
async function fixture(remote=false){
  const root=tree('root',undefined,[tree('child','root')]),child=root.childFrames[0],calls=[];
  const f={root,child,calls,override:undefined,lateGate:undefined};
  const graph=new FrameSessions(async(session,method,params,s,gate)=>{
    await f.lateGate?.(session,method);gate?.();
    calls.push({session,method,params});const override=await f.override?.(session,method,params);if(override!==undefined)return override;
    if(method==='Page.getFrameTree')return {frameTree:session?child:root};
    if(method==='Accessibility.getRootAXNode')return {node:{nodeId:'ax-root',backendDOMNodeId:1,frameId:'child',role:{value:'RootWebArea'},name:{value:'Child title'},childIds:['text','button','nested']}};
    if(method==='Accessibility.getChildAXNodes')return {nodes:[
      {nodeId:'text',role:{value:'StaticText'},name:{value:'Child reading text'},childIds:[]},
      {nodeId:'button',backendDOMNodeId:17,role:{value:'button'},name:{value:'Child control'},value:{value:'private value'},childIds:[]},
      {nodeId:'nested',role:{value:'Iframe'},name:{value:'Nested boundary'},childIds:['foreign-secret']}]};
    return {};
  });f.graph=graph;
  await graph.start(signal());
  if(remote)graph.event('','Target.attachedToTarget',{sessionId:'remote',targetInfo:{type:'iframe'}});
  graph.event(remote?'remote':'','Runtime.executionContextCreated',{context:{id:7,uniqueId:'child-context',auxData:{isDefault:true,frameId:'child'}}});
  await graph.snapshot(signal());return f;
}
test('bounded frame AX chooses the live same-process or flat-session route and stops at nested frame boundaries',async()=>{
  for(const remote of [false,true]){
    const f=await fixture(remote),result=await readFrameAX(f.graph,binding,origin,signal());
    assert.ok(result.nodes.some(n=>n.name?.value==='Child reading text'));assert.equal(result.truncated,true);
    assert.doesNotMatch(JSON.stringify(result),/foreign-secret|private value/);
    const reads=f.calls.filter(c=>c.method.startsWith('Accessibility.'));assert.ok(reads.length>=3);
    assert.ok(reads.every(c=>c.session===(remote?'remote':'')));
    assert.ok(reads.filter(c=>c.method!=='Accessibility.enable').every(c=>c.params.frameId==='child'));
    f.graph.dispose();
  }
});
test('source rejects foreign/opaque ancestors, incomplete coverage and stale binding before any AX command',async()=>{
  for(const mode of ['foreign','opaque','ancestor','loader','context','root','truncated']){
    const f=await fixture();const request={...binding};
    if(mode==='foreign')f.child.frame.securityOrigin='https://foreign.test';
    if(mode==='opaque')f.child.frame.securityOrigin='://';
    if(mode==='ancestor')f.root.frame.securityOrigin='https://foreign.test';
    if(mode==='loader')request.loaderId='old';if(mode==='context')request.contextUniqueId='old';if(mode==='root')request.rootLoaderId='old';
    if(mode==='truncated')for(let i=0;i<300;i++)f.root.childFrames.push(tree('more'+i,'root'));
    await assert.rejects(readFrameAX(f.graph,request,origin,signal()));
    assert.equal(f.calls.filter(c=>c.method.startsWith('Accessibility.')).length,0);f.graph.dispose();
  }
});
test('last-mile revision guard prevents a read when navigation occurs during asynchronous lease lookup',async()=>{
  const f=await fixture();f.lateGate=(_session,method)=>{if(method==='Accessibility.getRootAXNode')f.graph.event('','Page.frameNavigated',{frame:{id:'child'}});};
  await assert.rejects(readFrameAX(f.graph,binding,origin,signal()),{code:'STALE_TARGET'});
  assert.equal(f.calls.some(c=>c.method==='Accessibility.getRootAXNode'),false);f.graph.dispose();
});
test('navigation, context replacement or Stop during AX response discards data and dispatches no next child read',async()=>{
  for(const mode of ['navigation','context','stop']){
    const f=await fixture();f.override=(_session,method)=>{
      if(method==='Accessibility.getRootAXNode'){
        if(mode==='navigation')f.graph.event('','Page.frameNavigated',{frame:{id:'child'}});
        if(mode==='context')f.graph.event('','Runtime.executionContextCreated',{context:{id:7,uniqueId:'successor',auxData:{isDefault:true,frameId:'child'}}});
        if(mode==='stop')f.graph.dispose();
      }
    };await assert.rejects(readFrameAX(f.graph,binding,origin,signal()));
    assert.equal(f.calls.some(c=>c.method==='Accessibility.getChildAXNodes'),false);f.graph.dispose();
  }
});
test('source frame binding accepts no backend/session selector, script or invented optional fields',()=>{
  for(const extra of [{sessionId:'remote'},{backendNodeId:1},{expression:'document.body'},{includeChildren:true}])
    assert.throws(()=>frameReadBinding({...binding,...extra}),{code:'INVALID_REQUEST'});
  for(const key of Object.keys(binding)){const raw={...binding};delete raw[key];assert.throws(()=>frameReadBinding(raw),{code:'INVALID_REQUEST'});}
});
