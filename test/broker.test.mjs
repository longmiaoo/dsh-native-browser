import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { connectBroker } from '../dist/packages/broker/src/client.js';
import { localState } from '../dist/packages/broker/src/local-state.js';
import { installHost, manifestDirectory } from '../dist/packages/installer/src/install.js';
import { RpcPeer } from '../dist/packages/transport-native/src/rpc.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
import { randomBytes } from 'node:crypto';
import { providerCapabilities } from '../dist/packages/contracts/src/wire.js';

async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected lifecycle state within two seconds');
}

async function environment(t, origins = ['https://example.test'], options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-br-'));
  const broker = await startBroker({ directory, allowedOrigins: origins, ...options });
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true }); });
  const client = await connectBroker(directory);
  t.after(() => client.close());
  return { directory, broker, client };
}

test('connection cap includes unauthenticated sockets, preserves active client and frees closed slots', async t => {
  const { directory, broker, client } = await environment(t, ['https://example.test'], { maxConnections: 2 });
  const idle = net.createConnection(broker.socket); t.after(() => idle.destroy()); await once(idle, 'connect');
  // Server handling is evidenced by its current counter, not socket connect alone.
  await until(() => broker.resourceUsage().connections === 2);
  await assert.rejects(connectBroker(directory), { code: 'CONNECTION_LOST' });
  assert.deepEqual(await client.call('browser.instances', {}), []);
  assert.equal(broker.resourceUsage().connections, 2);
  idle.destroy();
  await until(() => broker.resourceUsage().connections === 1);
  const next = await connectBroker(directory); t.after(() => next.close());
  assert.deepEqual(await next.call('browser.instances', {}), []);
});

test('session release during a socket claim cancels the pending grant and permits a later explicit claim', async t => {
  const { broker, client } = await environment(t); const provider = new FakeProvider(); broker.runtime.register(provider);
  let finish, entered; const started = new Promise(resolve => { entered = resolve; });
  provider.listTabs = async () => { entered(); await new Promise(resolve => { finish = resolve; }); return [provider.tab]; };
  const request = { sessionId: 's', instanceId: 'fake-1', tab: 'tab-1' };
  const pending = client.call('browser.claim', request);
  const rejected = assert.rejects(pending, { code: 'LEASE_REVOKED' }); await started;
  await client.call('browser.releaseSession', { sessionId: 's' }); finish(); await rejected;
  assert.equal(provider.grants.size, 0); assert.equal(broker.resourceUsage().claims, 0);
  provider.listTabs = async () => [provider.tab];
  const lease = await client.call('browser.claim', request);
  assert.equal(provider.grants.get('tab-1'), lease.token);
});

test('different session churn and invalid methods do not retain historical owner/lease records', async t => {
  const { broker, client } = await environment(t); const provider = new FakeProvider(); broker.runtime.register(provider);
  for (let i = 0; i < 50; i++) {
    const sessionId = `session-${i}`;
    await assert.rejects(client.call('not.implemented', { sessionId }), { code: 'INVALID_REQUEST' });
    await client.call('browser.claim', { sessionId, instanceId: 'fake-1', tab: 'tab-1' });
    await client.call('browser.releaseSession', { sessionId });
    assert.deepEqual(broker.resourceUsage(), { connections: 1, providers: 1, leases: 0, claims: 0 });
  }
});

test('real socket retries after production cache eviction return metadata without replay or old page data', async t => {
  const { broker, client } = await environment(t); const provider = new FakeProvider(); broker.runtime.register(provider);
  const sessionId = 'cache-churn';
  const lease = await client.call('browser.claim', { sessionId, instanceId: 'fake-1', tab: 'tab-1' });
  const first = { requestId: 'cache-0', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'private-cache-text' } };
  for (let i = 0; i < 129; i++) {
    const result = await client.call('browser.act', { sessionId, request: { ...first, requestId: `cache-${i}` } });
    assert.equal(result.outcome, 'succeeded');
  }
  const result = await client.call('browser.act', { sessionId, request: first });
  assert.equal(result.code, 'RECOVERY_REQUIRED'); assert.equal(result.outcome, 'unknown');
  assert.equal(result.recovery.priorOutcome, 'succeeded'); assert.equal(result.observation, undefined);
  assert.equal(JSON.stringify(result).includes('private-cache-text'), false); assert.equal(provider.calls.length, 129);
  const usage = broker.runtime.journalUsage(); assert.equal(usage.identities, 129); assert.equal(usage.results.entries, 128);
  assert.ok(usage.results.serializedBytes <= 8 * 1024 * 1024);
  await assert.rejects(client.call('browser.act', { sessionId, request: { ...first, action: { ...first.action, text: 'changed' } } }), { code: 'REQUEST_ID_CONFLICT' });
  await client.call('browser.releaseSession', { sessionId });
  assert.equal(broker.runtime.journalUsage().results.serializedBytes, 0);
  const afterRelease = await client.call('browser.act', { sessionId, request: first });
  assert.equal(afterRelease.code, 'RECOVERY_REQUIRED'); assert.equal(afterRelease.observation, undefined);
  assert.equal(provider.calls.length, 129);
});

test('client disconnect cancels pre-grant work without revoking another connection with the same session name', async t => {
  const { directory, broker, client } = await environment(t);
  const provider = new FakeProvider(); broker.runtime.register(provider);
  const other = await connectBroker(directory); t.after(() => other.close());
  const otherLease = await other.call('browser.claim', { sessionId: 'same', instanceId: 'fake-1', tab: 'tab-1' });
  let entered, finish; const started = new Promise(resolve => { entered = resolve; });
  provider.listTabs = async () => { entered(); await new Promise(resolve => { finish = resolve; }); return [{ ...provider.tab, id: 'tab-2' }]; };
  const waiting = client.call('browser.claim', { sessionId: 'same', instanceId: 'fake-1', tab: 'tab-2' });
  const rejected = assert.rejects(waiting, { code: 'CONNECTION_LOST' }); await started;
  client.close(); await rejected;
  await until(() => broker.resourceUsage().connections === 1); finish();
  await until(() => broker.resourceUsage().claims === 0);
  assert.equal(provider.grants.has('tab-2'), false);
  assert.equal(provider.grants.get('tab-1'), otherLease.token);
  assert.equal(broker.resourceUsage().leases, 1);
});

test('real Unix socket handshake and cross-client lease ownership', async t => {
  const { directory, broker, client } = await environment(t);
  broker.runtime.register(new FakeProvider());
  const second = await connectBroker(directory); t.after(() => second.close());
  const lease = await client.call('browser.claim', { sessionId: 'same-id', instanceId: 'fake-1', tab: 'tab-1' });
  await assert.rejects(second.call('browser.observe', { sessionId: 'same-id', leaseId: lease.id }), e => e.code === 'LEASE_REVOKED');
  const observation = await client.call('browser.observe', { sessionId: 'same-id', leaseId: lease.id });
  assert.equal(observation.documentEpoch, 'doc-1');
  await assert.rejects(client.call('cdp', { sessionId: 'same-id', method: 'Runtime.evaluate' }), e => e.code === 'INVALID_REQUEST');
});

test('Broker sends lease revocation only to its owning connection with the exact Session metadata', async t => {
  const {directory,broker,client}=await environment(t);const provider=new FakeProvider();broker.runtime.register(provider);
  const second=await connectBroker(directory);t.after(()=>second.close());
  const own=[],foreign=[];client.onEvent((event,value)=>own.push({event,value}));second.onEvent((event,value)=>foreign.push({event,value}));
  const lease=await client.call('browser.claim',{sessionId:'own-session',instanceId:'fake-1',tab:'tab-1'});
  second.event('lease.revoked',{leaseId:lease.id});
  second.event('browser.lease-revoked',{sessionId:'own-session',leaseId:lease.id});
  await second.call('browser.instances',{});
  assert.deepEqual(await client.call('browser.validateLease',{sessionId:'own-session',leaseId:lease.id}),{valid:true});
  for(const [peer,sessionId] of [[client,'other-session'],[second,'own-session']])
    await assert.rejects(peer.call('browser.validateLease',{sessionId,leaseId:lease.id}),{code:'LEASE_REVOKED'});
  await broker.runtime.providerRevoked('foreign-provider',lease.id);assert.equal(own.length,0);
  await broker.runtime.providerRevoked('fake-1',lease.id);await until(()=>own.length===1);
  assert.deepEqual(own,[{event:'browser.lease-revoked',value:{sessionId:'own-session',leaseId:lease.id}}]);
  // Ordered response on the foreign connection proves its preceding output was consumed.
  await second.call('browser.instances',{});assert.deepEqual(foreign,[]);
  await assert.rejects(client.call('browser.validateLease',{sessionId:'own-session',leaseId:lease.id}),{code:'LEASE_REVOKED'});
});

test('closed Broker client connections release their lease notification subscriptions', async t => {
  const {directory,broker}=await environment(t);
  for(let i=0;i<140;i++) {const peer=await connectBroker(directory);peer.close();}
  await until(()=>broker.resourceUsage().connections===1);
  const last=await connectBroker(directory);t.after(()=>last.close());
  assert.deepEqual(await last.call('browser.instances',{}),[]);
});

test('broker denies unapproved origins before listing or claiming', async t => {
  const { broker, client } = await environment(t, []);
  broker.runtime.register(new FakeProvider());
  assert.deepEqual(await client.call('browser.tabs', { sessionId: 's', instanceId: 'fake-1' }), []);
  await assert.rejects(client.call('browser.claim', { sessionId: 's', instanceId: 'fake-1', tab: 'tab-1' }), e => e.code === 'POLICY_DENIED');
});

test('personal Broker exposes only provider-consented tabs and issues a tab-scoped cross-origin lease', async t => {
  const { broker, client } = await environment(t, [], { accessMode: 'personal' });
  const provider = new FakeProvider(); provider.tab.url = 'https://unlisted.test/start'; broker.runtime.register(provider);
  assert.equal((await client.call('browser.tabs', { sessionId: 's', instanceId: 'fake-1' }))[0].url, provider.tab.url);
  const lease = await client.call('browser.claim', { sessionId: 's', instanceId: 'fake-1', tab: 'tab-1' });
  assert.equal(lease.scope, 'tab');
  provider.tab.url = 'https://another.test/next'; provider.epoch = 'doc-2';
  assert.equal((await client.call('browser.observe', { sessionId: 's', leaseId: lease.id })).url, provider.tab.url);
});

test('personal Broker configuration rejects mixed allowlists and unknown modes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-br-invalid-')); t.after(() => rm(directory, { recursive: true }));
  await assert.rejects(startBroker({ directory, allowedOrigins: ['https://example.test'], accessMode: 'personal' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(startBroker({ directory, allowedOrigins: [], accessMode: 'unknown' }), { code: 'INVALID_REQUEST' });
});

test('handshake rejects missing authentication and incompatible versions', async t => {
  const { directory, broker } = await environment(t);
  const socket = net.createConnection(broker.socket); await once(socket, 'connect');
  const peer = new RpcPeer(socket, socket); t.after(() => peer.close());
  await assert.rejects(peer.call('hello', { bootstrap: 1, versions: [1], role: 'client', token: 'invalid' }), e => e.code === 'POLICY_DENIED');
  const state = await localState(directory);
  await assert.rejects(peer.call('hello', { bootstrap: 1, versions: [2], role: 'client', token: state.token }), e => e.code === 'PROTOCOL_MISMATCH');
});

test('Broker rejects missing provider/client capabilities before registration and permits optional additions', async t => {
  const { directory, broker, client } = await environment(t);
  const state = await localState(directory);
  const socket = net.createConnection(broker.socket); await once(socket, 'connect');
  const peer = new RpcPeer(socket, socket); t.after(() => peer.close());
  const hello = { bootstrap: 1, versions: [1], role: 'provider', token: state.token,
    capabilities: [...providerCapabilities], instance: { id: 'caps-fixture', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'test' } };
  for (const params of [{ ...hello, capabilities: [] }, { ...hello, requiredCapabilities: ['future.required.v1'] },
    { bootstrap: 1, versions: [1], role: 'client', token: state.token, requiredCapabilities: ['future.required.v1'] }]) {
    await assert.rejects(peer.call('hello', params), { code: 'PROTOCOL_MISMATCH' });
    assert.deepEqual(await client.call('browser.instances', {}), []);
    await assert.rejects(peer.call('browser.claim', { sessionId: 's', instanceId: 'caps-fixture', tab: '7' }), { code: 'POLICY_DENIED' });
  }
  const welcome = await peer.call('hello', { ...hello, capabilities: [...providerCapabilities, 'future.optional.v1'] });
  assert.equal(welcome.version, 1); assert.equal(typeof welcome.connectionEpoch, 'string');
  assert.equal((await client.call('browser.instances', {})).length, 1);
  await assert.rejects(peer.call('browser.instances', {}), { code: 'POLICY_DENIED' });
});

test('real client closes incompatible Broker welcome before making any runtime request', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-welcome-'));
  const state = await localState(directory, true); const peers = [], methods = [];
  const server = net.createServer(socket => {
    const peer = new RpcPeer(socket, socket); peers.push(peer);
    peer.handle(async method => { methods.push(method); return { version: 1, connectionEpoch: 'old-broker', capabilities: [] }; });
  });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  server.listen(state.socket); await once(server, 'listening');
  await assert.rejects(connectBroker(directory), { code: 'PROTOCOL_MISMATCH' });
  assert.deepEqual(methods, ['hello']);
});

test('runtime directory does not silently repair unsafe permissions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-private-'));
  t.after(() => rm(directory, { recursive: true }));
  await chmod(directory, 0o755);
  await assert.rejects(localState(directory, true), e => e.code === 'POLICY_DENIED');
});

test('native host child injects auth only on local IPC and streams provider calls', async t => {
  const { directory, client } = await environment(t);
  const extensionId = 'a'.repeat(32), origin = `chrome-extension://${extensionId}/`;
  const installed = await installHost({ directory, extensionId, brand: 'chrome',
    cliPath: path.resolve('bin/dsh-native-browser.mjs'), manifestDir: path.join(directory, 'manifests') });
  const manifest = JSON.parse(await readFile(installed.manifest, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [origin]);
  const child = spawn(installed.launcher, [origin], { stdio: ['pipe', 'pipe', 'pipe'] });
  const extension = new RpcPeer(child.stdout, child.stdin);
  const exited = once(child, 'exit');
  t.after(async () => { extension.close(); child.kill('SIGTERM'); await exited; });
  extension.handle(async method => {
    if (method === 'tabs.list') return [{ id: 'native:7', instanceId: 'native', url: 'https://example.test/form', title: 'Native fixture' }];
    throw new Error('unexpected command');
  });
  const hello = await extension.call('hello', { bootstrap: 1, versions: [1], role: 'provider',
    capabilities: [...providerCapabilities],
    instance: { id: 'native', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'test' } });
  assert.equal(hello.version, 1); assert.equal('token' in hello, false);
  const tabs = await client.call('browser.tabs', { sessionId: 's', instanceId: 'native' });
  assert.equal(tabs[0].title, 'Native fixture');
});

test('Chrome and Edge host paths vary without duplicating runtime', () => {
  assert.equal(manifestDirectory('chrome', 'darwin', '/home/test'), '/home/test/Library/Application Support/Google/Chrome/NativeMessagingHosts');
  assert.equal(manifestDirectory('edge', 'darwin', '/home/test'), '/home/test/Library/Application Support/Microsoft Edge/NativeMessagingHosts');
  assert.throws(() => manifestDirectory('chrome', 'win32', 'x'), e => e.code === 'UNSUPPORTED_CAPABILITY');
});

test('Broker restart recovers only private metadata, rejects changed payloads and never restores a lease', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-recovery-'));
  let broker, client;
  t.after(async () => { client?.close(); await broker?.close(); await rm(directory, { recursive: true }); });
  const key = randomBytes(32).toString('hex'), sessionId = 'same-turn';
  broker = await startBroker({ directory, allowedOrigins: ['https://example.test'] });
  const provider = new FakeProvider(); broker.runtime.register(provider);
  client = await connectBroker(directory, key);
  const lease = await client.call('browser.claim', { sessionId, instanceId: 'fake-1', tab: 'tab-1' });
  const request = { requestId: 'submit-once', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'secret-value' } };
  assert.equal((await client.call('browser.act', { sessionId, request })).outcome, 'succeeded');
  assert.equal(provider.calls.length, 1);
  await broker.close(); broker = undefined;
  broker = await startBroker({ directory, allowedOrigins: ['https://example.test'] }); broker.runtime.register(provider);
  client = await connectBroker(directory, key);
  const recovered = await client.call('browser.act', { sessionId, request });
  assert.equal(recovered.code, 'RECOVERY_REQUIRED'); assert.equal(recovered.outcome, 'unknown');
  assert.equal(recovered.recovery.state, 'settled'); assert.equal(recovered.recovery.priorOutcome, 'succeeded');
  assert.equal(recovered.observation, undefined); assert.equal(provider.calls.length, 1);
  await assert.rejects(client.call('browser.observe', { sessionId, leaseId: lease.id }), e => e.code === 'LEASE_REVOKED');
  await assert.rejects(client.call('browser.act', { sessionId, request: { ...request, action: { ...request.action, text: 'different' } } }), e => e.code === 'REQUEST_ID_CONFLICT');
  await assert.rejects(client.call('browser.act', { sessionId: 'different-turn', request }), e => e.code === 'LEASE_REVOKED');
  const other = await connectBroker(directory); t.after(() => other.close());
  await assert.rejects(other.call('browser.act', { sessionId, request }), e => e.code === 'LEASE_REVOKED');
  const next = await client.call('browser.claim', { sessionId, instanceId: 'fake-1', tab: 'tab-1' });
  await assert.rejects(client.call('browser.act', { sessionId, request: { ...request, leaseId: next.id } }), e => e.code === 'REQUEST_ID_CONFLICT');
  assert.equal(provider.calls.length, 1);
  const disk = await readFile(path.join(directory, 'action-journal.jsonl'), 'utf8');
  for (const value of [key, lease.id, 'secret-value', 'submit-once', 'same-turn']) assert.equal(disk.includes(value), false);
});

test('an additional Broker cannot bind the live socket or compact its active journal', async t => {
  const { directory, broker, client } = await environment(t);
  broker.runtime.register(new FakeProvider());
  const lease = await client.call('browser.claim', { sessionId: 's', instanceId: 'fake-1', tab: 'tab-1' });
  await client.call('browser.act', { sessionId: 's', request: { requestId: 'one', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'click', ref: 'node-1' } } });
  const before = await readFile(path.join(directory, 'action-journal.jsonl'), 'utf8');
  await assert.rejects(startBroker({ directory, allowedOrigins: ['https://example.test'] }), e => e.code === 'BROKER_BUSY');
  assert.equal(await readFile(path.join(directory, 'action-journal.jsonl'), 'utf8'), before);
  assert.equal((await client.call('browser.observe', { sessionId: 's', leaseId: lease.id })).tab, 'tab-1');
});

test('concurrent Broker shutdown callers share the same drain and close', async t => {
  const { broker } = await environment(t);
  const first = broker.close(), second = broker.close();
  assert.equal(first, second); await first; await broker.close();
});
