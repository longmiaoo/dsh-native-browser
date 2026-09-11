import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { actionRequest, scrollDelta } from '../dist/packages/contracts/src/validation.js';
import { scrollMovedAsRequested, validateScrollEvidence } from '../dist/packages/contracts/src/scrolling.js';
import { scrollByFunction, scrollStateFunction } from '../dist/packages/provider-chromium/src/scroll.js';

const instance = { id: 'scroll-browser', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', instanceId: instance.id, tab: 'tab', token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 60000 };
const signal = () => new AbortController().signal;
const position = () => ({ x: 0, y: 0, scrollWidth: 1000, scrollHeight: 1000, clientWidth: 200, clientHeight: 400 });
const request = (action, epoch = 'frame:loader', timeoutMs = 1000) => ({ requestId: 'scroll', leaseId: lease.id, documentEpoch: epoch, action, timeoutMs });
function fixture() {
  const state = { url: 'https://example.test/', loader: 'loader', name: 'Pane', commands: [], scrollCalls: 0,
    document: position(), pane: position(), connected: true, rtl: false, onCall: undefined };
  const provider = new ChromiumProvider(instance, { async call(method, params) {
    if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: state.url, title: 'Fixture' }];
    if (method === 'ax.read') { method = 'cdp'; params = { method: 'Accessibility.getFullAXTree', params: params.request }; }
    if (method !== 'cdp') return {};
    const { method: command, params: p } = params; state.commands.push({ method: command, params: p });
    const custom = await state.onCall?.(command, p); if (custom !== undefined) return custom;
    if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: state.loader, url: state.url } } };
    if (command.startsWith('Accessibility.')) return { nodes: [{ backendDOMNodeId: 30, role: { value: 'region' }, name: { value: state.name } }] };
    if (command === 'DOM.getDocument') { assert.deepEqual(p, { depth: 0, pierce: false }); return { root: { backendNodeId: 1 } }; }
    if (command === 'DOM.resolveNode') return { object: { objectId: `object-${p.backendNodeId}` } };
    const target = p.objectId === 'object-1' ? state.document : state.pane;
    if (command === 'Runtime.callFunctionOn' && p.functionDeclaration === scrollStateFunction) {
      return { result: { value: { connected: state.connected, canScroll: true, ...target } } };
    }
    if (command === 'Runtime.callFunctionOn' && p.functionDeclaration === scrollByFunction) {
      state.scrollCalls++;
      const [x, y] = p.arguments.map(arg => arg.value);
      target.x = state.rtl ? Math.max(-(target.scrollWidth - target.clientWidth), Math.min(0, target.x + x))
        : Math.max(0, Math.min(target.scrollWidth - target.clientWidth, target.x + x));
      target.y = Math.max(0, Math.min(target.scrollHeight - target.clientHeight, target.y + y));
    }
    return {};
  } });
  const execution = { signal: signal(), onDispatch() {} };
  return { state, provider, execution };
}

test('scroll contract rejects unbounded/zero deltas, arbitrary fields and value expectations', () => {
  const action = { kind: 'scroll', deltaX: 0, deltaY: 120 };
  assert.deepEqual(actionRequest(request(action)).action, action);
  for (const patch of [{ deltaX: 0, deltaY: 0 }, { deltaX: NaN }, { deltaY: Infinity }, { deltaY: 10001 },
    { deltaX: 0.5 }, { deltaY: '120' }, { behavior: 'smooth' }, { expected: { kind: 'value', value: 'x' } }]) {
    assert.throws(() => actionRequest(request({ ...action, ...patch })), e => e.code === 'INVALID_REQUEST');
  }
  assert.deepEqual(scrollDelta({ deltaX: -10000, deltaY: 10000 }), { deltaX: -10000, deltaY: 10000 });
});

test('scroll evidence binds target/deltas, preserves negative offsets and rejects false movement', () => {
  const action = { kind: 'scroll', ref: 'pane', deltaX: -120, deltaY: 0 };
  const evidence = { target: { kind: 'element', ref: 'pane' }, requested: { deltaX: -120, deltaY: 0 },
    before: position(), after: { ...position(), x: -120 }, moved: true };
  assert.deepEqual(validateScrollEvidence(evidence, action), evidence);
  assert.equal(scrollMovedAsRequested(evidence), true);
  for (const patch of [{ target: { kind: 'document' } }, { requested: { deltaX: 120, deltaY: 0 } }, { moved: false },
    { after: { ...position(), x: Infinity } }]) assert.throws(() => validateScrollEvidence({ ...evidence, ...patch }, action), e => e.code === 'INVALID_REQUEST');
  assert.equal(scrollMovedAsRequested({ ...evidence, after: { ...position(), x: 120 } }), false);
});

test('document scroll returns measured offsets after one dispatch', async () => {
  const f = fixture();
  const result = await f.provider.act(lease, request({ kind: 'scroll', deltaX: 0, deltaY: 200 }), f.execution);
  assert.equal(result.postcondition, 'passed'); assert.equal(result.scroll.before.y, 0); assert.equal(result.scroll.after.y, 200);
  assert.deepEqual(result.scroll.target, { kind: 'document' }); assert.equal(f.state.scrollCalls, 1);
  assert.equal(f.state.commands.filter(c => c.method === 'Runtime.releaseObject').length, 1);
});

test('scrolling a known region changes only that element and preserves signed RTL offsets', async () => {
  const f = fixture(), o = await f.provider.observe(lease, f.execution.signal); f.state.rtl = true;
  const result = await f.provider.act(lease, request({ kind: 'scroll', ref: o.nodes[0].id, deltaX: -150, deltaY: 200 }), f.execution);
  assert.equal(result.postcondition, 'passed'); assert.equal(result.scroll.after.x, -150); assert.equal(result.scroll.after.y, 200);
  assert.deepEqual(f.state.document, position()); assert.equal(f.state.commands.some(c => c.method === 'DOM.getDocument'), false);
  assert.equal(f.state.commands.some(c => c.method === 'DOM.scrollIntoViewIfNeeded'), false);
});

test('clamped boundary with no movement is not fabricated as success', async () => {
  const f = fixture(); f.state.document.y = 600;
  const result = await f.provider.act(lease, request({ kind: 'scroll', deltaX: 0, deltaY: 200 }), f.execution);
  assert.equal(result.postcondition, 'unverified'); assert.equal(result.scroll.moved, false);
  assert.deepEqual(result.scroll.before, result.scroll.after); assert.equal(f.state.scrollCalls, 1);
});

test('invalid, unknown and old-document scroll requests cannot dispatch', async () => {
  const f = fixture();
  for (const [r, code] of [[request({ kind: 'scroll', deltaX: 0, deltaY: 0 }), 'INVALID_REQUEST'],
    [request({ kind: 'scroll', deltaX: 0, deltaY: 100 }, 'old-document'), 'STALE_TARGET'],
    [request({ kind: 'scroll', ref: 'unknown', deltaX: 0, deltaY: 100 }), 'STALE_TARGET']]) {
    await assert.rejects(f.provider.act(lease, r, f.execution), e => e.code === code);
  }
  assert.equal(f.state.scrollCalls, 0);
});

test('renamed region after dispatch never rebinds or repeats scrolling', async () => {
  const f = fixture(), o = await f.provider.observe(lease, f.execution.signal);
  f.state.onCall = async (method, p) => { if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === scrollByFunction) f.state.name = 'Replacement'; };
  await assert.rejects(f.provider.act(lease, request({ kind: 'scroll', ref: o.nodes[0].id, deltaX: 0, deltaY: 100 }), f.execution), e => e.code === 'STALE_TARGET');
  assert.equal(f.state.scrollCalls, 1);
});

test('navigation and cancellation during a scroll reject stale results', async () => {
  for (const mode of ['navigate', 'cancel']) {
    const f = fixture(), controller = new AbortController();
    f.state.onCall = async (method, p) => {
      if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === scrollByFunction) {
        if (mode === 'navigate') f.state.loader = 'replacement'; else controller.abort();
      }
    };
    await assert.rejects(f.provider.act(lease, request({ kind: 'scroll', deltaX: 0, deltaY: 100 }), { ...f.execution, signal: controller.signal }),
      e => e.code === (mode === 'navigate' ? 'STALE_TARGET' : 'CANCELLED'));
    assert.equal(f.state.scrollCalls, 1);
  }
});

test('continually changing scroll offsets share one deadline without reissuing the action', async () => {
  const f = fixture();
  f.state.onCall = async (method, p) => {
    if (method === 'Runtime.callFunctionOn' && p.functionDeclaration === scrollStateFunction && f.state.scrollCalls) f.state.document.y++;
  };
  await assert.rejects(f.provider.act(lease, request({ kind: 'scroll', deltaX: 0, deltaY: 100 }, 'frame:loader', 90), f.execution), e => e.code === 'DEADLINE_EXCEEDED');
  assert.equal(f.state.scrollCalls, 1);
});

test('position changes during final observation discard the stale evidence', async () => {
  const f = fixture();
  f.state.onCall = async method => { if (method === 'Accessibility.getFullAXTree' && f.state.scrollCalls) f.state.document.y += 50; };
  await assert.rejects(f.provider.act(lease, request({ kind: 'scroll', deltaX: 0, deltaY: 100 }), f.execution), e => e.code === 'STALE_TARGET');
  assert.equal(f.state.scrollCalls, 1);
});

test('runtime transports measured scroll evidence and deduplicates physical movement', async () => {
  const f = fixture(), runtime = new BrowserRuntime(async () => true); runtime.register(f.provider);
  try {
    const l = await runtime.claim('owner', instance.id, 'tab', signal());
    const r = { ...request({ kind: 'scroll', deltaX: 0, deltaY: 100 }), leaseId: l.id };
    const result = await runtime.act('owner', r, signal());
    assert.equal(result.outcome, 'succeeded'); assert.equal(result.scroll.after.y, 100);
    assert.deepEqual(await runtime.act('owner', r, signal()), result); assert.equal(f.state.scrollCalls, 1);
  } finally { await runtime.dispose(); }
});

test('runtime refuses success evidence that claims movement on another target or no movement', async () => {
  for (const invalid of ['target', 'movement']) {
    const f = fixture(), runtime = new BrowserRuntime(async () => true); runtime.register(f.provider);
    const act = f.provider.act.bind(f.provider);
    f.provider.act = async (...args) => {
      const result = await act(...args);
      if (invalid === 'target') result.scroll.target = { kind: 'element', ref: 'not-requested' };
      else { result.scroll.after = { ...result.scroll.before }; result.scroll.moved = false; }
      return result;
    };
    try {
      const l = await runtime.claim('owner', instance.id, 'tab', signal());
      const result = await runtime.act('owner', { ...request({ kind: 'scroll', deltaX: 0, deltaY: 100 }), leaseId: l.id }, signal());
      assert.equal(result.outcome, 'unknown'); assert.equal(result.code, 'INVALID_REQUEST');
    } finally { await runtime.dispose(); }
  }
});
