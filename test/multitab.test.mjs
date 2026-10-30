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

test('close removes only agent-created tabs and releases their lease', async () => {
  const provider = new FakeProvider();
  const runtime = new BrowserRuntime(async request => request.tab.url.startsWith('https://example.test'));
  runtime.register(provider);
  try {
    const opened = await runtime.open('owner', 'fake-1', 'https://example.test/close-me', signal());
    await runtime.close('owner', opened.id, signal());
    assert.equal(provider.opened.length, 0);
    await assert.rejects(runtime.observe('owner', opened.id, signal()), error => error.code === 'LEASE_REVOKED');
    const existing = await runtime.claim('owner', 'fake-1', 'tab-1', signal());
    await assert.rejects(runtime.close('owner', existing.id, signal()), error => error.code === 'POLICY_DENIED');
    assert.equal(provider.grants.get('tab-1'), existing.token);
  } finally { await runtime.dispose(); }
});

test('slow initial navigation gets the configured inventory budget without creating another tab', async () => {
  const provider = new FakeProvider();
  const runtime = new BrowserRuntime(async () => true, { actionMs: 3000 });
  const list = provider.listTabs.bind(provider);
  const visibleAt = Date.now() + 1650;
  provider.listTabs = async signal => (await list(signal)).filter(tab => tab.id === 'tab-1' || Date.now() >= visibleAt);
  runtime.register(provider);
  try {
    const lease = await runtime.open('owner', 'fake-1', 'https://example.test/slow', signal());
    assert.equal(lease.tab, 'tab-2'); assert.equal(provider.opened.length, 1);
  } finally { await runtime.dispose(); }
});

test('inventory timeout preserves the created tab and cancellation never grants or recreates it', async () => {
  for (const cancelled of [false, true]) {
    const provider = new FakeProvider();
    provider.listTabs = async () => [];
    const runtime = new BrowserRuntime(async () => true, { actionMs: 100 }); runtime.register(provider);
    const controller = new AbortController();
    const timer = cancelled ? setTimeout(() => controller.abort(new Error('user stop')), 20) : undefined;
    try {
      await assert.rejects(runtime.open('owner', 'fake-1', 'https://example.test/slow', controller.signal),
        error => cancelled ? error.message === 'user stop' || error.code === 'CANCELLED' : error.code === 'DEADLINE_EXCEEDED');
      assert.equal(provider.opened.length, 1); assert.equal(provider.grants.size, 0);
    } finally { clearTimeout(timer); await runtime.dispose(); }
  }
});

test('an early Chrome removal notification does not turn an acknowledged close into a failure', async () => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true);
  runtime.register(provider);
  const close = provider.close.bind(provider);
  provider.close = async (lease, signal) => {
    await close(lease, signal);
    await runtime.providerRevoked(provider.instance.id, lease.id);
    assert.equal(signal.aborted, false, 'close acknowledgment keeps caller cancellation, not self-removal');
  };
  try {
    const lease = await runtime.open('owner', 'fake-1', 'https://example.test/close', signal());
    await runtime.close('owner', lease.id, signal());
    assert.equal(provider.opened.length, 0);
    assert.equal(runtime.resourceUsage().leases, 0);
    await assert.rejects(runtime.observe('owner', lease.id, signal()), { code: 'LEASE_REVOKED' });
  } finally { await runtime.dispose(); }
});
