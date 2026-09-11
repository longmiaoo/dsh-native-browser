import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, link, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { diagnose } from '../dist/packages/installer/src/doctor.js';
import { installHost } from '../dist/packages/installer/src/install.js';
import { launcherText, launcherPaths } from '../dist/packages/installer/src/launcher.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { RpcPeer } from '../dist/packages/transport-native/src/rpc.js';
import { FakeProvider } from './helpers/fake-provider.mjs';
import { brokerCapabilities } from '../dist/packages/contracts/src/wire.js';

const extensionId = 'a'.repeat(32);
const origin = `chrome-extension://${extensionId}/`;
const finding = (report, id) => report.checks.find(c => c.id === id);
async function fixture(t, broker = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-dx-'));
  let server;
  t.after(async () => { await server?.close(); await rm(directory, { recursive: true }); });
  const manifestDir = path.join(directory, 'manifests');
  const installed = await installHost({ directory, extensionId, brand: 'chrome', manifestDir,
    cliPath: path.resolve('bin/dsh-native-browser.mjs') });
  if (broker) server = await startBroker({ directory, allowedOrigins: ['https://example.test'] });
  return { directory, installed, broker: server, options: { directory, manifestDir, brand: 'chrome', extensionId } };
}

test('launcher parser accepts only round-trippable fixed quoted grammar, never shell evaluation', () => {
  const values = { node: "/tmp/a'b/node", cli: '/tmp/has spaces/cli', directory: '/tmp/$(touch nope)' };
  assert.deepEqual(launcherPaths(launcherText(values.node, values.cli, values.directory)), values);
  assert.equal(launcherPaths(launcherText(values.node, values.cli, values.directory) + 'touch nope\n'), undefined);
  assert.equal(launcherPaths('#!/bin/sh\necho do-not-execute\n'), undefined);
});

test('doctor reports missing installation without creating directories or tokens', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-empty-'));
  t.after(() => rm(root, { recursive: true }));
  const result = await diagnose({ directory: path.join(root, 'missing'), manifestDir: path.join(root, 'manifest'), brand: 'chrome' });
  assert.equal(result.status, 'failed');
  assert.equal(finding(result, 'runtime-directory').code, 'MISSING');
  assert.equal(finding(result, 'broker').status, 'skipped');
  assert.deepEqual(await readdir(root), []);
});

test('doctor distinguishes installed-but-stopped from a connected matching browser and is content-redacted', async t => {
  const f = await fixture(t, true);
  const noBrowser = await diagnose(f.options);
  assert.equal(noBrowser.status, 'attention');
  assert.equal(finding(noBrowser, 'browser-connection').code, 'NO_MATCHING_BROWSER');
  const provider = new FakeProvider();
  provider.instance.brand = 'chrome'; provider.instance.profileLabel = 'private-profile-secret';
  f.broker.runtime.register(provider);
  const before = await readFile(path.join(f.directory, 'auth-token'), 'utf8');
  const journalBefore = await readFile(path.join(f.directory, 'action-journal.jsonl'));
  const filesBefore = await readdir(f.directory);
  const lockBefore = await lstat(path.join(f.directory, 'broker-lock.sqlite'), { bigint: true });
  const result = await diagnose(f.options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.connection, { connected: true, instanceCount: 1, matchingBrowserCount: 1 });
  assert.deepEqual(provider.calls, []);
  const encoded = JSON.stringify(result);
  for (const secret of [before.trim(), origin, extensionId, 'private-profile-secret', 'https://example.test', f.directory]) assert.equal(encoded.includes(secret), false);
  assert.deepEqual(await readdir(f.directory), filesBefore);
  assert.deepEqual(await readFile(path.join(f.directory, 'action-journal.jsonl')), journalBefore);
  assert.equal((await lstat(path.join(f.directory, 'broker-lock.sqlite'), { bigint: true })).ino, lockBefore.ino);
  assert.equal(await readFile(path.join(f.directory, 'auth-token'), 'utf8'), before);
  await f.broker.close();
  const stopped = await diagnose(f.options);
  assert.equal(stopped.status, 'failed');
  assert.equal(finding(stopped, 'socket').code, 'MISSING');
});

test('doctor detects wrong extension/brand registration and does not silently trust another browser', async t => {
  const f = await fixture(t, true);
  const wrong = await diagnose({ ...f.options, extensionId: 'b'.repeat(32) });
  assert.equal(finding(wrong, 'browser-manifest').code, 'EXTENSION_ID_MISMATCH');
  const m = JSON.parse(await readFile(f.installed.manifest, 'utf8'));
  m.allowed_origins.push(`chrome-extension://${'b'.repeat(32)}/`);
  await writeFile(f.installed.manifest, JSON.stringify(m));
  assert.equal(finding(await diagnose(f.options), 'browser-manifest').code, 'ORIGIN_MISMATCH');
  m.allowed_origins = [origin]; m.path = '/tmp/another-runtime/native-host';
  await writeFile(f.installed.manifest, JSON.stringify(m));
  assert.equal(finding(await diagnose(f.options), 'browser-manifest').code, 'MANIFEST_MISMATCH');
});

test('doctor supports the Edge brand path seam without treating Chrome connection as Edge acceptance', async t => {
  const f = await fixture(t, true);
  const provider = new FakeProvider(); provider.instance.brand = 'chrome'; f.broker.runtime.register(provider);
  const result = await diagnose({ ...f.options, brand: 'edge' });
  assert.equal(result.status, 'attention');
  assert.equal(result.connection.instanceCount, 1);
  assert.equal(result.connection.matchingBrowserCount, 0);
  assert.equal(finding(result, 'browser-connection').code, 'NO_MATCHING_BROWSER');
});

test('doctor rejects private-file hazards without changing their contents or permissions', async t => {
  for (const hazard of ['symlink', 'hardlink', 'oversized', 'public', 'malformed']) {
    await t.test(hazard, async t => {
      const f = await fixture(t);
      const file = path.join(f.directory, 'native-host.json');
      if (hazard === 'symlink') {
        const target = path.join(f.directory, 'unrelated');
        await writeFile(target, 'never read this'); await rm(file); await symlink(target, file);
      } else if (hazard === 'hardlink') await link(file, path.join(f.directory, 'second-link'));
      else if (hazard === 'oversized') await writeFile(file, 'x'.repeat(16385));
      else if (hazard === 'public') await chmod(file, 0o644);
      else await writeFile(file, 'not-json-secret-value');
      const before = await lstat(file, { bigint: true });
      const result = await diagnose(f.options);
      assert.equal(finding(result, 'host-config').code, hazard === 'malformed' ? 'INVALID_JSON' : 'UNSAFE_FILE');
      const after = await lstat(file, { bigint: true });
      for (const key of ['ino', 'mode', 'size', 'mtimeNs']) assert.equal(after[key], before[key]);
      assert.equal(JSON.stringify(result).includes('not-json-secret-value'), false);
    });
  }
});

test('doctor refuses unsafe runtime and token before any Broker connection', async t => {
  const f = await fixture(t, true);
  await chmod(f.directory, 0o755);
  let result = await diagnose(f.options);
  assert.equal(finding(result, 'runtime-directory').code, 'UNSAFE_DIRECTORY');
  assert.equal(finding(result, 'auth-token').status, 'skipped');
  await chmod(f.directory, 0o700);
  await writeFile(path.join(f.directory, 'auth-token'), 'bad-token-secret');
  result = await diagnose(f.options);
  assert.equal(finding(result, 'auth-token').code, 'INVALID_TOKEN');
  assert.equal(finding(result, 'broker').status, 'skipped');
});

test('doctor checks launcher grammar and moved targets without executing it', async t => {
  const f = await fixture(t);
  await writeFile(f.installed.launcher, `#!/bin/sh\ntouch '${path.join(f.directory, 'executed')}'\n`);
  assert.equal(finding(await diagnose(f.options), 'launcher').code, 'LAUNCHER_MISMATCH');
  await assert.rejects(lstat(path.join(f.directory, 'executed')), { code: 'ENOENT' });
  await writeFile(f.installed.launcher, launcherText(process.execPath, path.join(f.directory, 'moved-cli'), f.directory));
  assert.equal(finding(await diagnose(f.options), 'launcher').code, 'MISSING');
  await writeFile(f.installed.launcher, launcherText(process.execPath, path.resolve('bin/dsh-native-browser.mjs'), f.directory));
  await chmod(f.installed.launcher, 0o600);
  assert.equal(finding(await diagnose(f.options), 'launcher').code, 'UNSAFE_FILE');
});

test('doctor bounds a silent socket handshake and preserves foreign socket files', async t => {
  const f = await fixture(t);
  const connections = new Set();
  const server = net.createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  const socketPath = path.join(f.directory, 'broker.sock');
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  t.after(async () => { for (const c of connections) c.destroy(); await new Promise(resolve => server.close(resolve)); });
  const started = Date.now();
  const report = await diagnose({ ...f.options, timeoutMs: 60 });
  assert.equal(finding(report, 'broker').code, 'BROKER_TIMEOUT');
  assert.ok(Date.now() - started < 2000);
  assert.ok((await lstat(socketPath)).isSocket());
});

test('doctor validates Broker reply shape and never emits remote strings', async t => {
  const f = await fixture(t);
  const peers = new Set();
  const server = net.createServer(socket => {
    const peer = new RpcPeer(socket, socket); peers.add(peer);
    peer.handle(async method => method === 'hello' ? { version: 1, connectionEpoch: 'doctor-test', capabilities: [...brokerCapabilities] } : { secret: 'remote-secret' });
  });
  const socketPath = path.join(f.directory, 'broker.sock');
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  t.after(async () => { for (const p of peers) p.close(); await new Promise(resolve => server.close(resolve)); });
  const report = await diagnose(f.options);
  assert.equal(finding(report, 'broker').code, 'INVALID_RESPONSE');
  assert.equal(JSON.stringify(report).includes('remote-secret'), false);
});

test('doctor CLI has machine-readable failure output and a failing exit status without creating state', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-doctor-cli-'));
  t.after(() => rm(root, { recursive: true }));
  const child = spawn(process.execPath, ['bin/dsh-native-browser.mjs', 'doctor', `--runtime-dir=${path.join(root, 'absent')}`, `--extension-id=${extensionId}`],
    { env: { ...process.env, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 1); assert.equal(err, '');
  assert.equal(JSON.parse(out).status, 'failed');
  assert.deepEqual(await readdir(root), []);
});
