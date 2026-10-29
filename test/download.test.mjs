import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { actionRequest, downloadEvidence } from '../dist/packages/contracts/src/validation.js';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { acceptWelcome, brokerCapabilities, clientRequirements, negotiateHello, providerCapabilities } from '../dist/packages/contracts/src/wire.js';

const instance = { id: 'download-browser', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', instanceId: instance.id, tab: 'tab', token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 60000 };
const signal = () => new AbortController().signal;

function fixture(downloadRoot) {
  const listeners = new Set();
  const state = { name: '下载报表', commands: [], armed: 0, suggested: path.join(downloadRoot, 'report.pdf'),
    content: 'downloaded content', complete: true };
  const channel = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(method, params) {
      if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: 'https://example.test/', title: 'Fixture' }];
      if (method === 'ax.read') { method = 'cdp'; params = { method: 'Accessibility.getFullAXTree', params: {} }; }
      if (method === 'downloads.arm') { state.armed++; return { armed: true }; }
      if (method !== 'cdp') return {};
      const { method: command, params: p } = params;
      state.commands.push(command);
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://example.test/' } } };
      if (command.startsWith('Accessibility.')) {
        return { nodes: [{ backendDOMNodeId: 30, role: { value: 'button' }, name: { value: state.name } },
          { role: { value: 'StaticText' }, name: { value: '已开始下载' } }] };
      }
      if (command === 'DOM.resolveNode') return { object: { objectId: 'object-30' } };
      if (command === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, connected: true, inViewport: true, x: 50, y: 60, left: 0, top: 0, width: 100, height: 40, tag: 'BUTTON' } } };
      }
      if (command === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased') {
        if (!state.complete) return {};
        await writeFile(state.suggested, state.content);
        const bytes = Buffer.byteLength(state.content);
        for (const listener of listeners) listener('download.started', { tab: lease.tab, leaseId: lease.id, id: 1 });
        for (const listener of listeners) listener('download.progress', { id: 1, state: 'complete',
          filename: state.suggested, receivedBytes: bytes, totalBytes: bytes, exists: true });
      }
      return {};
    },
  };
  const provider = new ChromiumProvider(instance, channel);
  let dispatches = 0;
  return { state, provider, execution: { signal: signal(), onDispatch() { dispatches++; } }, dispatches: () => dispatches };
}

test('download contract takes only an exact ref and text/state postconditions; evidence is a safe single name plus absolute path', () => {
  const base = { requestId: 'd', leaseId: lease.id, documentEpoch: 'e', action: { kind: 'download', ref: 'node-1' } };
  assert.deepEqual(actionRequest(base).action, { kind: 'download', ref: 'node-1' });
  for (const patch of [{ ref: undefined }, { files: ['/tmp/a.pdf'] }, { path: '/tmp/x' }, { url: 'https://x/' },
    { expected: { kind: 'value', value: 'x' } }, { expected: { kind: 'url', url: 'https://x/' } }]) {
    assert.throws(() => actionRequest({ ...base, action: { ...base.action, ...patch } }), { code: 'INVALID_REQUEST' });
  }
  assert.deepEqual(downloadEvidence({ filename: 'a.pdf', path: '/tmp/a.pdf', receivedBytes: 3, totalBytes: 3 }),
    { filename: 'a.pdf', path: '/tmp/a.pdf', receivedBytes: 3, totalBytes: 3 });
  for (const bad of [{ filename: '../a.pdf', path: '/tmp/a.pdf', receivedBytes: 1 },
    { filename: 'a/b.pdf', path: '/tmp/a.pdf', receivedBytes: 1 },
    { filename: 'a.pdf', path: 'relative/a.pdf', receivedBytes: 1 },
    { filename: 'a.pdf', path: '/tmp/a.pdf', receivedBytes: -1 },
    { filename: 'a.pdf', path: '/tmp/a.pdf', receivedBytes: 5, totalBytes: 1 }]) {
    assert.throws(() => downloadEvidence(bad), { code: 'INVALID_REQUEST' });
  }
});

test('old Broker or provider cannot silently accept a client that requires download', () => {
  assert.ok(providerCapabilities.includes('input.download.v1'));
  assert.ok(clientRequirements.includes('runtime.download.v1'));
  assert.throws(() => acceptWelcome({ version: 1, connectionEpoch: 'new',
    capabilities: brokerCapabilities.filter(c => c !== 'runtime.download.v1') }, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
  assert.throws(() => negotiateHello({ bootstrap: 1, versions: [1], role: 'provider',
    capabilities: providerCapabilities.filter(c => c !== 'input.download.v1'),
    instance: { id: 'fixture', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture' } }),
    { code: 'PROTOCOL_MISMATCH' });
});

test('download arms the lease, clicks once and reports completed file evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-download-test-'));
  try {
    const f = fixture(root);
    const observation = await f.provider.observe(lease, f.execution.signal);
    const result = await f.provider.act(lease, { requestId: 'd', leaseId: lease.id, documentEpoch: observation.documentEpoch,
      action: { kind: 'download', ref: observation.nodes[0].id } }, f.execution);
    assert.equal(result.postcondition, 'passed');
    assert.equal(result.download.filename, 'report.pdf');
    assert.equal(result.download.receivedBytes, Buffer.byteLength('downloaded content'));
    assert.ok(result.download.path.startsWith(root + path.sep));
    assert.equal(path.basename(result.download.path), 'report.pdf');
    assert.equal(f.state.armed, 1);
    assert.equal(f.state.commands.filter(c => c === 'Input.dispatchMouseEvent').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download reports the actual file only inside the owned directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-download-test-'));
  try {
    const f = fixture(root);
    f.state.suggested = path.join(root, 'evil.pdf');
    const observation = await f.provider.observe(lease, f.execution.signal);
    const result = await f.provider.act(lease, { requestId: 'd', leaseId: lease.id, documentEpoch: observation.documentEpoch,
      action: { kind: 'download', ref: observation.nodes[0].id } }, f.execution);
    assert.equal(result.download.filename, 'evil.pdf');
    assert.equal(path.dirname(result.download.path), root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download fails closed when the browser starts no download', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-download-test-'));
  try {
    const f = fixture(root);
    f.state.complete = false;
    const observation = await f.provider.observe(lease, f.execution.signal);
    await assert.rejects(f.provider.act(lease, { requestId: 'd', leaseId: lease.id, documentEpoch: observation.documentEpoch,
      timeoutMs: 400, action: { kind: 'download', ref: observation.nodes[0].id } }, f.execution),
      error => error.code === 'NOT_ACTIONABLE' || error.code === 'DEADLINE_EXCEEDED');
    assert.equal(f.state.armed, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
