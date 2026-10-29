import assert from 'node:assert/strict';
import test from 'node:test';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { acceptWelcome, brokerCapabilities, clientRequirements, negotiateHello, providerCapabilities } from '../dist/packages/contracts/src/wire.js';

const instance = { id: 'upload-browser', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', instanceId: instance.id, tab: 'tab', token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 60000 };
const signal = () => new AbortController().signal;

function fixture() {
  const state = { name: 'Choose File', commands: [], fileInput: true, uploads: [] };
  const provider = new ChromiumProvider(instance, { async call(method, params) {
    if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: 'https://example.test/', title: 'Fixture' }];
    if (method === 'ax.read') { method = 'cdp'; params = { method: 'Accessibility.getFullAXTree', params: {} }; }
    if (method !== 'cdp') return {};
    const { method: command, params: p } = params;
    state.commands.push(command);
    if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://example.test/' } } };
    if (command.startsWith('Accessibility.')) {
      return { nodes: [{ backendDOMNodeId: 30, role: { value: 'button' }, name: { value: state.name } },
        { role: { value: 'StaticText' }, name: { value: 'Fixture' } }] };
    }
    if (command === 'DOM.resolveNode') return { object: { objectId: 'object-30' } };
    if (command === 'Runtime.callFunctionOn' && typeof p.functionDeclaration === 'string'
      && p.functionDeclaration.includes('instanceof HTMLInputElement')) {
      return { result: { value: state.fileInput } };
    }
    if (command === 'DOM.setFileInputFiles') { state.uploads.push(structuredClone(p)); return {}; }
    return {};
  } });
  let dispatches = 0;
  return { state, provider, execution: { signal: signal(), onDispatch() { dispatches++; } }, dispatches: () => dispatches };
}

test('upload contract requires a ref and bounded absolute local files without value or URL expectations', () => {
  const base = { requestId: 'u', leaseId: lease.id, documentEpoch: 'e', action: { kind: 'upload', ref: 'node-1', files: ['/tmp/a.pdf'] } };
  assert.deepEqual(actionRequest(base).action, { kind: 'upload', ref: 'node-1', files: ['/tmp/a.pdf'] });
  assert.deepEqual(actionRequest({ ...base, action: { ...base.action, files: ['C:\\Users\\longmiaoo\\b.txt'] } }).action.files,
    ['C:\\Users\\longmiaoo\\b.txt']);
  assert.deepEqual(actionRequest({ ...base, action: { ...base.action, expected: { kind: 'text', text: 'done' } } }).action.expected,
    { kind: 'text', text: 'done' });
  for (const patch of [
    { files: [] }, { files: ['relative.txt'] }, { files: ['https://x/a.pdf'] }, { files: ['file:///tmp/a.pdf'] },
    { files: ['/tmp/a\0b'] }, { files: ['/tmp/a\nb'] }, { files: Array.from({ length: 65 }, (_, i) => `/tmp/${i}`) },
    { files: '/tmp/a.pdf' }, { ref: undefined }, { extra: true },
    { expected: { kind: 'value', value: 'x' } }, { expected: { kind: 'url', url: 'https://x/' } },
  ]) assert.throws(() => actionRequest({ ...base, action: { ...base.action, ...patch } }), { code: 'INVALID_REQUEST' });
});

test('old Broker or provider cannot silently accept a client that requires upload', () => {
  assert.ok(providerCapabilities.includes('input.file-input.v1'));
  assert.ok(clientRequirements.includes('runtime.upload.v1'));
  assert.throws(() => acceptWelcome({ version: 1, connectionEpoch: 'new',
    capabilities: brokerCapabilities.filter(c => c !== 'runtime.upload.v1') }, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
  assert.throws(() => negotiateHello({ bootstrap: 1, versions: [1], role: 'provider',
    capabilities: providerCapabilities.filter(c => c !== 'input.file-input.v1'),
    instance: { id: 'fixture', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture' } }),
    { code: 'PROTOCOL_MISMATCH' });
});

test('upload verifies the file input, dispatches DOM.setFileInputFiles once and releases the handle', async () => {
  const f = fixture();
  const observation = await f.provider.observe(lease, f.execution.signal);
  const request = { requestId: 'u', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { kind: 'upload', ref: observation.nodes[0].id, files: ['/tmp/report.pdf'] } };
  const result = await f.provider.act(lease, request, f.execution);
  assert.equal(result.postcondition, 'unverified');
  assert.deepEqual(result.observation.documentEpoch, observation.documentEpoch);
  assert.deepEqual(f.state.uploads, [{ files: ['/tmp/report.pdf'], objectId: 'object-30' }]);
  assert.equal(f.dispatches(), 1);
  assert.ok(f.state.commands.includes('DOM.setFileInputFiles'));
});

test('upload refuses a non-file target without dispatching file selection', async () => {
  const f = fixture();
  f.state.fileInput = false;
  const observation = await f.provider.observe(lease, f.execution.signal);
  const request = { requestId: 'u', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { kind: 'upload', ref: observation.nodes[0].id, files: ['/tmp/report.pdf'] } };
  await assert.rejects(f.provider.act(lease, request, f.execution), error => error.code === 'UNSUPPORTED_CAPABILITY');
  assert.equal(f.state.uploads.length, 0);
  assert.equal(f.dispatches(), 0);
});
