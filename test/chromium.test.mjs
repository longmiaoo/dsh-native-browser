import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { radioBindingFunction, radioBindingCheckFunction } from '../dist/packages/provider-chromium/src/checked.js';
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
    if (method === 'ax.find') { state.commands.push(method); return await state.onCommand?.(method, params.request) ?? { nodes: [] }; }
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
        ...(state.checked === undefined ? [] : [{ name: 'checked', value: { value: state.axChecked ?? state.checked } }])] },
      ...state.text.map(text => ({ role: { value: 'StaticText' }, name: { value: text } }))] };
    if (cdp === 'DOM.resolveNode') return { object: { objectId: 'object-17' } };
    if (cdp === 'Runtime.callFunctionOn' && p.functionDeclaration === radioBindingFunction) return {result:state.customRadio?{value:null}:{objectId:'radio-binding-17'}};
    if (cdp === 'Runtime.callFunctionOn' && p.functionDeclaration === radioBindingCheckFunction) {
      assert.deepEqual(p.arguments,[{objectId:'radio-binding-17'}]);
      return {result:{value:!state.radioChanged}};
    }
    if (cdp === 'Runtime.callFunctionOn' && p.functionDeclaration.includes('aria-checked')) {
      return { result: { value: { connected: state.connected, checked: state.checked } } };
    }
    if (cdp === 'Runtime.callFunctionOn') return { result: { value: { ok: !state.covered && state.inViewport, inViewport: state.inViewport, connected: state.connected,
      x: 50, y: 50, left: 0, top: 30, width: 100, height: 40, tag: 'INPUT', type: 'text', focused: state.focused, value: state.value } } };
    if (cdp === 'Input.insertText') state.value = p.text;
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
