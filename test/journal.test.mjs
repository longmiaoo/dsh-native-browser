import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, lstat, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { FileActionJournal } from '../dist/packages/broker/src/action-journal.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { FakeProvider } from './helpers/fake-provider.mjs';

const secret = 'b'.repeat(64), signal = () => new AbortController().signal;
async function directory(t) {
  const value = await mkdtemp(path.join(tmpdir(), 'dsh-journal-'));
  t.after(() => rm(value, { recursive: true, force: true })); return value;
}
async function runtime(t, durable) {
  const provider = new FakeProvider(), instance = new BrowserRuntime(async () => true, undefined, durable);
  instance.register(provider); t.after(() => instance.dispose());
  const lease = await instance.claim('owner', 'fake-1', 'tab-1', signal());
  const request = { requestId: 'send-once', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'fill', ref: 'node-1', text: 'private form value' } };
  return { provider, instance, request, lease };
}

test('durable journal reopens metadata without persisting page payloads or raw identities', async t => {
  const dir = await directory(t), file = path.join(dir, 'action-journal.jsonl');
  let journal = await FileActionJournal.open(dir, secret);
  assert.equal(await journal.reserve('private-owner/request', 'private-payload-digest', 'fill'), true);
  assert.equal(await journal.reserve('private-owner/request', 'private-payload-digest', 'fill'), false);
  await journal.settle('private-owner/request', { outcome: 'succeeded', dispatch: 'observed' });
  await journal.close();
  const text = await readFile(file, 'utf8');
  for (const raw of ['private-owner', 'private-payload', secret, 'observation', 'text', 'leaseId', 'token']) assert.equal(text.includes(raw), false);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  journal = await FileActionJournal.open(dir, secret); t.after(() => journal.close());
  assert.deepEqual(journal.lookup('private-owner/request', 'private-payload-digest'), {
    state: 'settled', dispatch: 'dispatched', priorOutcome: 'succeeded', recordedAt: journal.lookup('private-owner/request', 'private-payload-digest').recordedAt });
  assert.throws(() => journal.lookup('private-owner/request', 'changed'), e => e.code === 'REQUEST_ID_CONFLICT');
});

test('expired fences compact atomically while unexpired records are not evicted for capacity', async t => {
  const dir = await directory(t); let now = 1000;
  const journal = await FileActionJournal.open(dir, secret, { maxEntries: 1, ttlMs: 100, now: () => now });
  t.after(() => journal.close());
  await journal.reserve('first', 'hash', 'click'); await journal.settle('first', { outcome: 'unknown', dispatch: 'dispatched' });
  const old = (await readFile(path.join(dir, 'action-journal.jsonl'), 'utf8')).split('\n')[0];
  await assert.rejects(journal.reserve('second', 'hash', 'click'), e => e.code === 'JOURNAL_FULL');
  now = 1101;
  assert.equal(await journal.reserve('second', 'hash', 'click'), true);
  assert.equal(journal.lookup('first', 'hash'), undefined);
  assert.equal((await readFile(path.join(dir, 'action-journal.jsonl'), 'utf8')).includes(old), false);
});

test('byte budget reserves settlement space for every concurrent intent', async t => {
  const journal = await FileActionJournal.open(await directory(t), secret, { maxBytes: 2500 });
  t.after(() => journal.close());
  await journal.reserve('first', 'hash', 'click');
  await assert.rejects(journal.reserve('second', 'hash', 'click'), e => e.code === 'JOURNAL_FULL');
  await journal.settle('first', { outcome: 'succeeded', dispatch: 'observed' });
});

test('torn or modified journal data blocks recovery rather than silently forgetting an intent', async t => {
  for (const mode of ['torn', 'tampered', 'wrong-key']) {
    const dir = await directory(t), file = path.join(dir, 'action-journal.jsonl');
    const journal = await FileActionJournal.open(dir, secret);
    await journal.reserve('one', 'hash', 'click'); await journal.close();
    const data = await readFile(file, 'utf8');
    if (mode === 'torn') await writeFile(file, data.slice(0, -5));
    if (mode === 'tampered') await writeFile(file, data.replace('click', 'press'));
    await assert.rejects(FileActionJournal.open(dir, mode === 'wrong-key' ? 'c'.repeat(64) : secret), e => e.code === 'JOURNAL_UNAVAILABLE');
  }
});

test('journal refuses unsafe permissions, symlinks and hardlinks without rewriting their targets', async t => {
  for (const mode of ['public', 'symlink', 'hardlink']) {
    const dir = await directory(t), file = path.join(dir, 'action-journal.jsonl'), target = path.join(dir, 'protected');
    await writeFile(target, 'do not modify', { mode: 0o600 });
    if (mode === 'symlink') await symlink(target, file);
    else if (mode === 'hardlink') await link(target, file);
    else { await writeFile(file, '', { mode: 0o600 }); await chmod(file, 0o644); }
    await assert.rejects(FileActionJournal.open(dir, secret), e => e.code === 'POLICY_DENIED');
    assert.equal(await readFile(target, 'utf8'), 'do not modify');
  }
});

test('failed durable write poisons the store and never falls back to a volatile fence', async t => {
  const journal = await FileActionJournal.open(await directory(t), secret); t.after(() => journal.close());
  // Deterministic disk-full/fsync-failure injection at the actual file-handle seam.
  const original = journal.fd.sync.bind(journal.fd);
  journal.fd.sync = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(journal.reserve('one', 'hash', 'click'), e => e.code === 'JOURNAL_UNAVAILABLE');
  journal.fd.sync = original;
  assert.throws(() => journal.lookup('one', 'hash'), e => e.code === 'JOURNAL_UNAVAILABLE');
  assert.throws(() => journal.reserve('two', 'hash', 'click'), e => e.code === 'JOURNAL_UNAVAILABLE');
});

test('runtime cannot call a provider before the durable intent completes', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const durable = { lookup() {}, reserve() { entered(); return new Promise(resolve => { release = () => resolve(true); }); }, async settle() {} };
  const f = await runtime(t, durable), pending = f.instance.act('owner', f.request, signal());
  await started; assert.equal(f.provider.calls.length, 0); release();
  assert.equal((await pending).outcome, 'succeeded'); assert.equal(f.provider.calls.length, 1);
});

test('journal close drains an admitted write and rejects later writes', async t => {
  const dir = await directory(t), journal = await FileActionJournal.open(dir, secret);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; }), sync = journal.fd.sync.bind(journal.fd);
  journal.fd.sync = async () => { entered(); await new Promise(resolve => { release = resolve; }); await sync(); };
  const pending = journal.reserve('one', 'hash', 'click');
  await started; const closing = journal.close();
  assert.throws(() => journal.reserve('two', 'hash', 'click'), e => e.code === 'JOURNAL_UNAVAILABLE');
  release(); await pending; await closing;
  const recovered = await FileActionJournal.open(dir, secret); t.after(() => recovered.close());
  assert.equal(recovered.lookup('one', 'hash').state, 'reserved');
});

test('cancellation during durable reservation does not dispatch after the disk unblocks', async t => {
  let release, entered, settled;
  const started = new Promise(resolve => { entered = resolve; });
  const durable = { lookup() {}, reserve() { entered(); return new Promise(resolve => { release = () => resolve(true); }); },
    async settle(_key, result) { settled = result; } };
  const f = await runtime(t, durable), controller = new AbortController();
  const pending = f.instance.act('owner', f.request, controller.signal);
  await started; controller.abort(); release();
  assert.equal((await pending).dispatch, 'notDispatched'); assert.equal(f.provider.calls.length, 0);
  assert.equal(settled.dispatch, 'notDispatched');
});

test('reservation failure prevents input; settlement failure returns unknown after input', async t => {
  for (const phase of ['reserve', 'settle']) {
    const durable = { lookup() {}, async reserve() {
      if (phase === 'reserve') throw new BrowserError('JOURNAL_UNAVAILABLE', 'fault'); return true;
    }, async settle() { throw new BrowserError('JOURNAL_UNAVAILABLE', 'fault'); } };
    const f = await runtime(t, durable), result = await f.instance.act('owner', f.request, signal());
    assert.equal(result.code, 'JOURNAL_UNAVAILABLE');
    assert.equal(result.outcome, phase === 'reserve' ? 'failed' : 'unknown');
    assert.equal(f.provider.calls.length, phase === 'reserve' ? 0 : 1);
  }
});

test('runtime shutdown drains durable settlement before closing its persistence owner', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const durable = { lookup() {}, async reserve() { return true; }, settle() { entered(); return new Promise(resolve => { release = resolve; }); } };
  const f = await runtime(t, durable), pending = f.instance.act('owner', f.request, signal());
  await started; let disposed = false;
  const disposing = f.instance.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  release(); await pending; await disposing; assert.equal(disposed, true);
});

test('SIGKILL after a side effect leaves a durable intent that prevents re-execution in a fresh process', async t => {
  const dir = await directory(t);
  const child = fork(new URL('./helpers/journal-crash-child.mjs', import.meta.url), [dir, secret], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let error = ''; child.stderr.on('data', data => { error += data; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Child exited before effect: ${error}`); })]);
  assert.equal(message.type, 'effect'); child.kill('SIGKILL'); await exited;
  const journal = await FileActionJournal.open(dir, secret); t.after(() => journal.close());
  const provider = new FakeProvider(), restored = new BrowserRuntime(async () => true, undefined, journal);
  restored.register(provider); t.after(() => restored.dispose());
  const result = await restored.act('new-owner', message.request, signal(), 'private-recovery-scope');
  assert.equal(result.outcome, 'unknown'); assert.equal(result.code, 'RECOVERY_REQUIRED');
  assert.equal(result.recovery.state, 'reserved'); assert.equal(result.observation, undefined);
  assert.equal(provider.calls.length, 0);
  assert.equal(await readFile(path.join(dir, 'effects'), 'utf8'), 'effect\n');
  assert.equal((await readFile(path.join(dir, 'action-journal.jsonl'), 'utf8')).includes('private input'), false);
});
