import assert from 'node:assert/strict';
import test from 'node:test';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { acceptWelcome, brokerCapabilities, clientRequirements, negotiateHello, providerCapabilities } from '../dist/packages/contracts/src/wire.js';

const instance = { id: 'choose-browser', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', instanceId: instance.id, tab: 'tab', token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 60000 };
const signal = () => new AbortController().signal;

function fixture() {
  const listeners = new Set();
  const state = { name: '打开文件', commands: [], chooser: [], handled: [], openChooser: true, text: ['Fixture'] };
  const channel = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(method, params) {
      if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: 'https://example.test/', title: 'Fixture' }];
      if (method === 'ax.read') { method = 'cdp'; params = { method: 'Accessibility.getFullAXTree', params: {} }; }
      if (method !== 'cdp') return {};
      const { method: command, params: p } = params;
      state.commands.push(command);
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://example.test/' } } };
      if (command.startsWith('Accessibility.')) {
        return { nodes: [{ backendDOMNodeId: 30, role: { value: 'button' }, name: { value: state.name } },
          ...state.text.map(name => ({ role: { value: 'StaticText' }, name: { value: name } }))] };
      }
      if (command === 'DOM.resolveNode') return { object: { objectId: 'object-30' } };
      if (command === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, connected: true, inViewport: true, x: 50, y: 60, left: 0, top: 0, width: 100, height: 40, tag: 'BUTTON' } } };
      }
      if (command === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased' && state.openChooser) {
        for (const listener of listeners) listener('fileChooser.opened', { tab: lease.tab, leaseId: lease.id, backendNodeId: 77 });
      }
      if (command === 'Page.setInterceptFileChooserDialog') { state.chooser.push(structuredClone(p)); return {}; }
      if (command === 'Page.handleFileChooser') { state.handled.push(structuredClone(p)); state.text = ['已选择']; return {}; }
      return {};
    },
  };
  const provider = new ChromiumProvider(instance, channel);
  let dispatches = 0;
  return { state, provider, execution: { signal: signal(), onDispatch() { dispatches++; } }, dispatches: () => dispatches };
}

test('choose contract requires a ref and bounded absolute local files without value or URL expectations', () => {
  const base = { requestId: 'c', leaseId: lease.id, documentEpoch: 'e', action: { kind: 'choose', ref: 'node-1', files: ['/tmp/a.pdf'] } };
  assert.deepEqual(actionRequest(base).action, { kind: 'choose', ref: 'node-1', files: ['/tmp/a.pdf'] });
  for (const patch of [{ files: [] }, { files: ['relative.txt'] }, { files: ['https://x/a'] },
    { ref: undefined }, { expected: { kind: 'value', value: 'x' } }, { expected: { kind: 'url', url: 'https://x/' } }]) {
    assert.throws(() => actionRequest({ ...base, action: { ...base.action, ...patch } }), { code: 'INVALID_REQUEST' });
  }
});

test('old Broker or provider cannot silently accept a client that requires choose', () => {
  assert.ok(providerCapabilities.includes('input.file-chooser.v1'));
  assert.ok(clientRequirements.includes('runtime.choose.v1'));
  assert.throws(() => acceptWelcome({ version: 1, connectionEpoch: 'new',
    capabilities: brokerCapabilities.filter(c => c !== 'runtime.choose.v1') }, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
  assert.throws(() => negotiateHello({ bootstrap: 1, versions: [1], role: 'provider',
    capabilities: providerCapabilities.filter(c => c !== 'input.file-chooser.v1'),
    instance: { id: 'fixture', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture' } }),
    { code: 'PROTOCOL_MISMATCH' });
});

test('choose intercepts the chooser, clicks the trigger once and accepts the selected files', async () => {
  const f = fixture();
  const observation = await f.provider.observe(lease, f.execution.signal);
  const request = { requestId: 'c', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { kind: 'choose', ref: observation.nodes[0].id, files: ['/tmp/report.pdf'], expected: { kind: 'text', text: '已选择' } } };
  const result = await f.provider.act(lease, request, f.execution);
  assert.equal(result.postcondition, 'passed');
  assert.deepEqual(f.state.chooser, [{ enabled: true }]);
  assert.deepEqual(f.state.handled, [{ action: 'accept', files: ['/tmp/report.pdf'] }]);
  assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
});

test('choose fails closed when the chooser never opens', async () => {
  const f = fixture();
  f.state.openChooser = false;
  const observation = await f.provider.observe(lease, f.execution.signal);
  const request = { requestId: 'c', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { kind: 'choose', ref: observation.nodes[0].id, files: ['/tmp/report.pdf'] } };
  await assert.rejects(f.provider.act(lease, request, f.execution), error => error.code === 'NOT_ACTIONABLE');
  assert.deepEqual(f.state.handled, []);
});
