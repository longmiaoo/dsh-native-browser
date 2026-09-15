import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { keyEvent } from '../dist/packages/provider-chromium/src/keyboard.js';
import { wheelEvent } from '../dist/packages/provider-chromium/src/mouse.js';
import { brokerCapabilities, personalBrokerCapability } from '../dist/packages/contracts/src/wire.js';
import { frameTargetGeometryFunction, frameBoundOwnerHitFunction, frameOwnerMetricsFunction } from '../dist/packages/provider-chromium/src/frame-geometry-functions.js';
import { frameQueryDocumentFunction, frameQueryNodeFunction, frameWithinRootFunction } from '../dist/packages/provider-chromium/src/frame-query-functions.js';
const source = await readFile(new URL('../dist/extension/chrome/background.js', import.meta.url), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });

test('built extension declares presentation scripting on HTTP(S) pages for the cross-site virtual pointer', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dist/extension/chrome/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts, [{ matches: ['http://*/*', 'https://*/*'], js: ['pointer.js'], run_at: 'document_start', all_frames: false }]);
});

async function fixture({ handshake = true, timers = { setTimeout, clearTimeout } } = {}) {
  const responses = new Map(), sent = [], commands = [], scripts = [], tabMessages = [];
  const tab = { id: 7, url: 'https://example.test/form', title: 'Fixture' };
  const ports = [];
  const makePort = () => {
    const p = { onMessage: event(), onDisconnect: event(), disconnected: false,
      postMessage(m) { if (this.disconnected) throw new Error('Port closed'); sent.push(m); if (m.type === 'response') responses.get(m.id)?.(m); },
      disconnect() { this.disconnected = true; },
      remoteDisconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
    ports.push(p); return p;
  };
  const chrome = { runtime: { id: 'a'.repeat(32), onMessage: event(), getURL: s => `chrome-extension://${'a'.repeat(32)}/${s}`, connectNative: makePort },
    tabs: { query: async () => [tab], get: async () => ({ ...tab }),
      sendMessage: async (_id, message) => { tabMessages.push(message); return true; }, onRemoved: event(), onUpdated: event() },
    scripting: { executeScript: async details => { scripts.push(details); return []; } },
    debugger: { attach: async () => {}, detach: async source => { chrome.debugger.onDetach.emit(source); },
      sendCommand: async (_target, method, params) => { commands.push({ method, params }); return {}; }, onDetach: event(), onEvent: event() } };
  vm.runInNewContext(source, { chrome, crypto: webcrypto, navigator: { userAgent: 'Chrome fixture' },
    URL, TextEncoder, AbortController, AbortSignal, structuredClone, ...timers, console });
  const ui = command => new Promise(resolve => chrome.runtime.onMessage.listeners[0]({ command },
    { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }, resolve));
  await ui('allow');
  const port = ports.at(-1);
  const hello = sent.find(m => m.method === 'hello');
  const welcome = (p = ports.at(-1), value = { version: 1, connectionEpoch: 'fixture-connection', capabilities: [...brokerCapabilities] }) =>
    p.onMessage.emit({ type: 'response', id: sent.filter(m => m.method === 'hello').at(-1).id, ok: true, value });
  if (handshake) welcome();
  const instanceId = hello.params.instance.id;
  const lease = { id: 'lease', owner: 'owner', tab: `${instanceId}:7`, instanceId, token: 'token',
    origin: 'https://example.test', expiresAt: Date.now() + 100000 };
  let counter = 0;
  const call = (method, params) => new Promise(resolve => {
    const id = `r-${++counter}`; responses.set(id, resolve);
    ports.at(-1).onMessage.emit({ type: 'request', id, method, params });
  });
  return { chrome, port, ports, welcome, hello, ui, call, lease, commands, scripts, tabMessages, tab, sent };
}

test('personal Broker handshake discovers ordinary tabs and grants tab leases without popup consent', async () => {
  const f = await fixture({ handshake: false });
  f.welcome(f.port, { version: 1, connectionEpoch: 'personal',
    capabilities: [...brokerCapabilities, personalBrokerCapability] });
  const tabs = await f.call('tabs.list', {});
  assert.equal(tabs.ok, true); assert.equal(tabs.value[0].title, 'Fixture');
  const lease = { ...f.lease, scope: 'tab' };
  assert.equal((await f.call('lease.grant', { lease })).ok, true);
});

test('page traversal is lease-gated and navigation revokes retained continuations', async () => {
  const f=await fixture();
  assert.equal((await f.call('ax.page',{lease:f.lease,request:{frameId:'frame'}})).ok,false);
  await f.call('lease.grant',{lease:f.lease});let loader='loader';
  const root={nodeId:'1',backendDOMNodeId:1,role:{value:'RootWebArea'},name:{value:''},childIds:Array.from({length:140},(_,i)=>String(i+2))};
  f.chrome.debugger.sendCommand=async(_target,method)=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame',loaderId:loader,url:f.tab.url}}};
    if(method==='Accessibility.getRootAXNode')return {node:root};
    if(method==='Accessibility.getChildAXNodes')return {nodes:root.childIds.map(id=>({nodeId:id,backendDOMNodeId:Number(id),role:{value:'button'},name:{value:'Button '+id},childIds:[]}))};
    return {};
  };
  const first=await f.call('ax.page',{lease:f.lease,request:{frameId:'frame'}});assert.equal(first.ok,true);assert.ok(first.value.page.continuation);
  f.chrome.debugger.onEvent.emit({tabId:7},'Page.frameNavigated',{frame:{id:'frame'}});loader='next';
  const old=await f.call('ax.page',{lease:f.lease,request:{frameId:'frame',continuation:first.value.page.continuation}});
  assert.equal(old.ok,false);assert.equal(old.code,'STALE_TARGET');
  assert.equal((await f.call('ax.page',{lease:f.lease,request:{frameId:'foreign'}})).code,'POLICY_DENIED');
  await f.ui('stop');
});

test('frame discovery is lazy, lease-gated and flat child sessions cannot become public raw CDP authority', async () => {
  const f=await fixture();assert.equal((await f.call('frames.list',{lease:f.lease})).ok,false);
  await f.call('lease.grant',{lease:f.lease});assert.equal(f.commands.some(c=>c.method==='Target.setAutoAttach'),false);
  const routes=[];
  f.chrome.debugger.sendCommand=async(target,method)=>{
    routes.push({target,method});const session=target.sessionId??'';
    if(method==='Runtime.enable')f.chrome.debugger.onEvent.emit(target,'Runtime.executionContextCreated',
      {context:{id:1,uniqueId:session||'root',auxData:{isDefault:true,frameId:session?'child':'root'}}});
    if(method==='Target.setAutoAttach'&&!session)f.chrome.debugger.onEvent.emit(target,'Target.attachedToTarget',
      {sessionId:'child-session',targetInfo:{type:'iframe',targetId:'not-a-frame'}});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:session?'child':'root',...(session?{parentId:'root'}:{}),
      loaderId:session||'root-loader',url:session?'https://foreign.test/private?secret':f.tab.url}}};
    return {};
  };
  const result=await f.call('frames.list',{lease:f.lease});assert.equal(result.ok,true);assert.equal(result.value.frames.length,2);
  assert.equal(result.value.frames[1].sessionId,'child-session');assert.doesNotMatch(JSON.stringify(result.value),/private|secret/);
  assert.ok(routes.some(c=>c.target.sessionId==='child-session'&&c.method==='Target.setAutoAttach'));
  assert.equal((await f.call('frames.list',{lease:f.lease,includeText:true})).code,'INVALID_REQUEST');
  assert.equal((await f.call('cdp',{lease:f.lease,sessionId:'child-session',method:'Runtime.enable',params:{}})).ok,false);
  await f.ui('stop');const count=routes.length;assert.equal((await f.call('frames.list',{lease:f.lease})).ok,false);assert.equal(routes.length,count);
});

test('partial frame initialization failure revokes the gate and detaches without queue deadlock', async () => {
  const f=await fixture();await f.call('lease.grant',{lease:f.lease});
  f.chrome.debugger.sendCommand=async(_target,method)=>{if(method==='Target.setAutoAttach')throw Error('setup failed');return {};};
  assert.equal((await f.call('frames.list',{lease:f.lease})).ok,false);
  assert.equal((await f.ui('status')).controlled,false);
  assert.equal((await f.call('frames.list',{lease:f.lease})).code,'LEASE_REVOKED');await f.ui('stop');
});

test('screenshot last-mile gate discovers hidden OOPIFs even before an explicit inventory', async () => {
  const f=await fixture();await f.call('lease.grant',{lease:f.lease});let captures=0;
  f.chrome.debugger.sendCommand=async(target,method)=>{
    if(method==='Target.setAutoAttach'&&!target.sessionId)f.chrome.debugger.onEvent.emit(target,'Target.attachedToTarget',
      {sessionId:'remote',targetInfo:{type:'iframe'}});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:target.sessionId?'child':'root',
      ...(target.sessionId?{parentId:'root'}:{}),loaderId:'loader',url:target.sessionId?'https://foreign.test/private':f.tab.url}}};
    if(method==='Page.captureScreenshot'){captures++;return {data:'must-not-return'};}return {};
  };
  const response=await f.call('cdp',{lease:f.lease,method:'Page.captureScreenshot',params:{format:'jpeg'}});
  assert.equal(response.code,'POLICY_DENIED');assert.equal(captures,0);await f.ui('stop');
});
test('frame churn during screenshot discards pixels even when final tree looks unchanged', async () => {
  const f=await fixture();await f.call('lease.grant',{lease:f.lease});
  f.chrome.debugger.sendCommand=async(target,method)=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'root',loaderId:'loader',url:f.tab.url}}};
    if(method==='Page.captureScreenshot'){
      f.chrome.debugger.onEvent.emit(target,'Page.frameAttached',{frameId:'transient',parentFrameId:'root'});
      f.chrome.debugger.onEvent.emit(target,'Page.frameDetached',{frameId:'transient',reason:'remove'});
      return {data:'discard-pixels'};
    }return {};
  };
  const response=await f.call('cdp',{lease:f.lease,method:'Page.captureScreenshot',params:{format:'jpeg'}});
  assert.equal(response.code,'STALE_TARGET');assert.equal(response.value,undefined);await f.ui('stop');
});

test('frame AX final dispatch rechecks topology after the asynchronous tab authority lookup',async()=>{
  const f=await fixture();await f.call('lease.grant',{lease:f.lease});let enabled=false,reads=0;
  f.chrome.debugger.sendCommand=async(target,method)=>{
    if(method==='Runtime.enable')f.chrome.debugger.onEvent.emit(target,'Runtime.executionContextCreated',
      {context:{id:2,uniqueId:'child-context',auxData:{isDefault:true,frameId:'child'}}});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'root',loaderId:'root-doc',url:f.tab.url},childFrames:[
      {frame:{id:'child',parentId:'root',loaderId:'child-doc',url:f.tab.url}}]}};
    if(method==='Accessibility.enable')enabled=true;
    if(method==='Accessibility.getRootAXNode')reads++;
    return {};
  };
  f.chrome.tabs.get=async()=>{if(enabled){enabled=false;f.chrome.debugger.onEvent.emit({tabId:7},'Page.frameNavigated',{frame:{id:'child',parentId:'root'}});}return {...f.tab};};
  const result=await f.call('ax.frame',{lease:f.lease,binding:{frameId:'child',loaderId:'child-doc',contextUniqueId:'child-context',rootFrameId:'root',rootLoaderId:'root-doc'}});
  assert.equal(result.code,'STALE_TARGET');assert.equal(reads,0);await f.ui('stop');
});
test('frame AX does not expose arbitrary session selection and actual Stop discards a pending source result',async()=>{
  const f=await fixture();await f.call('lease.grant',{lease:f.lease});let finish,entered;
  const started=new Promise(resolve=>entered=resolve),binding={frameId:'child',loaderId:'child-doc',contextUniqueId:'child-context',rootFrameId:'root',rootLoaderId:'root-doc'};
  assert.equal((await f.call('ax.frame',{lease:f.lease,binding:{...binding,sessionId:'raw'}})).code,'INVALID_REQUEST');
  f.chrome.debugger.sendCommand=async(target,method)=>{
    if(method==='Runtime.enable')f.chrome.debugger.onEvent.emit(target,'Runtime.executionContextCreated',
      {context:{id:2,uniqueId:'child-context',auxData:{isDefault:true,frameId:'child'}}});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'root',loaderId:'root-doc',url:f.tab.url},childFrames:[
      {frame:{id:'child',parentId:'root',loaderId:'child-doc',url:f.tab.url}}]}};
    if(method==='Accessibility.getRootAXNode'){entered();return new Promise(resolve=>finish=()=>resolve({node:{nodeId:'1',role:{value:'StaticText'},name:{value:'must discard'}}}));}
    return {};
  };
  const pending=f.call('ax.frame',{lease:f.lease,binding});await started;const stopped=f.ui('stop');
  await new Promise(resolve=>setImmediate(resolve));finish();const result=await pending;assert.equal(result.ok,false);assert.equal(result.value,undefined);await stopped;
});

async function geometryFixture(){
  const f=await fixture();
  f.request={binding:{frameId:'child',loaderId:'child-doc',contextUniqueId:'child-context',rootFrameId:'root',rootLoaderId:'root-doc'},backendNodeId:17};
  f.geometryCalls=[];
  f.chrome.debugger.sendCommand=async(target,method,p={})=>{
    f.geometryCalls.push({target,method,p});const override=await f.geometryOverride?.(method,p);if(override!==undefined)return override;
    if(method==='Runtime.enable')for(const [index,id] of ['root','child'].entries())f.chrome.debugger.onEvent.emit(target,'Runtime.executionContextCreated',
      {context:{id:index+1,uniqueId:id+'-context',auxData:{isDefault:true,frameId:id}}});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'root',loaderId:'root-doc',url:f.tab.url},childFrames:[
      {frame:{id:'child',parentId:'root',loaderId:'child-doc',url:f.tab.url}}]}};
    if(method==='DOM.resolveNode')return {object:{objectId:'obj-'+p.backendNodeId+'-c'+p.executionContextId}};
    if(method==='DOM.getFrameOwner')return {backendNodeId:11};
    if(method==='DOM.getBoxModel')return {model:{content:[200,100,300,100,300,200,200,200]}};
    if(method==='Accessibility.getPartialAXTree')return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'}}]};
    if(p.functionDeclaration===frameTargetGeometryFunction)return {result:{value:{ok:p.objectId==='obj-17-c2',x:20,y:30,left:10,top:20,width:20,height:20}}};
    if(p.functionDeclaration===frameBoundOwnerHitFunction)return {result:{value:true}};
    if(p.functionDeclaration===frameOwnerMetricsFunction)return {result:{value:{viewport:{width:100,height:100},parentViewport:{width:1000,height:800},scale:1}}};
    return {};
  };
  return f;
}
test('extension child-click commands bind semantic target, refuse coordinate injection and use a single guarded input pair',async()=>{
  const f=await geometryFixture(),request={...f.request,role:'button',name:'Child button'},params={lease:f.lease,request};
  assert.equal((await f.call('frame.click',params)).code,'LEASE_REVOKED');await f.call('lease.grant',{lease:f.lease});
  assert.equal((await f.call('frame.click',{...params,request:{...request,point:{x:1,y:1}}})).code,'INVALID_REQUEST');
  const ready=await f.call('frame.click.prepare',params);assert.equal(ready.ok,true,JSON.stringify(ready));assert.equal(ready.value.acknowledged,false);
  assert.equal(f.geometryCalls.some(c=>c.method.startsWith('Input.')),false);
  const result=await f.call('frame.click',params);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.acknowledged,true);
  const input=f.geometryCalls.filter(c=>c.method.startsWith('Input.'));assert.deepEqual(input.map(c=>c.p.type),['mousePressed','mouseReleased']);
  assert.ok(input.every(c=>c.target.sessionId===undefined&&Math.abs(c.p.x-220)<1e-6&&Math.abs(c.p.y-130)<1e-6));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.stringify(f.tabMessages), JSON.stringify([
    {type:'dsh.pointer.v1',action:'show',x:220,y:130,phase:'move'},
    {type:'dsh.pointer.v1',action:'show',x:220,y:130,phase:'click'},
  ]));
  assert.equal(f.geometryCalls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,2);
  await f.ui('stop');assert.equal((await f.call('frame.click',params)).code,'LEASE_REVOKED');
});
test('extension frame query has exact lease/schema gates, fixed document-root acquisition and no input',async()=>{
  const f=await geometryFixture(),request={binding:f.request.binding,query:{name:'Child button',role:'button'}},params={lease:f.lease,request};
  assert.equal((await f.call('ax.frame.find',params)).code,'LEASE_REVOKED');await f.call('lease.grant',{lease:f.lease});
  assert.equal((await f.call('ax.frame.find',{...params,request:{...request,backendNodeId:1}})).code,'INVALID_REQUEST');
  f.geometryOverride=(method,p)=>{
    if(method==='Accessibility.getRootAXNode')return {node:{frameId:'child',backendDOMNodeId:1}};
    if(method==='Accessibility.queryAXTree')return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'}}]};
    if(p.functionDeclaration===frameQueryDocumentFunction)return {result:{value:p.objectId==='obj-1-c2'}};
    if(p.functionDeclaration===frameQueryNodeFunction)return {result:{value:p.objectId==='obj-17-c2'}};
  };
  const result=await f.call('ax.frame.find',params);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.nodes.length,1);
  assert.equal(f.geometryCalls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);assert.equal(f.geometryCalls.some(c=>c.method.startsWith('Input.')),false);
  await f.ui('stop');assert.equal((await f.call('ax.frame.find',params)).code,'LEASE_REVOKED');
});
test('extension child text evidence returns only a bounded boolean under the same source fence',async()=>{
  const f=await geometryFixture(),params={lease:f.lease,request:{binding:f.request.binding,text:'Child completed'}};
  assert.equal((await f.call('ax.frame.text',params)).code,'LEASE_REVOKED');await f.call('lease.grant',{lease:f.lease});
  assert.equal((await f.call('ax.frame.text',{...params,request:{...params.request,objectId:'raw'}})).code,'INVALID_REQUEST');
  f.geometryOverride=(method,p)=>{
    if(method==='Accessibility.getRootAXNode')return {node:{frameId:'child',backendDOMNodeId:1}};
    if(method==='Accessibility.queryAXTree')return {nodes:[{backendDOMNodeId:19,role:{value:'StaticText'},name:{value:'Status: Child completed'}}]};
    if(method==='Accessibility.getPartialAXTree')return {nodes:[{backendDOMNodeId:19,role:{value:'StaticText'},name:{value:'Status: Child completed'}}]};
    if(p.functionDeclaration===frameQueryDocumentFunction)return {result:{value:p.objectId==='obj-1-c2'}};
    if(p.functionDeclaration===frameQueryNodeFunction)return {result:{value:p.objectId==='obj-19-c2'}};
  };
  const result=await f.call('ax.frame.text',params);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.present,true);assert.deepEqual(Object.keys(result.value),['present']);
  assert.equal(f.geometryCalls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);assert.equal(f.geometryCalls.some(c=>c.method.startsWith('Input.')),false);
  await f.ui('stop');assert.equal((await f.call('ax.frame.text',params)).code,'LEASE_REVOKED');
});
test('extension child subtree reads only its semantically bound root under the source lease and fixed function gate',async()=>{
 const f=await geometryFixture(),params={lease:f.lease,request:{binding:f.request.binding,root:{backendNodeId:17,role:'button',name:'Child button',editable:false}}};
 assert.equal((await f.call('ax.frame.subtree',params)).code,'LEASE_REVOKED');await f.call('lease.grant',{lease:f.lease});
 f.geometryOverride=(method,p)=>{
  if(method==='Accessibility.getRootAXNode')return {node:{frameId:'child',backendDOMNodeId:1}};
  if(method==='Accessibility.getPartialAXTree')return {nodes:[{nodeId:'button',backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'},childIds:[]}]};
  if([frameQueryDocumentFunction,frameQueryNodeFunction,frameWithinRootFunction].includes(p.functionDeclaration))return {result:{value:true}};
 };
 const result=await f.call('ax.frame.subtree',params);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.nodes.length,1);
 assert.equal((await f.call('ax.frame.subtree',{...params,request:{...params.request,root:{...params.request.root,sessionId:'raw'}}})).code,'INVALID_REQUEST');
 assert.equal(f.geometryCalls.some(c=>c.method.startsWith('Input.')),false);await f.ui('stop');
});
test('extension child-click loses authority between down and up without replaying down or claiming acknowledgement',async()=>{
  const f=await geometryFixture();await f.call('lease.grant',{lease:f.lease});
  f.geometryOverride=(method,p)=>{if(method==='Input.dispatchMouseEvent'&&p.type==='mousePressed')
    f.chrome.debugger.onEvent.emit({tabId:7},'Page.frameNavigated',{frame:{id:'child'}});};
  const result=await f.call('frame.click',{lease:f.lease,request:{...f.request,role:'button',name:'Child button'}});
  assert.equal(result.ok,false);assert.equal(result.value,undefined);assert.equal(f.geometryCalls.filter(c=>c.method.startsWith('Input.')).length,1);
  await f.ui('stop');
});
test('extension bound geometry is lease-gated, read-only, fixed-schema and cleaned up before reply',async()=>{
  const f=await geometryFixture(),params={lease:f.lease,request:f.request};
  assert.equal((await f.call('frame.geometry',params)).code,'LEASE_REVOKED');assert.equal(f.geometryCalls.length,0);
  await f.call('lease.grant',{lease:f.lease});
  assert.equal((await f.call('frame.geometry',{...params,script:'anything'})).code,'INVALID_REQUEST');
  const result=await f.call('frame.geometry',params);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.depth,1);assert.ok(Math.abs(result.value.point.x-220)<1e-6&&Math.abs(result.value.point.y-130)<1e-6);
  assert.ok(f.geometryCalls.some(c=>c.method==='Runtime.releaseObjectGroup'));
  assert.ok(f.geometryCalls.every(c=>!c.method.startsWith('Input.')));assert.doesNotMatch(JSON.stringify(result.value),/objectId|sessionId|context/);
  await f.ui('stop');assert.equal((await f.call('frame.geometry',params)).code,'LEASE_REVOKED');
});
test('extension frame geometry repeats the context fence after async authority lookup',async()=>{
  const f=await geometryFixture();await f.call('lease.grant',{lease:f.lease});let ready=false,lookups=0;
  f.geometryOverride=method=>{if(method==='DOM.getFrameOwner'){ready=true;lookups=0;}};
  f.chrome.tabs.get=async()=>{
    // First lookup is the getFrameOwner response guard, second precedes the
    // owner resolution whose source revision must now reject the operation.
    if(ready&&++lookups===2){ready=false;f.chrome.debugger.onEvent.emit({tabId:7},'Page.frameNavigated',{frame:{id:'child'}});}
    return {...f.tab};
  };
  const result=await f.call('frame.geometry',{lease:f.lease,request:f.request});assert.equal(result.code,'STALE_TARGET');
  assert.equal(f.geometryCalls.filter(c=>c.method==='DOM.resolveNode').length,1);
  assert.equal(f.geometryCalls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);await f.ui('stop');
});
test('actual extension Stop during bound object resolution discards the pending geometry without further reads',async()=>{
  const f=await geometryFixture();await f.call('lease.grant',{lease:f.lease});let entered,finish;
  const started=new Promise(resolve=>entered=resolve);
  f.geometryOverride=method=>{if(method==='DOM.resolveNode'){entered();return new Promise(resolve=>finish=()=>resolve({object:{objectId:'late-object'}}));}};
  const pending=f.call('frame.geometry',{lease:f.lease,request:f.request});await started;
  const stopped=f.ui('stop');await new Promise(resolve=>setImmediate(resolve));finish();
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.value,undefined);
  assert.equal(f.geometryCalls.some(c=>c.method==='Runtime.callFunctionOn'),false);await stopped;
});

test('extension never dispatches a command before a valid welcome', async () => {
  const f = await fixture({ handshake: false });
  f.port.onMessage.emit({ type: 'request', id: 'early', method: 'lease.grant', params: { lease: f.lease } });
  assert.equal(f.port.disconnected, true);
  assert.equal(f.commands.length, 0);
  assert.match((await f.ui('status')).status, /PROTOCOL_MISMATCH/);
});

test('extension rejects incompatible welcomes and clears local connection without onDisconnect', async () => {
  for (const value of [{ version: 2, connectionEpoch: 'c', capabilities: [...brokerCapabilities] },
    { version: 1, connectionEpoch: 'c', capabilities: [] }, { version: 1 }]) {
    const f = await fixture({ handshake: false }); f.welcome(f.port, value);
    assert.equal(f.port.disconnected, true);
    assert.match((await f.ui('status')).status, /PROTOCOL_MISMATCH/);
    await f.ui('connect'); assert.equal(f.ports.length, 2);
    f.welcome(); assert.equal((await f.ui('status')).status, 'Connected');
  }
});

test('extension handshake deadline closes a silent host and late welcome cannot reconnect', async () => {
  const timers = new Map(); let next = 0;
  const f = await fixture({ handshake: false, timers: {
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  } });
  const deadline = [...timers.values()].find(t => t.ms === 3000); assert.ok(deadline); deadline.fn();
  assert.equal(f.port.disconnected, true); assert.equal(timers.size, 0);
  f.welcome(f.port); assert.equal((await f.ui('status')).status, 'Handshake timed out');
  assert.equal(f.commands.length, 0);
});

test('completed request replay closes the gate without repeating a side effect; obsolete port cannot revoke successor', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const params = { lease: f.lease, method: 'Input.insertText', params: { text: 'once' } };
  await f.call('cdp', params); await new Promise(resolve => setImmediate(resolve));
  f.port.onMessage.emit({ type: 'request', id: 'r-2', method: 'cdp', params });
  assert.equal(f.port.disconnected, true);
  assert.equal((await f.ui('status')).controlled, false);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 1);
  await f.ui('connect'); f.welcome();
  const hello = f.sent.filter(m => m.method === 'hello').at(-1);
  const lease = { ...f.lease, id: 'successor', token: 'new-token', instanceId: hello.params.instance.id, tab: `${hello.params.instance.id}:7` };
  assert.equal((await f.call('lease.grant', { lease })).ok, true);
  f.port.onDisconnect.emit();
  f.port.onMessage.emit({ type: 'request', id: 'old-revoke', method: 'lease.revoke', params: { lease } });
  assert.equal((await f.ui('status')).controlled, true);
  assert.equal((await f.call('cdp', { ...params, lease })).ok, true);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 2);
});

test('extension refuses input without lease and allows a current granted lease', async () => {
  const f = await fixture();
  const denied = await f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: { text: 'x' } });
  assert.equal(denied.ok, false); assert.equal(f.commands.length, 0);
  assert.equal((await f.call('lease.grant', { lease: f.lease })).ok, true);
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: { text: 'x' } })).ok, true);
  assert.equal(f.commands.at(-1).method, 'Input.insertText');
});

test('extension Stop closes the gate synchronously while a browser lookup is pending', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  let finishGet;
  f.chrome.tabs.get = async () => new Promise(resolve => { finishGet = () => resolve({ ...f.tab }); });
  const action = f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: { text: 'must not type' } });
  while (!finishGet) await new Promise(resolve => setImmediate(resolve));
  const stop = f.ui('stop');
  await new Promise(resolve => setImmediate(resolve));
  finishGet();
  assert.equal((await action).ok, false);
  await stop;
  assert.equal(f.commands.some(c => c.method === 'Input.insertText'), false);
});

test('old revoke cannot revoke a newer fencing token', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  await f.call('lease.revoke', { lease: f.lease });
  const next = { ...f.lease, id: 'new-lease', token: 'new-token' };
  await f.call('lease.grant', { lease: next });
  await f.call('lease.revoke', { lease: f.lease });
  assert.equal((await f.call('cdp', { lease: next, method: 'Page.getFrameTree', params: {} })).ok, true);
});

test('new origin, unsupported CDP and expired lease all fail closed', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Browser.close', params: {} })).ok, false);
  assert.equal((await f.call('cdp', { lease: { ...f.lease, expiresAt: 1 }, method: 'Input.insertText', params: {} })).ok, false);
  f.tab.url = 'https://different.test/';
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: {} })).ok, false);
  assert.equal(f.commands.some(c => c.method === 'Input.insertText'), false);
});

test('explicit tab-scoped consent survives HTTP(S) origin changes while exact-origin leases still close', async () => {
  const f = await fixture();
  const personal = { ...f.lease, scope: 'tab' };
  assert.equal((await f.call('lease.grant', { lease: personal })).ok, true);
  f.tab.url = 'https://different.test/next';
  f.chrome.tabs.onUpdated.emit(7, { url: f.tab.url });
  const rebound = { ...personal, origin: 'https://different.test' };
  assert.equal((await f.call('cdp', { lease: rebound, method: 'Page.getFrameTree', params: {} })).ok, true);
  assert.equal((await f.ui('status')).controlled, true);
  await f.ui('stop');

  const exact = await fixture(); await exact.call('lease.grant', { lease: exact.lease });
  exact.tab.url = 'https://different.test/'; exact.chrome.tabs.onUpdated.emit(7, { url: exact.tab.url });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await exact.call('cdp', { lease: exact.lease, method: 'Page.getFrameTree', params: {} })).code, 'LEASE_REVOKED');
});

test('tab-scoped navigation binds the command to its declared target origin', async () => {
  const f = await fixture(); const personal = { ...f.lease, scope: 'tab' };
  await f.call('lease.grant', { lease: personal });
  const target = { ...personal, origin: 'https://different.test' };
  assert.equal((await f.call('cdp', { lease: target, method: 'Page.navigate', params: { url: 'https://different.test/path' } })).ok, true);
  assert.equal((await f.call('cdp', { lease: target, method: 'Page.navigate', params: { url: 'https://third.test/' } })).code, 'POLICY_DENIED');
});

test('native disconnect prevents old-token dispatch and does not reconnect', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  f.port.remoteDisconnect();
  f.port.onMessage.emit({ type: 'request', id: 'late-old-port', method: 'cdp', params: { lease: f.lease, method: 'Input.insertText', params: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.some(c => c.method === 'Input.insertText'), false);
  assert.equal((await f.ui('status')).status, 'Disconnected');
});

test('extension navigation/readiness boundary denies cross-origin and arbitrary evaluation', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const cdp = (method, params) => f.call('cdp', { lease: f.lease, method, params });
  assert.equal((await cdp('Page.navigate', { url: 'https://elsewhere.test/' })).code, 'POLICY_DENIED');
  assert.equal((await cdp('Runtime.evaluate', { expression: 'alert(1)', returnByValue: true })).code, 'POLICY_DENIED');
  assert.equal((await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true, contextId: 42 })).code, 'POLICY_DENIED');
  assert.equal((await cdp('Page.navigate', { url: 'https://example.test/next' })).ok, true);
  assert.equal((await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).ok, true);
});

test('page change hints are coalesced, payload-free and cleared by Stop', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  for (let i = 0; i < 20; i++) f.chrome.debugger.onEvent.emit({ tabId: 7 }, 'Accessibility.nodesUpdated', { secret: 'never transmit' });
  await new Promise(resolve => setTimeout(resolve, 35));
  const hints = f.sent.filter(m => m.event === 'page.changed');
  assert.equal(hints.length, 1);
  assert.deepEqual(Object.keys(hints[0].value).sort(), ['leaseId', 'sequence', 'tab']);
  assert.equal(JSON.stringify(hints).includes('secret'), false);
  f.chrome.debugger.onEvent.emit({ tabId: 7 }, 'Page.lifecycleEvent');
  await f.ui('stop');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.sent.filter(m => m.event === 'page.changed').length, 1);
});

test('subtree CDP reads require an exact backend root and honor the same Stop gate', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    await send(target, method, params);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: f.tab.url } } };
    return { nodes: [{ nodeId: 'root', backendDOMNodeId: 30, role: { value: 'region' }, name: { value: 'Pane' } }] };
  };
  const read = request => f.call('ax.read', { lease: f.lease, request });
  for (const params of [{}, { frameId: 'frame', backendNodeId: -1 }, { frameId: 'frame', backendNodeId: 1, role: 'textbox' }, { objectId: 'guessed' }]) {
    assert.equal((await read(params)).code, 'INVALID_REQUEST');
  }
  assert.equal((await read({ frameId: 'frame', backendNodeId: 30 })).ok, true);
  for (const method of ['Accessibility.getFullAXTree', 'Accessibility.queryAXTree', 'Accessibility.getChildAXNodes']) {
    assert.equal((await f.call('cdp', { lease: f.lease, method, params: {} })).code, 'UNSUPPORTED_CAPABILITY');
  }
  await f.ui('stop');
  assert.equal((await read({ frameId: 'frame', backendNodeId: 30 })).code, 'LEASE_REVOKED');
  assert.equal(f.commands.filter(c => c.method === 'Accessibility.getPartialAXTree').length, 1);
});

test('keyboard gate permits canonical page keys and blocks shortcuts, extra commands and Stop', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const send = params => f.call('cdp', { lease: f.lease, method: 'Input.dispatchKeyEvent', params });
  const down = keyEvent('Tab', true, 'keyDown');
  for (const params of [{ ...down, modifiers: 4 }, { ...down, commands: ['selectAll'] }, { ...down, text: 'inject' },
    { ...down, code: 'KeyL', key: 'l', windowsVirtualKeyCode: 76 }]) assert.equal((await send(params)).code, 'POLICY_DENIED');
  assert.equal((await send(down)).ok, true);
  assert.equal((await send(keyEvent('Tab', true, 'keyUp'))).ok, true);
  await f.ui('stop');
  assert.equal((await send(keyEvent('Enter', false, 'keyDown'))).code, 'LEASE_REVOKED');
  assert.equal(f.commands.filter(c => c.method === 'Input.dispatchKeyEvent').length, 2);
});

test('mouse gate accepts one canonical wheel sample but rejects modifiers and blocks delivery after Stop', async () => {
  const f=await fixture(); await f.call('lease.grant',{lease:f.lease});
  const send=params=>f.call('cdp',{lease:f.lease,method:'Input.dispatchMouseEvent',params});
  const event=wheelEvent({x:20,y:30},{deltaX:-50,deltaY:120});
  for(const patch of [{modifiers:2},{deltaY:10001},{buttons:1},{type:'mouseMoved'},{deltaX:0,deltaY:0}]) {
    assert.equal((await send({...event,...patch})).code,'POLICY_DENIED');
  }
  assert.equal(f.tabMessages.length,0);
  assert.equal((await send(event)).ok,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.stringify(f.tabMessages),JSON.stringify([{type:'dsh.pointer.v1',action:'show',x:20,y:30,phase:'wheel'}]));
  await f.ui('stop'); assert.equal((await send(event)).code,'LEASE_REVOKED');
  assert.equal(f.commands.filter(c=>c.method==='Input.dispatchMouseEvent').length,1);assert.equal(f.tabMessages.length,2);
  assert.equal(JSON.stringify(f.tabMessages[1]),JSON.stringify({type:'dsh.pointer.v1',action:'remove'}));
});

test('scroll document discovery only permits a shallow non-piercing root handle', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const read = params => f.call('cdp', { lease: f.lease, method: 'DOM.getDocument', params });
  for (const params of [{ depth: -1, pierce: false }, { depth: 0, pierce: true }, {}, { depth: 0, pierce: false, extra: true }]) {
    assert.equal((await read(params)).code, 'POLICY_DENIED');
  }
  assert.equal((await read({ depth: 0, pierce: false })).ok, true);
  await f.ui('stop');
  assert.equal((await read({ depth: 0, pierce: false })).code, 'LEASE_REVOKED');
});

test('Stop during a multi-command AX traversal discards data and prevents the next browser call', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  let finish;
  f.chrome.debugger.sendCommand = async (_target, method) => {
    f.commands.push({ method });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: f.tab.url } } };
    if (method === 'Accessibility.getRootAXNode') return { node: { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] } };
    if (method === 'Accessibility.getChildAXNodes') return new Promise(resolve => { finish = () => resolve({ nodes: [{ nodeId: '2', role: { value: 'button' }, name: { value: 'Not returned' } }] }); });
    throw new Error('Unexpected read');
  };
  const read = f.call('ax.read', { lease: f.lease, request: { frameId: 'frame' } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const stopped = f.ui('stop'); await new Promise(resolve => setImmediate(resolve));
  const count = f.commands.length; finish();
  const result = await read; await stopped;
  assert.equal(result.code, 'LEASE_REVOKED'); assert.equal(f.commands.length, count);
  assert.equal(JSON.stringify(result).includes('Not returned'), false);
});

test('AX traversal validates root-frame authority and discards navigation-time mixtures', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  let loader = 'one', reads = 0;
  f.chrome.debugger.sendCommand = async (_target, method) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: loader, url: f.tab.url } } };
    if (method === 'Accessibility.getRootAXNode') { reads++; loader = 'two'; return { node: { nodeId: '1', role: { value: 'RootWebArea' } } }; }
    throw new Error('Unexpected read');
  };
  assert.equal((await f.call('ax.read', { lease: f.lease, request: { frameId: 'other' } })).code, 'POLICY_DENIED');
  assert.equal(reads, 0);
  assert.equal((await f.call('ax.read', { lease: f.lease, request: { frameId: 'frame' } })).code, 'STALE_TARGET');
  assert.equal(reads, 1);
});

test('semantic query exposes only literal constrained filters under the same root-frame gate', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  f.chrome.debugger.sendCommand = async (_target, method, params) => {
    f.commands.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'one', url: f.tab.url } } };
    if (method === 'DOM.getDocument') return { root: { backendNodeId: 1 } };
    if (method === 'Accessibility.queryAXTree') return { nodes: [{ backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'A.*' } }] };
    throw new Error('Unexpected command');
  };
  const read = request => f.call('ax.find', { lease: f.lease, request });
  for (const query of [{}, { name: '' }, { name: 'A.*', regex: true }, { name: 'A.*', selector: '*' }]) {
    assert.equal((await read({ frameId: 'frame', query })).code, 'INVALID_REQUEST');
  }
  assert.equal((await read({ frameId: 'other', query: { name: 'A.*' } })).code, 'POLICY_DENIED');
  const result = await read({ frameId: 'frame', query: { name: 'A.*', role: 'button' } });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.find(c => c.method === 'Accessibility.queryAXTree').params)),
    { backendNodeId: 1, accessibleName: 'A.*', role: 'button' });
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Accessibility.queryAXTree', params: { backendNodeId: 1 } })).code, 'UNSUPPORTED_CAPABILITY');
});

test('Stop while a semantic query is pending discards its result and does not dispatch another command', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease }); let finish;
  f.chrome.debugger.sendCommand = async (_target, method) => {
    f.commands.push({ method });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'one', url: f.tab.url } } };
    if (method === 'Accessibility.queryAXTree') return new Promise(resolve => { finish = () => resolve({ nodes: [{ backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'secret-query-result' } }] }); });
    throw new Error('Unexpected command');
  };
  const read = f.call('ax.find', { lease: f.lease, request: { frameId: 'frame', backendNodeId: 1, query: { name: 'secret-query-result' } } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const stopped = f.ui('stop'); await new Promise(resolve => setImmediate(resolve));
  const count = f.commands.length; finish();
  const result = await read; await stopped;
  assert.equal(result.code, 'LEASE_REVOKED'); assert.equal(f.commands.length, count);
  assert.equal(JSON.stringify(result).includes('secret-query-result'), false);
});
