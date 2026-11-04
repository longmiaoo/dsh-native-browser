import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateHost } from '../dist/packages/contracts/src/index.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
const signal = () => new AbortController().signal;

test('isPrivateHost recognises loopback, private, link-local and internal names only', () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.9.9/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/',
    'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:10.0.0.1]/', 'http://router.local/', 'http://svc.internal/', 'http://intranet/'])
    assert.equal(isPrivateHost(url), true, url);
  for (const url of ['https://example.com/', 'https://172.32.0.1/', 'https://8.8.8.8/', 'https://100.128.0.1/', 'https://localhost.example.com/', 'not a url'])
    assert.equal(isPrivateHost(url), false, url);
});

test('open no longer blocks private addresses', async () => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true);
  runtime.register(provider);
  try {
    const lease = await runtime.open('owner', 'fake-1', 'http://localhost:3000/app', signal());
    assert.equal(provider.opened.length, 1); assert.equal(lease.origin, 'http://localhost:3000');
  } finally { await runtime.dispose(); }
});

test('navigation from a public page to a private address is no longer blocked', async () => {
  const provider = new FakeProvider(), runtime = new BrowserRuntime(async () => true, undefined, undefined, { leaseScope: 'tab' });
  runtime.register(provider);
  provider.act = async (current, request, execution) => {
    execution.onDispatch(); provider.tab.url = request.action.url; provider.epoch = `doc-${request.requestId}`;
    return { observation: await provider.observe({ ...current, origin: new URL(request.action.url).origin }, execution.signal), postcondition: 'passed' };
  };
  try {
    const lease = await runtime.claim('o', 'fake-1', 'tab-1', signal());
    const nav = (requestId, url, epoch) => runtime.act('o', { requestId, leaseId: lease.id, documentEpoch: epoch, action: { kind: 'navigate', url } }, signal());
    const toPrivate = await nav('to-private', 'http://192.168.0.1/admin', 'doc-1');
    assert.equal(toPrivate.outcome, 'succeeded');
    assert.equal(provider.tab.url, 'http://192.168.0.1/admin');
  } finally { await runtime.dispose(); }
});
