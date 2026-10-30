import assert from 'node:assert/strict';
import test from 'node:test';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';

const instance = { id: 'dialog-browser', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'fixture', capabilities: { ax: true } };
const lease = { id: 'lease', owner: 'owner', instanceId: instance.id, tab: 'tab', token: 'token', origin: 'https://example.test', expiresAt: Date.now() + 60000 };

function fixture(pending) {
  const state = { commands: [], opened: [], events: [], text: ['Fixture'] };
  const channel = {
    async call(method, params) {
      if (method === 'tabs.list') return [{ id: 'tab', instanceId: instance.id, url: 'https://example.test/', title: 'Fixture' }];
      if (method === 'dialog.pending') return pending;
      if (method === 'ax.read') { method = 'cdp'; params = { method: 'Accessibility.getFullAXTree', params: {} }; }
      if (method !== 'cdp') return {};
      const { method: command, params: p } = params;
      state.commands.push({ command, params: structuredClone(p) });
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://example.test/' } } };
      if (command.startsWith('Accessibility.')) return { nodes: [
        { role: { value: 'StaticText' }, name: { value: 'Fixture' } },
        ...state.text.map(name => ({ role: { value: 'StaticText' }, name: { value: name } })),
      ] };
      return {};
    },
  };
  channel.onEvent = listener => { state.events.push(listener); return () => { state.events.splice(state.events.indexOf(listener), 1); }; };
  const provider = new ChromiumProvider(instance, channel);
  let dispatches = 0;
  return { state, provider, execution: { signal: new AbortController().signal, onDispatch() { dispatches++; } }, dispatches: () => dispatches };
}

test('dialog contract accepts only a boolean decision, bounded prompt text and text/state postconditions', () => {
  const base = { requestId: 'dialog', leaseId: lease.id, documentEpoch: 'epoch', action: { kind: 'dialog', accept: true } };
  assert.deepEqual(actionRequest(base).action, { kind: 'dialog', accept: true });
  assert.deepEqual(actionRequest({ ...base, action: { kind: 'dialog', accept: true, promptText: 'Longmiaoo' } }).action,
    { kind: 'dialog', accept: true, promptText: 'Longmiaoo' });
  assert.deepEqual(actionRequest({ ...base, action: { kind: 'dialog', accept: false,
    expected: { kind: 'text', text: 'Cancelled' } } }).action.expected, { kind: 'text', text: 'Cancelled' });
  for (const action of [
    { kind: 'dialog' },
    { kind: 'dialog', accept: 'yes' },
    { kind: 'dialog', accept: false, promptText: 'ignored' },
    { kind: 'dialog', accept: true, promptText: 'x'.repeat(1001) },
    { kind: 'dialog', accept: true, expected: { kind: 'value', value: 'x' } },
    { kind: 'dialog', accept: true, expected: { kind: 'url', url: 'https://example.test/' } },
    { kind: 'dialog', accept: true, extra: true },
  ]) assert.throws(() => actionRequest({ ...base, action }), { code: 'INVALID_REQUEST' });
});

test('dialog handles a pending confirm exactly once and returns typed evidence', async () => {
  const f = fixture({ type: 'confirm', message: 'Continue?' });
  const observation = await f.provider.observe(lease, f.execution.signal);
  const result = await f.provider.act(lease, { requestId: 'confirm', leaseId: lease.id,
    documentEpoch: observation.documentEpoch, action: { kind: 'dialog', accept: true } }, f.execution);
  assert.equal(result.postcondition, 'unverified');
  assert.deepEqual(result.dialog, { type: 'confirm', message: 'Continue?', accepted: true });
  assert.deepEqual(f.state.commands.filter(item => item.command === 'Page.handleJavaScriptDialog'),
    [{ command: 'Page.handleJavaScriptDialog', params: { accept: true } }]);
  assert.equal(f.dispatches(), 1);
});

test('dialog accepts a prompt through an event and verifies a postcondition', async () => {
  const f = fixture(null);
  const observation = await f.provider.observe(lease, f.execution.signal);
  setTimeout(() => {
    f.state.text = ['Prompt accepted'];
    for (const listener of [...f.state.events]) listener('dialog.opened', { tab: lease.tab, leaseId: lease.id,
      type: 'prompt', message: 'Name?' });
  }, 5);
  const result = await f.provider.act(lease, { requestId: 'prompt', leaseId: lease.id,
    documentEpoch: observation.documentEpoch, timeoutMs: 1000,
    action: { kind: 'dialog', accept: true, promptText: 'Longmiaoo', expected: { kind: 'text', text: 'Prompt accepted' } } }, f.execution);
  assert.equal(result.postcondition, 'passed');
  assert.deepEqual(result.dialog, { type: 'prompt', message: 'Name?', accepted: true, promptText: 'Longmiaoo' });
  assert.deepEqual(f.state.commands.filter(item => item.command === 'Page.handleJavaScriptDialog')[0].params,
    { accept: true, promptText: 'Longmiaoo' });
  assert.equal(f.state.events.length, 0, 'dialog event subscription is released after the action');
});

test('dialog action fails without dispatching when no dialog is open', async () => {
  const f = fixture(null);
  const observation = await f.provider.observe(lease, f.execution.signal);
  await assert.rejects(f.provider.act(lease, { requestId: 'missing', leaseId: lease.id,
    documentEpoch: observation.documentEpoch, timeoutMs: 20, action: { kind: 'dialog', accept: false } }, f.execution),
  { code: 'NOT_ACTIONABLE' });
  assert.equal(f.dispatches(), 0);
  assert.equal(f.state.commands.some(item => item.command === 'Page.handleJavaScriptDialog'), false);
});
