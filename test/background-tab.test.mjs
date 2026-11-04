import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
const signal = () => new AbortController().signal;

test('input actions on a background tab fail clearly before dispatch; reads and activation stay allowed', async () => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true);
  runtime.register(provider);
  try {
    provider.tab.active = false;
    const lease = await runtime.claim('o', 'fake-1', 'tab-1', signal());
    const act = (requestId, action) => runtime.act('o', { requestId, leaseId: lease.id, documentEpoch: 'doc-1', action }, signal());
    for (const [i, action] of [{ kind: 'click', ref: 'node-1' }, { kind: 'fill', ref: 'node-1', text: 'x' }].entries()) {
      const result = await act(`bg-${i}`, action);
      assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'NOT_ACTIONABLE'); assert.equal(result.dispatch, 'notDispatched');
    }
    assert.equal(provider.calls.length, 0);
    await runtime.observe('o', lease.id, signal());
    provider.tab.active = true;
    assert.equal((await act('fg-1', { kind: 'click', ref: 'node-1' })).outcome, 'succeeded');
    assert.equal(provider.calls.length, 1);
  } finally { await runtime.dispose(); }
});

test('providers that do not report foreground state are never blocked', async () => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true);
  runtime.register(provider);
  try {
    const lease = await runtime.claim('o', 'fake-1', 'tab-1', signal());
    const result = await runtime.act('o', { requestId: 'u-1', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'click', ref: 'node-1' } }, signal());
    assert.equal(result.outcome, 'succeeded');
  } finally { await runtime.dispose(); }
});
