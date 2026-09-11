import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, lstat, readFile, writeFile, symlink, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireBrokerOwnership } from '../dist/packages/broker/src/ownership.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { connectBroker } from '../dist/packages/broker/src/client.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-owner-')), children = [];
  const launch = (mode = 'idle') => {
    const child = fork(new URL('./helpers/broker-process.mjs', import.meta.url), [directory, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    const exited = once(child, 'exit');
    const ready = Promise.race([once(child, 'message').then(([value]) => value), exited.then(() => { throw new Error(`Early Broker exit: ${stderr}`); })]);
    const stop = async (signal = 'SIGKILL') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    };
    const entry = { child, exited, ready, stop }; children.push(entry); return entry;
  };
  t.after(async () => { for (const child of children) await child.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, launch };
}

test('process-lifetime ownership excludes concurrent processes and releases after SIGKILL', { timeout: 15000 }, async t => {
  const { directory, launch } = await fixture(t);
  const initialize = await acquireBrokerOwnership(directory); initialize.close();
  const contenders = Array.from({ length: 4 }, () => launch());
  const results = await Promise.all(contenders.map(c => c.ready));
  assert.equal(results.filter(r => r.type === 'ready').length, 1);
  assert.ok(results.filter(r => r.type === 'failed').every(r => r.code === 'BROKER_BUSY'));
  const winner = contenders[results.findIndex(r => r.type === 'ready')];
  const before = await lstat(path.join(directory, 'broker-lock.sqlite'));
  const [exit, signal] = await winner.stop(); assert.equal(exit, null); assert.equal(signal, 'SIGKILL');
  assert.equal((await lstat(path.join(directory, 'broker.sock'))).isSocket(), true);
  const restarted = launch(), ready = await restarted.ready;
  assert.equal(ready.type, 'ready'); assert.equal(ready.recoveredSocket, true);
  const after = await lstat(path.join(directory, 'broker-lock.sqlite'));
  assert.equal(after.ino, before.ino, 'The lock inode must never be replaced to recover ownership');
  assert.equal(after.mode & 0o777, 0o600);
  const peer = await connectBroker(directory); t.after(() => peer.close());
  assert.equal((await peer.call('browser.instances', {})).length, 1);
});

test('a live legacy listener without a lock is preserved rather than unlinked', async t => {
  const { directory } = await fixture(t), socket = path.join(directory, 'broker.sock');
  const server = net.createServer(peer => peer.end());
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const original = await lstat(socket);
  await assert.rejects(startBroker({ directory, allowedOrigins: [] }), e => e.code === 'BROKER_BUSY');
  assert.equal((await lstat(socket)).ino, original.ino);
  const probe = net.createConnection(socket); await once(probe, 'connect'); probe.destroy();
});

test('socket recovery refuses ordinary files and symlinks without changing their contents', async t => {
  for (const mode of ['file', 'symlink']) {
    const { directory } = await fixture(t), socket = path.join(directory, 'broker.sock'), target = path.join(directory, 'protected');
    await writeFile(target, 'untouched', { mode: 0o600 });
    if (mode === 'file') await writeFile(socket, 'not a socket', { mode: 0o600 }); else await symlink(target, socket);
    const before = await lstat(socket);
    await assert.rejects(startBroker({ directory, allowedOrigins: [] }), e => e.code === 'BROKER_STATE_UNSAFE');
    assert.equal((await lstat(socket)).ino, before.ino); assert.equal(await readFile(target, 'utf8'), 'untouched');
    if (mode === 'file') assert.equal(await readFile(socket, 'utf8'), 'not a socket');
  }
});

test('unsafe lock paths fail before any socket recovery or journal initialization', async t => {
  for (const mode of ['permissions', 'symlink', 'hardlink', 'corrupt', 'sidecar']) {
    const { directory } = await fixture(t), file = path.join(directory, 'broker-lock.sqlite'), target = path.join(directory, 'protected');
    await writeFile(target, 'untouched', { mode: 0o600 });
    if (mode === 'symlink') await symlink(target, file);
    else if (mode === 'hardlink') await link(target, file);
    else if (mode === 'sidecar') await symlink(target, file + '-journal');
    else { await writeFile(file, mode === 'corrupt' ? 'not sqlite' : '', { mode: 0o600 }); if (mode === 'permissions') await chmod(file, 0o644); }
    await assert.rejects(startBroker({ directory, allowedOrigins: [] }), e => e.code === 'BROKER_STATE_UNSAFE');
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    await assert.rejects(lstat(path.join(directory, 'action-journal.jsonl')), e => e.code === 'ENOENT');
  }
});

test('startup failure releases ownership without discarding a corrupt action journal', async t => {
  const { directory } = await fixture(t), file = path.join(directory, 'action-journal.jsonl');
  await writeFile(file, 'torn record', { mode: 0o600 });
  for (let n = 0; n < 2; n++) await assert.rejects(startBroker({ directory, allowedOrigins: [] }), e => e.code === 'JOURNAL_UNAVAILABLE');
  assert.equal(await readFile(file, 'utf8'), 'torn record');
  const ownership = await acquireBrokerOwnership(directory); ownership.close();
});

test('ownership close is idempotent and closed owners cannot prepare an endpoint', async t => {
  const { directory } = await fixture(t), ownership = await acquireBrokerOwnership(directory);
  ownership.close(); ownership.close();
  await assert.rejects(ownership.prepareSocket(path.join(directory, 'broker.sock')), e => e.code === 'BROKER_STATE_UNSAFE');
  const next = await acquireBrokerOwnership(directory); next.close();
});

test('shutdown retains exclusive ownership until durable settlement has drained', async t => {
  const { directory } = await fixture(t), broker = await startBroker({ directory, allowedOrigins: ['https://example.test'] });
  const provider = new FakeProvider(); broker.runtime.register(provider);
  const journal = broker.runtime.durable, settle = journal.settle.bind(journal);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  journal.settle = async (...args) => { entered(); await gate; return settle(...args); };
  t.after(async () => { release(); await broker.close(); });
  const signal = new AbortController().signal;
  const lease = await broker.runtime.claim('owner', 'fake-1', 'tab-1', signal);
  const pending = broker.runtime.act('owner', { requestId: 'one', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'click', ref: 'node-1' } }, signal);
  await started; const closing = broker.close();
  try { await assert.rejects(startBroker({ directory, allowedOrigins: [] }), e => e.code === 'BROKER_BUSY'); }
  finally { release(); }
  await pending; await closing;
  const next = await startBroker({ directory, allowedOrigins: [] }); await next.close();
});

test('real Broker SIGKILL during an action recovers the stale endpoint and never replays its effect', { timeout: 15000 }, async t => {
  const { directory, launch } = await fixture(t), old = launch('interrupt-effect');
  assert.equal((await old.ready).type, 'ready');
  const capability = randomBytes(32).toString('hex'), sessionId = 'crash-turn';
  const first = await connectBroker(directory, capability); t.after(() => first.close());
  const lease = await first.call('browser.claim', { sessionId, instanceId: 'fake-1', tab: 'tab-1' });
  const request = { requestId: 'send-once', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'click', ref: 'node-1' } };
  const effect = once(old.child, 'message');
  const action = first.call('browser.act', { sessionId, request });
  const lost = assert.rejects(action, e => e.code === 'CONNECTION_LOST');
  assert.equal((await effect)[0].type, 'effect');
  await old.stop(); await lost;
  const replacement = launch();
  const restarted = await replacement.ready; assert.equal(restarted.type, 'ready'); assert.equal(restarted.recoveredSocket, true);
  const second = await connectBroker(directory, capability); t.after(() => second.close());
  const recovery = await second.call('browser.act', { sessionId, request });
  assert.equal(recovery.code, 'RECOVERY_REQUIRED'); assert.equal(recovery.recovery.state, 'reserved');
  assert.equal(recovery.outcome, 'unknown'); assert.equal(recovery.observation, undefined);
  await assert.rejects(second.call('browser.observe', { sessionId, leaseId: lease.id }), e => e.code === 'LEASE_REVOKED');
  assert.equal(await readFile(path.join(directory, 'effects'), 'utf8'), 'effect\n');
});
