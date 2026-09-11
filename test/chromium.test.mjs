import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { radioBindingFunction, radioBindingCheckFunction } from '../dist/packages/provider-chromium/src/checked.js';
import { editableFunction } from '../dist/packages/provider-chromium/src/editable.js';
import { nativeTextFunction } from '../dist/packages/provider-chromium/src/text-input.js';
import { elementStateFunction } from '../dist/packages/provider-chromium/src/element-state.js';
const instance = { id: 'chromium-test', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'test', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', tab: 'tab', instanceId: instance.id, token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 100000 };
function fixture() {
  const listeners = new Set();
  const state = { loader: 'loader-1', name: 'Search', value: '', covered: false, commands: [], dispatches: 0,
    url: 'https://example.test/form', ready: 'complete', text: ['Fixture'], onCommand: undefined,
    inViewport: true, connected: true, focused: true, keyEvents: [] };
  const pulse = () => { for (const listener of listeners) listener('page.changed', { tab: lease.tab, leaseId: lease.id }); };
  const channel = { onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async call(method, params) {
    if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: state.url, title: 'Test' }];
    if (method === 'ax.find' || method === 'ax.page' || method === 'frames.list' || method === 'ax.frame' || method === 'ax.frame.find' || method === 'ax.frame.subtree' || method === 'frame.click.prepare' || method === 'frame.click') { state.commands.push(method); return await state.onCommand?.(method, params.binding ?? params.request) ?? { nodes: [] }; }
    // This fixture stubs source acquisition, not its traversal; ax-reader tests exercise the real algorithm.
    if (method === 'ax.read') { method = 'cdp'; params = { method: params.request.backendNodeId === undefined
      ? 'Accessibility.getFullAXTree' : 'Accessibility.queryAXTree', params: params.request.backendNodeId === undefined
        ? { frameId: params.request.frameId } : { backendNodeId: params.request.backendNodeId } }; }
    if (method !== 'cdp') return {};
    const { method: cdp, params: p } = params;
    state.commands.push(cdp);
    if (cdp === 'Input.dispatchKeyEvent') state.keyEvents.push(structuredClone(p));
    const override = await state.onCommand?.(cdp, p);
    if (override !== undefined) return override;
    if (cdp === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: state.loader, url: state.url } } };
    if (cdp === 'Accessibility.getFullAXTree' || cdp === 'Accessibility.getPartialAXTree') return { nodes: [{ backendDOMNodeId: 17, role: { value: state.role ?? 'textbox' }, name: { value: state.name },
      properties: [{ name: 'focused', value: { value: state.axFocused ?? state.focused } },
        ...(state.editor === true && state.axEditable !== false ? [{ name: 'focusable', value: { value: true } }, { name: 'editable', value: { value: 'richtext' } }] : []),
        ...(state.checked === undefined ? [] : [{ name: 'checked', value: { value: state.axChecked ?? state.checked } }])] },
      ...state.text.map(text => ({ role: { value: 'StaticText' }, name: { value: text } }))] };
    if (cdp === 'DOM.resolveNode') return { object: { objectId: 'object-17' } };
    if (cdp === 'Runtime.callFunctionOn' && p.functionDeclaration === radioBindingFunction) return {result:state.customRadio?{value:null}:{objectId:'radio-binding-17'}};
    if (cdp === 'Runtime.callFunctionOn' && p.functionDeclaration === radioBindingCheckFunction) {
      assert.deepEqual(p.arguments,[{objectId:'radio-binding-17'}]);
      return {result:{value:!state.radioChanged}};
    }
    if (cdp === 'Runtime.callFunctionOn' && [editableFunction, nativeTextFunction].includes(p.functionDeclaration)) {
      return { result: { value: { connected: state.connected, editable: state.editor !== false && state.editable !== false,
        focused: state.focused, selected: state.focused, value: state.value, atEnd: state.atEnd ?? state.focused, maxLength: state.maxLength ?? -1 } } };
    }
    if (cdp === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('aria-checked')) {
      return { result: { value: { connected: state.connected, checked: state.checked } } };
    }
    if (cdp === 'Runtime.callFunctionOn') return { result: { value: { ok: !state.covered && state.inViewport, inViewport: state.inViewport, connected: state.connected,
      x: 50, y: 50, left: 0, top: 30, width: 100, height: 40, tag: state.editor === undefined ? 'INPUT' : 'DIV',
      contentEditable: state.editor !== undefined, type: 'text', focused: state.focused, value: state.value } } };
    if (cdp === 'Input.insertText') state.value = state.appendAction ? state.value + p.text : p.text;
    if (cdp === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased' && state.checked !== undefined && !state.preventCheck) state.checked = state.checked !== true;
    if (cdp === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.key === 'Backspace') state.value = '';
    if (cdp === 'Runtime.evaluate') return { result: { value: state.ready } };
    if (cdp === 'DOM.scrollIntoViewIfNeeded') state.inViewport = true;
    if (cdp === 'Page.navigate') { state.url = p.url; state.loader = 'loader-next'; return { loaderId: state.loader }; }
    if (cdp === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    if (cdp === 'Page.captureScreenshot') return { data: '/9j/' };
    return {};
  } };
  const provider = new ChromiumProvider(instance, channel);
  const execution = { signal: new AbortController().signal, onDispatch() { state.dispatches++; } };
  return { state, provider, execution, pulse, listeners };
}

const request = (o, action, timeoutMs = 1000) => ({ requestId: 'request', leaseId: lease.id, documentEpoch: o.documentEpoch, action, timeoutMs });

async function childClickFixture(){
  const f=fixture(),raw={truncated:false,frames:[{frameId:'frame',loaderId:'loader-1',origin:lease.origin,sessionId:'',context:{id:1,uniqueId:'root-context'}},
    {frameId:'child',parentId:'frame',loaderId:'child-loader',origin:lease.origin,sessionId:'',context:{id:2,uniqueId:'child-context'}}]};
  f.raw=raw;f.childText='Waiting';f.bindings=[];
  f.state.onCommand=async(method,p)=>{
    const override=await f.override?.(method,p);if(override!==undefined)return override;
    if(method==='frames.list')return raw;
    if(method==='ax.frame')return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'}},
      {role:{value:'StaticText'},name:{value:f.childText}}],truncated:false};
    if(method==='frame.click.prepare'||method==='frame.click'){
      f.bindings.push(structuredClone(p));if(method==='frame.click')f.childText='Child completed';
      return {acknowledged:method==='frame.click'};
    }
  };
  const child=(await f.provider.frames(lease,f.execution.signal)).frames[1];f.frame={frameId:child.id,documentEpoch:child.documentEpoch};
  const o=await f.provider.observeFrame(lease,f.frame,f.execution.signal);
  f.request={...request(o,{kind:'click',ref:o.nodes[0].id,expected:{kind:'text',text:'Child completed'}},100),frame:f.frame};return f;
}
test('child provider binds observed source identity for preparation and dispatch and returns only child text',async()=>{
  const f=await childClickFixture(),result=await f.provider.act(lease,f.request,f.execution);
  assert.equal(result.postcondition,'passed');assert.deepEqual(result.observation.scope,{kind:'frame',frameId:f.frame.frameId});
  assert.deepEqual(result.observation.text,['Child completed']);assert.equal(f.state.dispatches,1);assert.equal(f.listeners.size,0);
  assert.equal(f.bindings.length,2);assert.deepEqual(f.bindings[0],f.bindings[1]);
  assert.deepEqual(f.bindings[0],{binding:{frameId:'child',loaderId:'child-loader',contextUniqueId:'child-context',rootFrameId:'frame',rootLoaderId:'loader-1'},backendNodeId:17,role:'button',name:'Child button'});
  assert.equal(f.state.commands.some(c=>c.startsWith('Input.')||c==='Accessibility.getFullAXTree'),false);
});
test('child query uses the explicit source binding, retains child refs and never widens to root discovery',async()=>{
  const f=await childClickFixture(),query={name:'Child button',role:'button'};
  f.override=(method,p)=>{if(method==='ax.frame.find'){
    assert.deepEqual(p,{binding:{frameId:'child',loaderId:'child-loader',contextUniqueId:'child-context',rootFrameId:'frame',rootLoaderId:'loader-1'},query});
    return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:query.name}}],truncated:false};
  }};
  const found=await f.provider.findFrame(lease,f.frame,query,f.execution.signal);
  assert.deepEqual(found.scope,{kind:'query',frameId:f.frame.frameId,query});assert.equal(found.nodes[0].id,f.request.action.ref);
  f.override=method=>method==='ax.frame.find'?{nodes:[],truncated:false}:undefined;
  await f.provider.findFrame(lease,f.frame,{name:'Absent'},f.execution.signal);
  assert.equal((await f.provider.actFrame(lease,f.request,f.execution)).postcondition,'passed');
  assert.equal(f.state.commands.includes('ax.find'),false);assert.equal(f.state.commands.includes('Accessibility.getFullAXTree'),false);
});
test('child subtree/context query sends a cached semantic root without using root-session identity checks',async()=>{
 const f=await childClickFixture(),rootRef=f.request.action.ref,query={name:'Child button'};
 f.override=(method,p)=>{if(method==='ax.frame.subtree'||method==='ax.frame.find'){
  assert.deepEqual(p.root,{backendNodeId:17,role:'button',name:'Child button',editable:false});
  return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'}}],truncated:false};
 }};
 const read=await f.provider.observeFrameSubtree(lease,f.frame,rootRef,f.execution.signal);
 assert.deepEqual(read.scope,{kind:'subtree',frameId:f.frame.frameId,rootRef});
 assert.deepEqual((await f.provider.findFrame(lease,f.frame,query,f.execution.signal,rootRef)).scope,{kind:'query',frameId:f.frame.frameId,query,rootRef});
 assert.equal(f.state.commands.includes('Accessibility.getPartialAXTree'),false);
 const root=(await f.provider.observe(lease,f.execution.signal)).nodes[0].id;
 await assert.rejects(f.provider.observeFrameSubtree(lease,f.frame,root,f.execution.signal),{code:'STALE_TARGET'});
});
test('child preparation refuses stale refs, changed origins and invalid acknowledgement before dispatch',async()=>{
  for(const mode of ['root-ref','preflight','changed-context','foreign','reply']){
    const f=await childClickFixture();
    if(mode==='root-ref')f.request.action.ref=(await f.provider.observe(lease,f.execution.signal)).nodes[0].id;
    f.override=(method)=>{
      if(method!=='frame.click.prepare')return;
      if(mode==='preflight')throw new BrowserError('NOT_ACTIONABLE','covered');
      if(mode==='changed-context')f.raw.frames[1].context.uniqueId='replacement';
      if(mode==='foreign')f.raw.frames[1].origin='https://foreign.test';
      if(mode==='reply')return {acknowledged:true};
    };
    await assert.rejects(f.provider.actFrame(lease,f.request,f.execution));assert.equal(f.state.dispatches,0,mode);
    assert.equal(f.state.commands.includes('frame.click'),false);assert.equal(f.listeners.size,0);
  }
});
test('child missing acknowledgement, result navigation and root-only expectation never retry or publish success',async()=>{
  for(const mode of ['ack','navigation','root-text']){
    const f=await childClickFixture();if(mode==='root-text'){f.request.action.expected.text='Fixture';f.request.timeoutMs=25;}
    f.override=method=>{if(method==='frame.click'){
      if(mode==='ack')throw new BrowserError('PROVIDER_LOST','ack lost');
      if(mode==='navigation')f.raw.frames[1].loaderId='navigated';
    }};
    await assert.rejects(f.provider.actFrame(lease,f.request,f.execution));assert.equal(f.state.dispatches,1,mode);
    assert.equal(f.state.commands.filter(c=>c==='frame.click').length,1);assert.equal(f.listeners.size,0);
  }
});
test('child deadline cancellation after preparation prevents dispatch and removes its event subscription',async()=>{
  const f=await childClickFixture(),controller=new AbortController();
  f.override=method=>{if(method==='frame.click.prepare')controller.abort(new BrowserError('CANCELLED_BY_USER','Stop'));};
  await assert.rejects(f.provider.actFrame(lease,f.request,{...f.execution,signal:controller.signal}));
  assert.equal(f.state.dispatches,0);assert.equal(f.state.commands.includes('frame.click'),false);assert.equal(f.listeners.size,0);
});

test('frame IDs are opaque and stable; document/context replacement changes only that child epoch', async () => {
  const f=fixture(), raw={truncated:false,frames:[{frameId:'frame',loaderId:'loader-1',origin:lease.origin,sessionId:'',context:{id:1,uniqueId:'root-context'}},
    {frameId:'child',parentId:'frame',loaderId:'child-loader',origin:'https://foreign.test',sessionId:'remote',context:{id:2,uniqueId:'child-context'}}]};
  f.state.onCommand=method=>method==='frames.list'?raw:undefined;
  const first=await f.provider.frames(lease,f.execution.signal),second=await f.provider.frames(lease,f.execution.signal);assert.deepEqual(first,second);
  assert.ok(first.frames.every(frame=>frame.id.startsWith('frame-')));assert.doesNotMatch(JSON.stringify(first),/sessionId|uniqueId|remote|child-loader/);
  raw.frames[1].context.uniqueId='new-context';const third=await f.provider.frames(lease,f.execution.signal);
  assert.equal(third.frames[1].id,first.frames[1].id);assert.notEqual(third.frames[1].documentEpoch,first.frames[1].documentEpoch);
  assert.deepEqual(third.frames[0],first.frames[0]);
  const removed=raw.frames.pop();await f.provider.frames(lease,f.execution.signal);raw.frames.push(removed);
  assert.notEqual((await f.provider.frames(lease,f.execution.signal)).frames[1].id,first.frames[1].id);
  const observation=await f.provider.observe(lease,f.execution.signal);
  await assert.rejects(f.provider.act(lease,request(observation,{kind:'click',ref:first.frames[1].id}),f.execution),{code:'STALE_TARGET'});
  assert.equal(f.state.dispatches,0);
});
test('source graph errors and a concurrent root navigation never publish a frame inventory',async()=>{
  for(const mode of ['navigation','wrong-root','null-context','duplicate','cycle']){
    const f=fixture(); f.state.onCommand=method=>{
      if(method!=='frames.list')return;
      const root={frameId:'frame',loaderId:'loader-1',origin:lease.origin};
      if(mode==='navigation')f.state.loader='next';if(mode==='wrong-root')root.frameId='other';
      if(mode==='null-context')root.context=null;
      return {truncated:false,frames:[root,...(mode==='duplicate'?[root]:mode==='cycle'?[{frameId:'x',parentId:'y'},{frameId:'y',parentId:'x'}]:[])]};
    }; await assert.rejects(f.provider.frames(lease,f.execution.signal));
  }
});

test('frame AX shares projection but isolates colliding backend IDs and bounds child node caches',async()=>{
  const f=fixture(),root=await f.provider.observe(lease,f.execution.signal);
  const raw={truncated:false,frames:[{frameId:'frame',loaderId:'loader-1',origin:lease.origin},...Array.from({length:10},(_,i)=>({
    frameId:'child-'+i,parentId:'frame',loaderId:'child-loader-'+i,origin:lease.origin,sessionId:'',context:{id:i+1,uniqueId:'unique-'+i}}))]};
  f.state.onCommand=(method,binding)=>{
    if(method==='frames.list')return raw;
    if(method==='ax.frame'){
      assert.equal(binding.rootFrameId,'frame');assert.equal(binding.rootLoaderId,'loader-1');assert.equal(binding.sessionId,undefined);
      return {nodes:[{backendDOMNodeId:17,role:{value:'button'},name:{value:'Child button'}},
        {role:{value:'StaticText'},name:{value:'Child reading text'}}],truncated:false};
    }
  };
  const inventory=await f.provider.frames(lease,f.execution.signal),child=inventory.frames[1],target={frameId:child.id,documentEpoch:child.documentEpoch};
  const first=await f.provider.observeFrame(lease,target,f.execution.signal),second=await f.provider.observeFrame(lease,target,f.execution.signal);
  assert.deepEqual(first.nodes,second.nodes);assert.notEqual(first.nodes[0].id,root.nodes[0].id);assert.deepEqual(first.scope,{kind:'frame',frameId:child.id});
  assert.deepEqual(first.text,['Child reading text']);assert.equal(first.documentEpoch,child.documentEpoch);
  for(const frame of inventory.frames.slice(2))await f.provider.observeFrame(lease,{frameId:frame.id,documentEpoch:frame.documentEpoch},f.execution.signal);
  assert.equal(f.provider.pages.get(lease.tab).childPages.size,8);assert.equal(f.provider.pages.get(lease.tab).byRef.size,root.nodes.length);
  await assert.rejects(f.provider.act(lease,request(root,{kind:'click',ref:first.nodes[0].id}),f.execution),{code:'STALE_TARGET'});assert.equal(f.state.dispatches,0);
  await f.provider.revoke(lease);assert.equal(f.provider.pages.size,0);
});
test('child post-read metadata change, unknown epochs and missing unique contexts cannot publish or widen reads',async()=>{
  for(const mode of ['stale','context','after-origin','after-document','after-root']){
    const f=fixture(),raw={truncated:false,frames:[{frameId:'frame',loaderId:'loader-1',origin:lease.origin},
      {frameId:'child',parentId:'frame',loaderId:'child-loader',origin:lease.origin,sessionId:'',context:{id:2,uniqueId:'unique'}}]};let reads=0;
    f.state.onCommand=method=>{
      if(method==='frames.list')return raw;if(method==='ax.frame'){
        reads++;if(mode==='after-origin')raw.frames[1].origin='https://foreign.test';
        if(mode==='after-document')raw.frames[1].loaderId='changed';if(mode==='after-root')f.state.loader='changed-root';
        return {nodes:[],truncated:false};
      }
    };
    if(mode==='context')delete raw.frames[1].context.uniqueId;
    const child=(await f.provider.frames(lease,f.execution.signal)).frames[1];
    await assert.rejects(f.provider.observeFrame(lease,{frameId:child.id,documentEpoch:mode==='stale'?'old':child.documentEpoch},f.execution.signal));
    if(['stale','context'].includes(mode))assert.equal(reads,0);
    assert.equal(f.provider.pages.get(lease.tab).childPages.size,0);
  }
});

test('paging keeps the explicitly validated root through ref-LRU churn and never treats the last window as a full document',async()=>{
  const f=fixture();f.state.role='region';f.state.name='Root region';const root=(await f.provider.observe(lease,f.execution.signal)).nodes[0];
  f.state.onCommand=(method,p)=>method==='ax.page'?{nodes:Array.from({length:100},(_,i)=>({backendDOMNodeId:1000+f.state.page*100+i,role:{value:'button'},name:{value:'Page '+f.state.page+' item '+i}})),
    truncated:true,page:{index:f.state.page,incomplete:false,continuation:'next-'+f.state.page}}:undefined;
  for(let i=0;i<30;i++){f.state.page=i;const page=await f.provider.readPage(lease,{rootRef:root.id,...(i?{continuation:'next-'+(i-1)}:{})},f.execution.signal);assert.equal(page.nodes.length,100);}
  assert.ok(f.provider.pages.get(lease.tab).byRef.size<=2048);assert.ok(f.provider.pages.get(lease.tab).byRef.has(root.id));
  f.state.onCommand=(method)=>method==='ax.page'?{nodes:[],truncated:false,page:{index:30,incomplete:false}}:undefined;
  await f.provider.readPage(lease,{},f.execution.signal);assert.ok(f.provider.pages.get(lease.tab).byRef.has(root.id));
});

function stateFixture() {
  const f = fixture(); f.state.stateMatched = false; f.state.stateReads = 0;
  f.state.onCommand = async (method, p) => {
    const override = await f.state.stateOverride?.(method, p); if (override !== undefined) return override;
    if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === elementStateFunction) {
      f.state.stateReads++;
      return { result: { value: { connected: true, sameDocument: true, supported: true, matched: f.state.stateMatched } } };
    }
    if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === 'function(){return this.isConnected===true&&this.ownerDocument===document;}') return { result: { value: true } };
  };
  return f;
}
test('state predicate binds before input, waits for feedback, and rechecks after observation', async () => {
  const f = stateFixture(), o = await f.provider.observe(lease, f.execution.signal);
  f.state.stateOverride = (method, p) => {
    if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') setTimeout(() => { f.state.stateMatched = true; f.pulse(); }, 25);
  };
  const result = await f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id,
    expected: { kind: 'state', ref: o.nodes[0].id, state: 'enabled' } }), f.execution);
  assert.equal(result.postcondition, 'passed'); assert.ok(f.state.stateReads >= 4);
  assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
  assert.equal(f.state.commands.filter(c => c === 'Runtime.releaseObject').length, 2);
});
test('invalid or unsupported state binding refuses input and releases retained objects', async () => {
  for (const mode of ['unknown', 'unsupported', 'gone']) {
    const f = stateFixture(), o = await f.provider.observe(lease, f.execution.signal);
    f.state.stateOverride = (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === elementStateFunction && mode === 'unsupported')
        return { result: { value: { connected: true, sameDocument: true, supported: false, matched: false } } };
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === 'function(){return this.isConnected===true&&this.ownerDocument===document;}' && mode === 'gone')
        return { result: { value: false } };
    };
    await assert.rejects(f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id,
      expected: { kind: 'state', ref: mode === 'unknown' ? 'missing' : o.nodes[0].id, state: 'hidden' } }), f.execution),
    { code: mode === 'unsupported' ? 'UNSUPPORTED_CAPABILITY' : 'STALE_TARGET' });
    assert.equal(f.state.dispatches, 0);
    assert.equal(f.state.commands.filter(c => c === 'Runtime.releaseObject').length, mode === 'unknown' ? 0 : 1);
  }
});
test('lost state object, document change and cancellation never mean hidden success or trigger another click', async () => {
  for (const mode of ['object', 'navigation', 'cancel']) {
    const f = stateFixture(), o = await f.provider.observe(lease, f.execution.signal), controller = new AbortController();
    f.state.stateOverride = (method, p) => {
      if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') {
        if (mode === 'navigation') f.state.loader = 'changed';
        if (mode === 'cancel') controller.abort();
        f.state.afterClick = true;
      }
      if (mode === 'object' && f.state.afterClick && method === 'Runtime.callFunctionOn' && p.functionDeclaration === elementStateFunction)
        return { exceptionDetails: { text: 'Object unavailable' } };
    };
    await assert.rejects(f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id,
      expected: { kind: 'state', ref: o.nodes[0].id, state: 'hidden' } }), { ...f.execution, signal: controller.signal }),
    { code: mode === 'cancel' ? 'CANCELLED' : 'STALE_TARGET' });
    assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
    assert.equal(f.state.commands.filter(c => c === 'Runtime.releaseObject').length, 2);
  }
});
test('state changing back during observation cannot produce a passed result', async () => {
  const f = stateFixture(), o = await f.provider.observe(lease, f.execution.signal);
  f.state.stateOverride = (method, p) => {
    if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') { f.state.stateMatched = true; f.state.afterClick = true; }
    if (method === 'Accessibility.getFullAXTree' && f.state.afterClick) f.state.stateMatched = false;
  };
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id,
    expected: { kind: 'state', ref: o.nodes[0].id, state: 'enabled' } }, 160), f.execution), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
});
test('a true state expectation cannot conceal prevented native fill', async () => {
  const f = stateFixture(), o = await f.provider.observe(lease, f.execution.signal); f.state.stateMatched = true;
  f.state.stateOverride = method => method === 'Input.insertText' ? {} : undefined;
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'not inserted',
    expected: { kind: 'state', ref: o.nodes[0].id, state: 'enabled' } }, 140), f.execution), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(f.state.commands.filter(c => c === 'Input.insertText').length, 1); assert.equal(f.state.value, '');
});

test('append sends only the suffix, verifies the combined text and performs an empty no-op without focus', async () => {
  for (const editor of [undefined, true]) for (const text of ['', '追加🙂']) {
    const f=fixture();Object.assign(f.state,{editor,value:'prefix',appendAction:true});const inserts=[],modes=[];
    f.state.onCommand=(method,p)=>{
      if(method==='Input.insertText') inserts.push(p.text);
      if(method==='Runtime.callFunctionOn'&&[editableFunction,nativeTextFunction].includes(p.functionDeclaration)) modes.push(p.arguments[0].value);
    };
    const o=await f.provider.observe(lease,f.execution.signal);
    assert.equal((await f.provider.act(lease,request(o,{kind:'append',ref:o.nodes[0].id,text}),f.execution)).postcondition,'passed');
    assert.equal(f.state.value,'prefix'+text);assert.deepEqual(inserts,text?[text]:[]);
    assert.deepEqual(modes,text?['value',editor?'append-end':'end',editor?'append-position':'position','value','value']:['value','value','value']);
    assert.equal(f.state.dispatches,text?2:0);assert.equal(f.state.keyEvents.length,0);
  }
});

test('append rejects changed prefix, wrong caret, lost focus and cancellation before insertion', async () => {
  for(const editor of [undefined,true]) for(const stage of ['end','position']) for(const fault of ['value','caret','focus','cancel']) {
    const f=fixture();Object.assign(f.state,{editor,value:'prefix',appendAction:true});const controller=new AbortController();
    f.state.onCommand=(method,p)=>{
      if(method==='Runtime.callFunctionOn'&&p.functionDeclaration===(editor?editableFunction:nativeTextFunction)&&p.arguments[0].value===(editor?'append-':'')+stage) {
        if(fault==='value') f.state.value='someone else updated';
        if(fault==='caret') f.state.atEnd=false;
        if(fault==='focus') f.state.focused=false;
        if(fault==='cancel') controller.abort();
      }
    };
    const o=await f.provider.observe(lease,f.execution.signal);
    await assert.rejects(f.provider.act(lease,request(o,{kind:'append',ref:o.nodes[0].id,text:'suffix'}),{...f.execution,signal:controller.signal}),
      {code:fault==='cancel'?'CANCELLED':fault==='value'?'STALE_TARGET':'NOT_ACTIONABLE'});
    assert.equal(f.state.commands.includes('Input.insertText'),false);assert.equal(f.state.dispatches,1);
  }
});

test('append validates initial size, maxlength and expected combined value before focus', async () => {
  for(const fault of ['budget','maxlength','expected','unsupported']) {
    const f=fixture();Object.assign(f.state,{value:fault==='budget'?'x'.repeat(10000):'prefix',appendAction:true,
      ...(fault==='maxlength'?{maxLength:6}:{}),...(fault==='unsupported'?{editable:false}:{})});
    const o=await f.provider.observe(lease,f.execution.signal);
    const action={kind:'append',ref:o.nodes[0].id,text:'suffix',...(fault==='expected'?{expected:{kind:'value',value:'suffix'}}:{})};
    await assert.rejects(f.provider.act(lease,request(o,action),f.execution),
      {code:fault==='maxlength'?'NOT_ACTIONABLE':fault==='unsupported'?'UNSUPPORTED_CAPABILITY':'INVALID_REQUEST'});
    assert.equal(f.state.dispatches,0);assert.equal(f.state.commands.includes('Input.insertText'),false);
  }
});

test('append cannot claim success from a page message or changed final text, and lost acknowledgement never replays', async () => {
  for(const fault of ['prevent','lost','rewrite']) {
    const f=fixture();Object.assign(f.state,{value:'prefix',appendAction:true});let inserted=false;
    const runtime=new BrowserRuntime(async()=>true);runtime.register(f.provider);
    f.state.onCommand=(method,p)=>{
      if(method==='Input.insertText') {inserted=true;if(fault==='prevent') return {};if(fault==='lost') {f.state.value+=p.text;throw new BrowserError('CONNECTION_LOST','lost acknowledgement');}}
      if(method==='Accessibility.getFullAXTree'&&inserted&&fault==='rewrite') f.state.value='rewritten after insert';
    };
    try {
      const l=await runtime.claim('owner',instance.id,'tab',f.execution.signal),o=await runtime.observe('owner',l.id,f.execution.signal);
      const r={...request(o,{kind:'append',ref:o.nodes[0].id,text:'suffix',expected:{kind:'text',text:'Fixture'}},150),leaseId:l.id};
      const result=await runtime.act('owner',r,f.execution.signal);
      assert.equal(result.outcome,'unknown');assert.equal(result.code,fault==='prevent'?'DEADLINE_EXCEEDED':fault==='lost'?'CONNECTION_LOST':'STALE_TARGET');
      assert.deepEqual(await runtime.act('owner',r,f.execution.signal),result);
      assert.equal(f.state.commands.filter(m=>m==='Input.insertText').length,1);
    } finally {await runtime.dispose();}
  }
});

test('contenteditable fill verifies full text and selection, uses one trusted-input command and releases its handle', async () => {
  for (const text of ['中文🙂\nsecond line', '']) {
    const f = fixture(); f.state.editor = true; f.state.value = 'old'; const modes = [], released = [];
    f.state.onCommand = (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === editableFunction) modes.push(p.arguments[0].value);
      if (method === 'Runtime.releaseObject') released.push(p.objectId);
    };
    const o = await f.provider.observe(lease, f.execution.signal);
    const result = await f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text }), f.execution);
    assert.equal(result.postcondition, 'passed'); assert.equal(f.state.value, text);
    assert.deepEqual(modes, ['inspect', 'select', 'selection', 'value', 'value']);
    assert.equal(f.state.commands.filter(m => m === 'Input.insertText').length, text ? 1 : 0);
    assert.equal(f.state.keyEvents.length, text ? 0 : 2);
    assert.deepEqual(released, ['object-17']); assert.equal(f.listeners.size, 0);
  }
});

test('unsupported editor and contradictory value expectation fail before focus or input', async () => {
  for (const editor of [false, true]) {
    const f = fixture(); f.state.editor = editor;
    const o = await f.provider.observe(lease, f.execution.signal);
    const action = { kind: 'fill', ref: o.nodes[0].id, text: 'wanted', ...(editor ? { expected: { kind: 'value', value: 'different' } } : {}) };
    await assert.rejects(f.provider.act(lease, request(o, action), f.execution), { code: editor ? 'INVALID_REQUEST' : 'UNSUPPORTED_CAPABILITY' });
    assert.equal(f.state.dispatches, 0); assert.equal(f.state.commands.includes('Input.insertText'), false);
  }
});

test('generic editing hosts retain their real AX role and lose action identity when their editing capability changes', async () => {
  const f = fixture(); f.state.editor = true; f.state.role = 'generic';
  const o = await f.provider.observe(lease, f.execution.signal);
  assert.equal(o.nodes[0].role, 'generic'); assert.equal(o.nodes[0].editable, true);
  assert.equal((await f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'editable' }), f.execution)).postcondition, 'passed');
  f.state.onCommand = method => method === 'Accessibility.getPartialAXTree' ? { nodes: [{ backendDOMNodeId: 17,
    role: { value: 'generic' }, name: { value: f.state.name }, properties: [
      { name: 'focusable', value: { value: true } }, { name: 'editable', value: { value: ['richtext'] } },
    ] }] } : undefined;
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'no coercion' }), f.execution), { code: 'STALE_TARGET' });
  f.state.onCommand = undefined;
  f.state.axEditable = false; const dispatches = f.state.dispatches;
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'must not type' }), f.execution), { code: 'STALE_TARGET' });
  assert.equal(f.state.dispatches, dispatches);
  assert.equal((await f.provider.observe(lease, f.execution.signal)).nodes.length, 0);
});

test('editor focus/selection loss and cancellation block input after potentially side-effecting focus', async () => {
  for (const stage of ['select', 'selection']) for (const fault of ['focus', 'selection', 'editable', 'cancel']) {
    const f = fixture(); f.state.editor = true; const controller = new AbortController();
    f.state.onCommand = (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === editableFunction && p.arguments[0].value === stage) {
        if (fault === 'cancel') controller.abort();
        return { result: { value: { connected: true, editable: fault !== 'editable', selected: fault === 'cancel', focused: fault !== 'focus' } } };
      }
    };
    const o = await f.provider.observe(lease, f.execution.signal);
    await assert.rejects(f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'must not type' }),
      { ...f.execution, signal: controller.signal }), { code: fault === 'cancel' ? 'CANCELLED' : 'NOT_ACTIONABLE' });
    assert.equal(f.state.dispatches, 1); assert.equal(f.state.commands.includes('Input.insertText'), false);
  }
});

test('editor value changes during result observation cannot yield verified success', async () => {
  const f = fixture(); f.state.editor = true; let reads = 0;
  f.state.onCommand = (method, p) => {
    if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === editableFunction && p.arguments[0].value === 'value' && ++reads === 2)
      f.state.value = 'page rewrote it';
  };
  const o = await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'wanted' }), f.execution), { code: 'STALE_TARGET' });
  assert.equal(f.state.commands.filter(m => m === 'Input.insertText').length, 1);
});

test('editor postcondition cannot hide a refused insert; lost acknowledgement does not replay', async () => {
  for (const lostAck of [false, true]) {
    const f = fixture(); f.state.editor = true; const runtime = new BrowserRuntime(async () => true); runtime.register(f.provider);
    f.state.onCommand = (method, p) => {
      if (method === 'Input.insertText') {
        if (lostAck) { f.state.value = p.text; throw new BrowserError('CONNECTION_LOST', 'lost acknowledgement'); }
        return {}; // beforeinput prevented the browser edit
      }
    };
    try {
      const l = await runtime.claim('owner', instance.id, 'tab', f.execution.signal), o = await runtime.observe('owner', l.id, f.execution.signal);
      const action = { ...request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'wanted', expected: { kind: 'text', text: 'Fixture' } }, 150), leaseId: l.id };
      const result = await runtime.act('owner', action, f.execution.signal);
      assert.equal(result.outcome, 'unknown'); assert.equal(result.code, lostAck ? 'CONNECTION_LOST' : 'DEADLINE_EXCEEDED');
      assert.deepEqual(await runtime.act('owner', action, f.execution.signal), result);
      assert.equal(f.state.commands.filter(m => m === 'Input.insertText').length, 1);
    } finally { await runtime.dispose(); }
  }
});

test('native radio selection clicks once, no-ops when selected and releases action binding', async () => {
  const f=fixture(); f.state.role='radio'; f.state.checked=false; const released=[];
  f.state.onCommand=(method,p)=>{if(method==='Runtime.releaseObject') released.push(p.objectId);};
  const o=await f.provider.observe(lease,f.execution.signal), action={kind:'check',ref:o.nodes[0].id,checked:true};
  assert.equal((await f.provider.act(lease,request(o,action),f.execution)).postcondition,'passed');
  assert.equal(f.state.checked,true); assert.equal(f.state.dispatches,2);
  assert.equal((await f.provider.act(lease,request(o,action),f.execution)).postcondition,'passed');
  assert.equal(f.state.dispatches,2);
  assert.deepEqual(released,['radio-binding-17','object-17','radio-binding-17','object-17']);
});

test('radio deselection and custom radio are refused before input including already-desired cases', async () => {
  for(const checked of [true,false]) for(const customRadio of [true,false]) {
    const f=fixture(); Object.assign(f.state,{role:'radio',checked,customRadio});
    const o=await f.provider.observe(lease,f.execution.signal);
    const action={kind:'check',ref:o.nodes[0].id,checked:customRadio?true:false};
    await assert.rejects(f.provider.act(lease,request(o,action),f.execution),{code:'UNSUPPORTED_CAPABILITY'});
    assert.equal(f.state.dispatches,0);
  }
});

test('radio group changes during final hit testing fail before input and release binding', async () => {
  const f=fixture(); f.state.role='radio'; f.state.checked=false; const released=[];
  f.state.onCommand=(method,p)=>{
    if(method==='Runtime.releaseObject') released.push(p.objectId);
    if(method==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('getClientRects')&&p.arguments) f.state.radioChanged=true;
  };
  const o=await f.provider.observe(lease,f.execution.signal);
  await assert.rejects(f.provider.act(lease,request(o,{kind:'check',ref:o.nodes[0].id,checked:true}),f.execution),{code:'STALE_TARGET'});
  assert.equal(f.state.dispatches,0); assert.deepEqual(released,['radio-binding-17','object-17']);
});

test('radio post-click binding change cannot be reported as verified selection', async () => {
  const f=fixture(); f.state.role='radio'; f.state.checked=false;
  f.state.onCommand=(method,p)=>{if(method==='Input.dispatchMouseEvent'&&p.type==='mouseReleased') f.state.radioChanged=true;};
  const o=await f.provider.observe(lease,f.execution.signal);
  await assert.rejects(f.provider.act(lease,request(o,{kind:'check',ref:o.nodes[0].id,checked:true}),f.execution),{code:'STALE_TARGET'});
  assert.equal(f.state.checked,true); assert.equal(f.state.dispatches,2);
});

test('check uses and releases an exact label surface while observing the original input', async () => {
  const f = fixture(); f.state.role='checkbox'; f.state.checked=false;
  const released=[], geometryObjects=[], scrolls=[]; let inViewport=false;
  f.state.onCommand = (method,p) => {
    if (method==='Runtime.releaseObject') released.push(p.objectId);
    if (method==='DOM.scrollIntoViewIfNeeded') {scrolls.push(p); inViewport=true; return {};}
    if (method!=='Runtime.callFunctionOn') return;
    if (p.returnByValue===false) return {result:{objectId:'label-17'}};
    if (p.functionDeclaration.includes('this.control===input')) {
      assert.equal(p.objectId,'label-17'); assert.deepEqual(p.arguments,[{objectId:'object-17'}]);
      return {result:{value:true}};
    }
    if (p.functionDeclaration.includes('getClientRects')) {
      geometryObjects.push(p.objectId);
      return {result:{value:{ok:p.objectId==='label-17'&&inViewport,eligible:true,connected:true,inViewport,
        x:50,y:50,left:0,top:30,width:100,height:40,tag:p.objectId==='label-17'?'LABEL':'INPUT'}}};
    }
  };
  const o=await f.provider.observe(lease,f.execution.signal);
  const result=await f.provider.act(lease,request(o,{kind:'check',ref:o.nodes[0].id,checked:true}),f.execution);
  assert.equal(result.postcondition,'passed'); assert.equal(result.observation.nodes[0].checked,true);
  assert.deepEqual(scrolls,[{objectId:'label-17'}]);
  assert.equal(geometryObjects[0],'object-17'); assert.ok(geometryObjects.slice(1).every(id=>id==='label-17'));
  assert.deepEqual(released,['label-17','object-17']);
});

test('label reassociation in the final point check fails before input and releases both objects', async () => {
  const f=fixture(); f.state.role='checkbox'; f.state.checked=false;
  const released=[]; let valid=true;
  f.state.onCommand=(method,p)=>{
    if(method==='Runtime.releaseObject') released.push(p.objectId);
    if(method!=='Runtime.callFunctionOn') return;
    if(p.returnByValue===false) return {result:{objectId:'label-17'}};
    if(p.functionDeclaration.includes('this.control===input')) return {result:{value:valid}};
    if(p.functionDeclaration.includes('getClientRects')) {
      if(p.arguments) valid=false;
      return {result:{value:{ok:p.objectId==='label-17',eligible:true,connected:true,inViewport:true,x:50,y:50,left:0,top:30,width:100,height:40}}};
    }
  };
  const o=await f.provider.observe(lease,f.execution.signal);
  await assert.rejects(f.provider.act(lease,request(o,{kind:'check',ref:o.nodes[0].id,checked:true}),f.execution),{code:'STALE_TARGET'});
  assert.equal(f.state.dispatches,0); assert.deepEqual(released,['label-17','object-17']);
});

test('no-op check and ordinary click never resolve alternate label surfaces', async () => {
  for(const kind of ['check','click']) {
    const f=fixture(); f.state.role='checkbox'; f.state.checked=true; f.state.covered=true;
    f.state.onCommand=(method,p)=>{if(method==='Runtime.callFunctionOn') assert.notEqual(p.returnByValue,false);};
    const o=await f.provider.observe(lease,f.execution.signal);
    const action=kind==='check'?{kind,ref:o.nodes[0].id,checked:true}:{kind,ref:o.nodes[0].id};
    const run=f.provider.act(lease,request(o,action,60),f.execution);
    if(kind==='check') assert.equal((await run).postcondition,'passed');
    else await assert.rejects(run,{code:'DEADLINE_EXCEEDED'});
    assert.equal(f.state.dispatches,0);
  }
});

test('check observes state, clicks only for a change and verifies the requested boolean', async () => {
  const f = fixture(); f.state.role = 'checkbox'; f.state.checked = false;
  const o = await f.provider.observe(lease, f.execution.signal), ref = o.nodes[0].id;
  assert.equal(o.nodes[0].checked, false);
  assert.equal((await f.provider.act(lease, request(o, { kind: 'check', ref, checked: false }), f.execution)).postcondition, 'passed');
  assert.equal(f.state.dispatches, 0);
  const changed = await f.provider.act(lease, request(o, { kind: 'check', ref, checked: true }), f.execution);
  assert.equal(changed.postcondition, 'passed'); assert.equal(changed.observation.nodes[0].checked, true);
  assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
  await f.provider.act(lease, request(o, { kind: 'check', ref, checked: true }), f.execution);
  assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
});

test('check refuses non-checkbox targets and AX/DOM disagreement without clicking', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'check', ref: o.nodes[0].id, checked: true }), f.execution), { code: 'UNSUPPORTED_CAPABILITY' });
  f.state.role = 'checkbox'; f.state.checked = false; f.state.axChecked = true;
  const next = await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, request(next, { kind: 'check', ref: next.nodes[0].id, checked: true }, 50), f.execution), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(f.state.dispatches, 0);
});

test('check sends at most one click when the page refuses to change', async () => {
  const f = fixture(); f.state.role = 'switch'; f.state.checked = false; f.state.preventCheck = true;
  const o = await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'check', ref: o.nodes[0].id, checked: true }, 130), f.execution), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
});

test('check skips input if another actor reaches the desired state while geometry is settling', async () => {
  const f = fixture(); f.state.role = 'checkbox'; f.state.checked = false;
  const o = await f.provider.observe(lease, f.execution.signal);
  f.state.onCommand = async (method, p) => { if (method === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('getClientRects')) f.state.checked = true; };
  assert.equal((await f.provider.act(lease, request(o, { kind: 'check', ref: o.nodes[0].id, checked: true }), f.execution)).postcondition, 'passed');
  assert.equal(f.state.dispatches, 0);
});

test('query-discovered targets retain exact action identities and search does not invalidate other refs', async () => {
  const f = fixture(), before = await f.provider.observe(lease, f.execution.signal);
  f.state.onCommand = async (method, params) => {
    if (method === 'ax.find') { assert.deepEqual(params.query, { name: 'Search', role: 'textbox' }); return { nodes: [{ backendDOMNodeId: 17, role: { value: 'textbox' }, name: { value: 'Search' } }] }; }
  };
  const found = await f.provider.find(lease, { name: 'Search', role: 'textbox' }, f.execution.signal);
  assert.equal(found.nodes[0].id, before.nodes[0].id);
  assert.deepEqual(found.scope, { kind: 'query', query: { name: 'Search', role: 'textbox' } });
  assert.equal((await f.provider.act(lease, request(found, { kind: 'fill', ref: found.nodes[0].id, text: 'found' }), f.execution)).postcondition, 'passed');
  f.state.name = 'Replacement';
  await assert.rejects(f.provider.act(lease, request(found, { kind: 'click', ref: found.nodes[0].id }), f.execution), e => e.code === 'STALE_TARGET');
});

test('unknown contextual query roots fail before source search rather than broadening scope', async () => {
  const f = fixture();
  await assert.rejects(f.provider.find(lease, { name: 'Search' }, f.execution.signal, 'unknown'), e => e.code === 'STALE_TARGET');
  assert.equal(f.state.commands.includes('ax.find'), false);
});

test('truncated source discovery does not mistake unseen targets for removed targets', async () => {
  const f = fixture(), original = await f.provider.observe(lease, f.execution.signal);
  f.state.onCommand = async method => method === 'Accessibility.getFullAXTree' ? { nodes: [], truncated: true } : undefined;
  assert.equal((await f.provider.observe(lease, f.execution.signal)).truncated, true);
  const result = await f.provider.act(lease, request(original, { kind: 'fill', ref: original.nodes[0].id, text: 'still same target' }), f.execution);
  assert.equal(result.postcondition, 'passed');
  f.state.onCommand = async method => method === 'Accessibility.getFullAXTree' ? { nodes: [], truncated: false } : undefined;
  await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, request(original, { kind: 'fill', ref: original.nodes[0].id, text: 'do not type' }), f.execution), e => e.code === 'STALE_TARGET');
});

test('click rechecks the exact selected point after identity validation and never dispatches a stale point', async () => {
  for (const change of ['covered', 'moved']) {
    const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
    f.state.onCommand = async (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('getClientRects') && p.arguments) {
        assert.deepEqual(p.arguments, [{ value: { x: 50, y: 50 } }]);
        return { result: { value: { connected: true, ok: change !== 'covered', x: 50, y: 50, left: 20, top: 30, width: 100, height: 40 } } };
      }
    };
    await assert.rejects(f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id }), f.execution), e => e.code === 'NOT_ACTIONABLE');
    assert.equal(f.state.commands.includes('Input.dispatchMouseEvent'), false); assert.equal(f.state.dispatches, 0);
  }
});

test('Chromium references survive unrelated observation but change on identity or document replacement', async () => {
  const { provider, state, execution } = fixture();
  const a = await provider.observe(lease, execution.signal);
  const b = await provider.observe(lease, execution.signal);
  assert.equal(a.nodes[0].id, b.nodes[0].id);
  state.name = 'Different';
  const c = await provider.observe(lease, execution.signal);
  assert.notEqual(c.nodes[0].id, a.nodes[0].id);
  state.loader = 'loader-2';
  const d = await provider.observe(lease, execution.signal);
  assert.notEqual(d.documentEpoch, c.documentEpoch);
});

test('Chromium fill dispatches real input and verifies the value', async () => {
  const { provider, state, execution } = fixture();
  const o = await provider.observe(lease, execution.signal);
  const result = await provider.act(lease, { requestId: 'r', leaseId: lease.id, documentEpoch: o.documentEpoch,
    action: { kind: 'fill', ref: o.nodes[0].id, text: '中文输入' } }, execution);
  assert.equal(result.postcondition, 'passed'); assert.equal(state.value, '中文输入');
  assert.ok(state.commands.includes('Input.insertText')); assert.equal(state.dispatches, 2);
});

test('persistently covered target times out before any input', async () => {
  const { provider, state, execution } = fixture();
  const o = await provider.observe(lease, execution.signal); state.covered = true;
  await assert.rejects(provider.act(lease, { requestId: 'r', leaseId: lease.id, documentEpoch: o.documentEpoch, timeoutMs: 30,
    action: { kind: 'click', ref: o.nodes[0].id } }, execution), e => e.code === 'DEADLINE_EXCEEDED');
  assert.equal(state.dispatches, 0);
});

test('removed semantic identity never rebinds to a similar replacement', async () => {
  const { provider, state, execution } = fixture();
  const o = await provider.observe(lease, execution.signal); state.name = 'Delete account';
  await assert.rejects(provider.act(lease, { requestId: 'r', leaseId: lease.id, documentEpoch: o.documentEpoch,
    action: { kind: 'click', ref: o.nodes[0].id } }, execution), e => e.code === 'STALE_TARGET');
  assert.equal(state.dispatches, 0);
});

test('temporary cover waits; an event during a predicate is not lost; input is sent once', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  f.state.covered = true;
  let checks = 0;
  f.state.onCommand = async (method, p) => {
    if (method === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('getBoundingClientRect') && ++checks === 2) {
      f.state.covered = false; f.pulse();
    }
  };
  const result = await f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: 'ready' }), f.execution);
  assert.equal(result.postcondition, 'passed');
  assert.equal(f.state.commands.filter(m => m === 'Input.insertText').length, 1);
  assert.equal(f.listeners.size, 0);
});

test('offscreen input is scrolled once and empty fill uses real Backspace', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  f.state.inViewport = false; f.state.value = 'old';
  const result = await f.provider.act(lease, request(o, { kind: 'fill', ref: o.nodes[0].id, text: '' }), f.execution);
  assert.equal(result.postcondition, 'passed'); assert.equal(f.state.value, '');
  assert.equal(f.state.commands.filter(m => m === 'DOM.scrollIntoViewIfNeeded').length, 1);
  assert.equal(f.state.commands.filter(m => m === 'Input.dispatchKeyEvent').length, 2);
});

test('cancellation while covered never sends input and removes subscriptions', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  const controller = new AbortController(); f.state.covered = true;
  f.state.onCommand = async method => { if (method === 'Runtime.callFunctionOn') controller.abort(); };
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id }),
    { ...f.execution, signal: controller.signal }), e => e.code === 'CANCELLED');
  assert.equal(f.state.dispatches, 0); assert.equal(f.listeners.size, 0);
});

test('semantic identity change during waiting fails without rebinding or input', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal); f.state.covered = true;
  f.state.onCommand = async method => { if (method === 'Runtime.callFunctionOn') { f.state.name = 'Replacement'; f.pulse(); } };
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id }), f.execution), e => e.code === 'STALE_TARGET');
  assert.equal(f.state.dispatches, 0);
});

test('text postcondition waits for delayed feedback without repeating click', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  let clicked = false, checks = 0;
  f.state.onCommand = async (method, p) => {
    if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') clicked = true;
    if (method === 'Accessibility.getFullAXTree' && clicked && ++checks === 3) { f.state.text = ['Saved successfully']; f.pulse(); }
  };
  const result = await f.provider.act(lease, request(o, { kind: 'click', ref: o.nodes[0].id, expected: { kind: 'text', text: 'Saved successfully' } }), f.execution);
  assert.equal(result.postcondition, 'passed'); assert.equal(checks, 3);
  assert.equal(f.state.commands.filter(m => m === 'Input.dispatchMouseEvent').length, 2);
});

test('navigation rejects cross-origin and malformed URLs before dispatch', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  for (const url of ['https://elsewhere.test/', 'javascript:alert(1)', 'not a URL', 'https://user:pass@example.test/']) {
    await assert.rejects(f.provider.act(lease, request(o, { kind: 'navigate', url }), f.execution), e => e.code === 'POLICY_DENIED');
  }
  assert.equal(f.state.dispatches, 0);
});

test('navigation waits for returned loader and document readiness, not old matching text', async () => {
  const f = fixture(); const o = await f.provider.observe(lease, f.execution.signal);
  let navigating = false, checks = 0;
  f.state.onCommand = async method => {
    if (method === 'Page.navigate') { navigating = true; return { loaderId: 'loader-next' }; }
    if (method === 'Page.getFrameTree' && navigating) {
      checks++;
      if (checks === 3) { f.state.loader = 'loader-next'; f.state.ready = 'loading'; }
      if (checks === 4) f.state.ready = 'complete';
    }
  };
  const result = await f.provider.act(lease, request(o, { kind: 'navigate', url: f.state.url, expected: { kind: 'text', text: 'Fixture' } }), f.execution);
  assert.equal(result.postcondition, 'passed'); assert.ok(checks >= 4);
  assert.equal(result.observation.documentEpoch, 'frame:loader-next'); assert.equal(f.state.dispatches, 1);
});

test('text observation has fragment and byte budgets without exposing AX values', async () => {
  const f = fixture(); f.state.text = Array.from({ length: 300 }, () => '可见文本'); f.state.value = 'not observation text';
  const o = await f.provider.observe(lease, f.execution.signal);
  assert.equal(o.text.length, 240); assert.equal(o.truncated, true);
  assert.ok(!JSON.stringify(o).includes(f.state.value));
  f.state.text = ['长'.repeat(12000), 'small'];
  const b = await f.provider.observe(lease, f.execution.signal);
  assert.deepEqual(b.text, ['small']); assert.equal(b.truncated, true);
});

test('post-dispatch timeout is unknown in runtime and retrying the request never repeats input', async () => {
  const f = fixture(); const runtime = new BrowserRuntime(async () => true); runtime.register(f.provider);
  try {
    const l = await runtime.claim('owner', instance.id, 'tab', f.execution.signal);
    const o = await runtime.observe('owner', l.id, f.execution.signal);
    const r = { ...request(o, { kind: 'click', ref: o.nodes[0].id, expected: { kind: 'text', text: 'never appears' } }, 150), leaseId: l.id };
    const result = await runtime.act('owner', r, f.execution.signal);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.code, 'DEADLINE_EXCEEDED'); assert.equal(result.dispatch, 'dispatched');
    assert.deepEqual(await runtime.act('owner', r, f.execution.signal), result);
    assert.equal(f.state.commands.filter(m => m === 'Input.dispatchMouseEvent').length, 2);
  } finally { await runtime.dispose(); }
});

test('screenshot retries only stale captures and returns matching viewport metadata', async () => {
  const f = fixture(); let metrics = 0;
  f.state.onCommand = async method => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: {
      clientWidth: 800, clientHeight: 600, pageX: 0, pageY: ++metrics === 1 ? 0 : 30,
    } };
  };
  const image = await f.provider.capture(lease, f.execution.signal);
  assert.equal(image.viewport.pageY, 30);
  assert.equal(f.state.commands.filter(m => m === 'Page.captureScreenshot').length, 2);
  assert.equal(f.state.dispatches, 0); assert.equal(f.listeners.size, 0);
});

test('screenshot never retries a cross-origin policy failure', async () => {
  const f = fixture(); f.state.url = 'https://elsewhere.test/';
  await assert.rejects(f.provider.capture(lease, f.execution.signal), e => e.code === 'POLICY_DENIED');
  assert.equal(f.state.commands.filter(m => m === 'Page.captureScreenshot').length, 0);
  assert.equal(f.listeners.size, 0);
});

function scopedFixture() {
  const f = fixture();
  f.region = { backendDOMNodeId: 30, role: { value: 'region' }, name: { value: 'Checkout' } };
  f.inside = { backendDOMNodeId: 31, role: { value: 'button' }, name: { value: 'Save' } };
  f.outside = { backendDOMNodeId: 17, role: { value: 'textbox' }, name: { value: f.state.name }, properties: [{ name: 'focused', value: { value: true } }] };
  f.bodyText = value => ({ role: { value: 'StaticText' }, name: { value } });
  f.state.onCommand = async (method, p) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [f.region, f.inside, f.outside, f.bodyText('Inside'), f.bodyText('Outside')] };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [f.region, f.inside, f.outside].filter(n => n.backendDOMNodeId === p.backendNodeId) };
    if (method === 'Accessibility.queryAXTree') { assert.deepEqual(p, { backendNodeId: 30 }); return { nodes: [f.region, f.inside, f.bodyText('Inside')] }; }
  };
  return f;
}

test('subtree reads query the known region at source and preserve references outside its view', async () => {
  const f = scopedFixture(), before = await f.provider.observe(lease, f.execution.signal);
  const region = before.nodes.find(n => n.kind === 'region'); assert.equal(region.name, 'Checkout');
  const inside = before.nodes.find(n => n.name === 'Save'), outside = before.nodes.find(n => n.name === 'Search');
  f.state.commands.length = 0;
  const view = await f.provider.observeSubtree(lease, region.id, f.execution.signal);
  assert.deepEqual(view.scope, { kind: 'subtree', rootRef: region.id });
  assert.deepEqual(view.text, ['Inside']); assert.equal(view.truncated, false);
  assert.deepEqual(view.nodes.map(n => n.id), [region.id, inside.id]);
  assert.equal(f.state.commands.includes('Accessibility.getFullAXTree'), false);
  assert.equal(f.state.commands.filter(m => m === 'Accessibility.queryAXTree').length, 1);
  assert.equal((await f.provider.act(lease, request(before, { kind: 'fill', ref: outside.id, text: 'Kept' }), f.execution)).postcondition, 'passed');
});

test('unknown, replaced and old-document read roots fail without falling back to a full page', async () => {
  const f = scopedFixture(), before = await f.provider.observe(lease, f.execution.signal);
  const region = before.nodes.find(n => n.kind === 'region');
  f.state.commands.length = 0;
  await assert.rejects(f.provider.observeSubtree(lease, 'guessed', f.execution.signal), e => e.code === 'STALE_TARGET');
  f.region = { ...f.region, name: { value: 'Replacement' } };
  await assert.rejects(f.provider.observeSubtree(lease, region.id, f.execution.signal), e => e.code === 'STALE_TARGET');
  f.state.loader = 'new-document';
  await assert.rejects(f.provider.observeSubtree(lease, region.id, f.execution.signal), e => e.code === 'STALE_TARGET');
  assert.equal(f.state.commands.includes('Accessibility.getFullAXTree'), false);
  assert.equal(f.state.commands.includes('Accessibility.queryAXTree'), false);
});

test('a root changed during a subtree read cannot return stale content', async () => {
  const f = scopedFixture(), before = await f.provider.observe(lease, f.execution.signal);
  const region = before.nodes.find(n => n.kind === 'region'), original = f.state.onCommand;
  f.state.onCommand = async (method, p) => {
    const result = await original(method, p);
    if (method === 'Accessibility.queryAXTree') f.region = { ...f.region, ignored: true };
    return result;
  };
  await assert.rejects(f.provider.observeSubtree(lease, region.id, f.execution.signal), e => e.code === 'STALE_TARGET');
});

test('named observation regions cannot receive click or fill input', async () => {
  const f = scopedFixture(), before = await f.provider.observe(lease, f.execution.signal);
  const region = before.nodes.find(n => n.kind === 'region');
  for (const action of [{ kind: 'click', ref: region.id }, { kind: 'fill', ref: region.id, text: 'no' }]) {
    await assert.rejects(f.provider.act(lease, request(before, action), f.execution), e => e.code === 'NOT_ACTIONABLE');
  }
  assert.equal(f.state.dispatches, 0);
});

test('oversized observations retain only emitted reference identities, not the entire AX tree', async () => {
  const f = fixture();
  f.state.onCommand = async method => method === 'Accessibility.getFullAXTree' ? { nodes: Array.from({ length: 3000 }, (_, i) =>
    ({ backendDOMNodeId: i + 1, role: { value: 'button' }, name: { value: `Action ${i}` } })) } : undefined;
  const before = await f.provider.observe(lease, f.execution.signal), after = await f.provider.observe(lease, f.execution.signal);
  assert.equal(before.nodes.length, 120); assert.equal(before.truncated, true);
  assert.deepEqual(before.nodes, after.nodes);
  assert.equal(f.provider.pages.get(lease.tab).byRef.size, 120);
  assert.equal(f.provider.pages.get(lease.tab).byBackend.size, 120);
});

test('repeated subtree reads bound retained identities and expired refs never rebind', async () => {
  const f = scopedFixture(), before = await f.provider.observe(lease, f.execution.signal);
  const region = before.nodes.find(n => n.kind === 'region'), original = f.state.onCommand;
  let batch = 0, first;
  f.state.onCommand = (method, p) => method === 'Accessibility.queryAXTree' ? { nodes: [f.region,
    ...Array.from({ length: 120 }, (_, i) => ({ backendDOMNodeId: 10000 + batch * 120 + i,
      role: { value: 'button' }, name: { value: `Action ${batch}-${i}` } }))] } : original(method, p);
  for (batch = 0; batch < 25; batch++) {
    const view = await f.provider.observeSubtree(lease, region.id, f.execution.signal);
    first ??= view.nodes.find(n => n.role === 'button');
    assert.equal(view.nodes.find(n => n.kind === 'region').id, region.id);
  }
  assert.equal(f.provider.pages.get(lease.tab).byRef.size, 2048);
  assert.equal(f.provider.pages.get(lease.tab).byBackend.size, 2048);
  await assert.rejects(f.provider.act(lease, request(before, { kind: 'click', ref: first.id }), f.execution), e => e.code === 'STALE_TARGET');
  assert.equal(f.state.dispatches, 0);
});

test('subtree transport failures are not hidden by a whole-document fallback', async () => {
  const f = scopedFixture(), before = await f.provider.observe(lease, f.execution.signal);
  const region = before.nodes.find(n => n.kind === 'region'), original = f.state.onCommand;
  const unavailable = new Error('Simulated unsupported query or bridge size failure');
  f.state.commands.length = 0;
  f.state.onCommand = (method, p) => { if (method === 'Accessibility.queryAXTree') throw unavailable; return original(method, p); };
  await assert.rejects(f.provider.observeSubtree(lease, region.id, f.execution.signal), error => error === unavailable);
  assert.equal(f.state.commands.includes('Accessibility.getFullAXTree'), false);
});

test('press focuses the exact target, emits one key pair and verifies the result', async () => {
  const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
  f.state.onCommand = async (method, p) => {
    if (method === 'Input.dispatchKeyEvent' && p.type === 'keyDown') f.state.text = ['Keyboard saved'];
  };
  const result = await f.provider.act(lease, request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Enter',
    expected: { kind: 'text', text: 'Keyboard saved' } }), f.execution);
  assert.equal(result.postcondition, 'passed');
  assert.deepEqual(f.state.keyEvents.map(e => [e.type, e.key, e.modifiers]), [['keyDown', 'Enter', 0], ['keyUp', 'Enter', 0]]);
  assert.equal(f.state.keyEvents[0].text, '\r'); assert.equal(f.state.dispatches, 3);
  assert.equal(f.state.commands.includes('Input.dispatchMouseEvent'), false);
});

test('Shift+Tab is encoded without system modifiers and no expected result stays unverified', async () => {
  const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
  const result = await f.provider.act(lease, request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Tab', shift: true }), f.execution);
  assert.equal(result.postcondition, 'unverified');
  assert.deepEqual(f.state.keyEvents.map(e => e.modifiers), [8, 8]);
  assert.equal(f.state.keyEvents[0].text, undefined);
});

test('focus stolen during focus or its final check prevents both press and fill input', async () => {
  for (const kind of ['press', 'fill']) for (const stage of ['focus', 'check']) {
    const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
    f.state.onCommand = async (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration.includes(stage === 'focus' ? 'this.focus({' : 'disabled:!!this.disabled')) f.state.focused = false;
    };
    const action = kind === 'press' ? { kind, ref: o.nodes[0].id, key: 'Enter' } : { kind, ref: o.nodes[0].id, text: 'must not type' };
    await assert.rejects(f.provider.act(lease, request(o, action), f.execution), e => e.code === 'NOT_ACTIONABLE');
    assert.equal(f.state.keyEvents.length, 0); assert.equal(f.state.commands.includes('Input.insertText'), false);
    assert.equal(f.state.dispatches, 1, 'Focus may have run; do not call this notDispatched');
  }
});

test('identity replacement or cancellation during focus sends no key', async () => {
  for (const event of ['replace', 'cancel']) {
    const f = fixture(), o = await f.provider.observe(lease, f.execution.signal), controller = new AbortController();
    f.state.onCommand = async (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('typeof this.focus')) {
        if (event === 'replace') f.state.name = 'Different target'; else controller.abort();
      }
    };
    await assert.rejects(f.provider.act(lease, request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Enter' }),
      { ...f.execution, signal: controller.signal }), e => e.code === (event === 'replace' ? 'STALE_TARGET' : 'CANCELLED'));
    assert.equal(f.state.keyEvents.length, 0);
  }
});

test('keyboard input on a password field and unknown keys are refused before focus', async () => {
  const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Control+L' }), f.execution), e => e.code === 'INVALID_REQUEST');
  f.state.onCommand = async (method, p) => method === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('getBoundingClientRect')
    ? { result: { value: { connected: true, ok: true, x: 50, y: 50, left: 0, top: 30, width: 100, height: 40, tag: 'INPUT', type: 'password' } } } : undefined;
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Enter' }), f.execution), e => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.equal(f.state.dispatches, 0); assert.equal(f.state.keyEvents.length, 0);
});

test('lost keyboard result remains unknown and the request journal prevents a second keydown', async () => {
  const f = fixture(), runtime = new BrowserRuntime(async () => true); runtime.register(f.provider);
  try {
    const l = await runtime.claim('owner', instance.id, 'tab', f.execution.signal), o = await runtime.observe('owner', l.id, f.execution.signal);
    const r = { ...request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Enter', expected: { kind: 'text', text: 'never' } }, 150), leaseId: l.id };
    const result = await runtime.act('owner', r, f.execution.signal);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.code, 'DEADLINE_EXCEEDED');
    assert.deepEqual(await runtime.act('owner', r, f.execution.signal), result);
    assert.equal(f.state.keyEvents.filter(e => e.type === 'keyDown').length, 1);
  } finally { await runtime.dispose(); }
});

test('page-reported focus alone cannot bypass browser AX focus verification', async () => {
  const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
  f.state.focused = true; f.state.axFocused = false;
  await assert.rejects(f.provider.act(lease, request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Enter' }), f.execution), e => e.code === 'NOT_ACTIONABLE');
  assert.equal(f.state.keyEvents.length, 0);
});

test('lost key-up acknowledgement is unknown and never causes a repeated keydown', async () => {
  const f = fixture(), runtime = new BrowserRuntime(async () => true); runtime.register(f.provider);
  try {
    const l = await runtime.claim('owner', instance.id, 'tab', f.execution.signal), o = await runtime.observe('owner', l.id, f.execution.signal);
    f.state.onCommand = async (method, p) => { if (method === 'Input.dispatchKeyEvent' && p.type === 'keyUp') throw new BrowserError('CONNECTION_LOST', 'Lost acknowledgement'); };
    const r = { ...request(o, { kind: 'press', ref: o.nodes[0].id, key: 'Enter' }), leaseId: l.id };
    const result = await runtime.act('owner', r, f.execution.signal);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.code, 'CONNECTION_LOST');
    assert.deepEqual(await runtime.act('owner', r, f.execution.signal), result);
    assert.deepEqual(f.state.keyEvents.map(e => e.type), ['keyDown', 'keyUp']);
  } finally { await runtime.dispose(); }
});
