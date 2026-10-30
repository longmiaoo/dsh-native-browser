import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

const signal = () => new AbortController().signal;

test('one DSH session opens, claims, activates and releases multiple tabs', async () => {
  const provider = new FakeProvider();
  const runtime = new BrowserRuntime(async request => request.tab.url.startsWith('https://example.test'));
  runtime.register(provider);
  try {
    const first = await runtime.open('owner', 'fake-1', 'https://example.test/a', signal());
    const second = await runtime.open('owner', 'fake-1', 'https://example.test/b', signal());
    assert.notEqual(first.id, second.id);
    assert.equal(first.tab, 'tab-2'); assert.equal(second.tab, 'tab-3');
    assert.equal(provider.opened.length, 2);
    await runtime.activate('owner', first.id, signal());
    assert.equal(provider.activeTab, 'tab-2');
    assert.equal((await runtime.observe('owner', first.id, signal())).url, 'https://example.test/a');
    assert.equal((await runtime.observe('owner', second.id, signal())).url, 'https://example.test/b');
    await runtime.releaseOwner('owner');
    await assert.rejects(runtime.observe('owner', first.id, signal()), error => error.code === 'LEASE_REVOKED');
    await assert.rejects(runtime.observe('owner', second.id, signal()), error => error.code === 'LEASE_REVOKED');
  } finally { await runtime.dispose(); }
});

test('open authorizes the exact origin before creating a tab', async () => {
  const provider = new FakeProvider();
  const runtime = new BrowserRuntime(async request => request.tab.url.startsWith('https://example.test'));
  runtime.register(provider);
  try {
    await assert.rejects(runtime.open('owner', 'fake-1', 'https://evil.test/x', signal()), error => error.code === 'POLICY_DENIED');
    assert.equal(provider.opened.length, 0);
    await assert.rejects(runtime.open('owner', 'fake-1', 'file:///tmp/x', signal()), error => error.code === 'INVALID_REQUEST');
    assert.equal(provider.opened.length, 0);
  } finally { await runtime.dispose(); }
});
