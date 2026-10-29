import assert from 'node:assert/strict';
import test from 'node:test';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';

const instance = { id: 'visual-browser', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', instanceId: instance.id, tab: 'tab', token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 60000 };
const sha = 'a'.repeat(64);
const expanded = { kind: 'visual-click', screenshotId: 'shot-1', screenshotSha256: sha, target: '提交按钮',
  viewport: { width: 1200, height: 900, pageX: 0, pageY: 0 },
  box: { x1: 150, y1: 210, x2: 250, y2: 230 }, point: { x: 200, y: 220 } };

function fixture() {
  const state = { commands: [], mouse: [], pageY: 0, hit: { ok: true, connected: true, disabled: false,
    rect: { x: 100, y: 200, width: 140, height: 40 }, pointerEvents: 'auto', visibility: 'visible', opacity: '1' }, text: ['Fixture'] };
  const channel = { async call(method, params) {
    if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: 'https://example.test/', title: 'Fixture' }];
    if (method === 'ax.read') { method = 'cdp'; params = { method: 'Accessibility.getFullAXTree', params: {} }; }
    if (method !== 'cdp') return {};
    const { method: command, params: p } = params;
    state.commands.push(command);
    if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://example.test/' } } };
    if (command.startsWith('Accessibility.')) return { nodes: [
      { backendDOMNodeId: 30, role: { value: 'button' }, name: { value: '提交按钮' } },
      ...state.text.map(name => ({ role: { value: 'StaticText' }, name: { value: name } }))] };
    if (command === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1200, clientHeight: 900, pageX: 0, pageY: state.pageY } };
    if (command === 'DOM.getDocument') return { root: { backendNodeId: 1 } };
    if (command === 'DOM.resolveNode') return { object: { objectId: 'root-obj' } };
    if (command === 'Runtime.callFunctionOn' && String(p.functionDeclaration).includes('elementFromPoint')) return { result: { value: state.hit } };
    if (command === 'Input.dispatchMouseEvent') {
      state.mouse.push({ ...p });
      if (p.type === 'mouseReleased') state.text = ['Clicked'];
      return {};
    }
    return {};
  } };
  const provider = new ChromiumProvider(instance, channel);
  let dispatches = 0;
  return { state, provider, execution: { signal: new AbortController().signal, onDispatch() { dispatches++; } }, dispatches: () => dispatches };
}

test('visual-click contract requires a bounded screenshot-bound viewport box and point', () => {
  const base = { requestId: 'v', leaseId: lease.id, documentEpoch: 'e', action: expanded };
  assert.deepEqual(actionRequest(base).action, expanded);
  for (const bad of [
    { ...expanded, screenshotSha256: 'xyz' },
    { ...expanded, viewport: { width: 1200, height: 900, pageX: 0, pageY: 0, extra: 1 } },
    { ...expanded, box: { x1: 150, y1: 210, x2: 2500, y2: 230 } },
    { ...expanded, point: { x: 300, y: 220 } },
    { ...expanded, extra: true },
  ]) assert.throws(() => actionRequest({ ...base, action: bad }), { code: 'INVALID_REQUEST' });
  assert.throws(() => actionRequest({ ...base, action: { ...expanded, expected: { kind: 'value', value: 'x' } } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => actionRequest({ ...base, action: { ...expanded, expected: { kind: 'url', url: 'https://x/' } } }), { code: 'INVALID_REQUEST' });
});

test('visual-click rechecks document, viewport, hit overlap and dispatches the mapped point once', async () => {
  const f = fixture();
  const observation = await f.provider.observe(lease, f.execution.signal);
  const request = { requestId: 'v', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { ...expanded, expected: { kind: 'text', text: 'Clicked' } } };
  const result = await f.provider.act(lease, request, f.execution);
  assert.equal(result.postcondition, 'passed');
  assert.deepEqual(result.visual, { screenshotId: 'shot-1', target: '提交按钮', viewportBox: expanded.box, viewportPoint: expanded.point });
  assert.equal(f.state.mouse.length, 2);
  assert.deepEqual(f.state.mouse.map(event => [event.type, event.x, event.y]), [['mousePressed', 200, 220], ['mouseReleased', 200, 220]]);
  assert.equal(f.dispatches(), 2);
});

test('visual-click refuses a scrolled viewport before any input', async () => {
  const f = fixture();
  const observation = await f.provider.observe(lease, f.execution.signal);
  f.state.pageY = 40;
  await assert.rejects(f.provider.act(lease, { requestId: 'v', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: expanded }, f.execution), error => error.code === 'STALE_TARGET');
  assert.equal(f.state.mouse.length, 0);
});

test('visual-click refuses hidden or non-overlapping hit targets', async () => {
  const f = fixture();
  const observation = await f.provider.observe(lease, f.execution.signal);
  f.state.hit = { ...f.state.hit, rect: { x: 500, y: 500, width: 40, height: 40 } };
  await assert.rejects(f.provider.act(lease, { requestId: 'v', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: expanded }, f.execution), error => error.code === 'AMBIGUOUS_TARGET');
  assert.equal(f.state.mouse.length, 0);
  f.state.hit = { ...f.state.hit, visibility: 'hidden' };
  await assert.rejects(f.provider.act(lease, { requestId: 'v2', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: expanded }, f.execution), error => error.code === 'NOT_ACTIONABLE');
  assert.equal(f.state.mouse.length, 0);
});
