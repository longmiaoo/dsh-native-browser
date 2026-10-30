import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createSetupController, verifySetupRuntime } from '../dist/packages/dsh-adapter/src/setup.js';
import { diagnose } from '../dist/packages/installer/src/doctor.js';
import { launcherText, launcherPaths } from '../dist/packages/installer/src/launcher.js';
import { brokerServicePlist, SERVICE_LABEL } from '../dist/packages/installer/src/service.js';
import { installHost } from '../dist/packages/installer/src/install.js';

const signal = () => new AbortController().signal;
async function fixture(t, patch = {}) {
  const root = await mkdtemp('/tmp/dsh-setup-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const dependencies = {
    platform: 'darwin', diagnose,
    verifyRuntime: async () => ({ nodePath: process.execPath, electronRunAsNode: false }),
    quickInstall: async options => { calls.push(options); return { extensionPath: path.join(options.directory, 'extension/chrome') }; },
    openSetup: async () => { throw new Error('unexpected open'); }, ...patch,
  };
  return { root, calls, dependencies, handle: createSetupController(path.join(root, 'runtime'), dependencies) };
}

test('setup status is read-only and never installs or discovers a profile', async t => {
  const f = await fixture(t);
  const response = await f.handle('setup.status', {}, signal());
  assert.equal(response.ok, true); assert.equal(response.value.report.status, 'failed');
  assert.equal(response.value.supported, true);
  assert.equal(response.value.extensionPath, path.join(f.root, 'runtime/extension/chrome'));
  assert.deepEqual(await readdir(f.root), []); assert.equal(f.calls.length, 0);
});

test('setup rejects missing consent, unknown methods and caller-controlled paths before writes', async t => {
  const f = await fixture(t);
  for (const payload of [null, [], {}, { confirmed: false }, { confirmed: true, directory: '/tmp/other' }, { confirmed: true, browser: 'edge' }]) {
    assert.equal((await f.handle('setup.install', payload, signal())).ok, false);
  }
  assert.equal((await f.handle('setup.status', { profile: 'desktop' }, signal())).ok, false);
  assert.equal((await f.handle('setup.anything', {}, signal())).ok, false);
  assert.deepEqual(await readdir(f.root), []); assert.equal(f.calls.length, 0);
});

test('installation uses the running plugin package and its configured runtime, not web/desktop guesses', async t => {
  const f = await fixture(t);
  const response = await f.handle('setup.install', { confirmed: true }, signal());
  assert.equal(response.ok, true); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].directory, path.join(f.root, 'runtime'));
  assert.equal(f.calls[0].cliPath, path.resolve('bin/dsh-native-browser.mjs'));
  assert.equal(f.calls[0].extensionSource, path.resolve('dist/extension/chrome'));
  assert.equal(f.calls[0].nodePath, process.execPath);
  assert.equal(f.calls[0].accessMode, 'personal');
  assert.equal('profile' in f.calls[0], false);
});

test('duplicate setup requests share one installation; status and reopen do not start another', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let installs = 0;
  const f = await fixture(t, { quickInstall: async () => { installs++; entered(); await pending; return {}; } });
  const first = f.handle('setup.install', { confirmed: true }, signal());
  await started;
  const second = f.handle('setup.install', { confirmed: true }, signal());
  const other = createSetupController(path.join(f.root, 'other'), f.dependencies);
  assert.equal((await other('setup.install', { confirmed: true }, signal())).error.code, 'INSTALLATION_BUSY');
  assert.equal((await f.handle('setup.status', {}, signal())).value.installing, true);
  assert.equal((await f.handle('setup.open', {}, signal())).error.code, 'INSTALLATION_BUSY');
  release(); assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(installs, 1);
  assert.equal((await f.handle('setup.status', {}, signal())).value.installing, false);
});

test('unsupported hosts and runtime failures do not write files; failure can be retried', async t => {
  const f = await fixture(t, { platform: 'linux' });
  assert.equal((await f.handle('setup.install', { confirmed: true }, signal())).error.code, 'UNSUPPORTED_CAPABILITY');
  f.dependencies.platform = 'darwin';
  f.dependencies.verifyRuntime = async () => { throw new Error('secret subprocess stderr'); };
  const failed = await f.handle('setup.install', { confirmed: true }, signal());
  assert.equal(failed.ok, false); assert.doesNotMatch(JSON.stringify(failed), /secret/);
  assert.deepEqual(await readdir(f.root), []); assert.equal(f.calls.length, 0);
  f.dependencies.verifyRuntime = async () => ({ nodePath: process.execPath, electronRunAsNode: false });
  assert.equal((await f.handle('setup.install', { confirmed: true }, signal())).ok, true);
});

test('aborted requests cannot begin setup', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.handle('setup.install', { confirmed: true }, controller.signal));
  assert.equal(f.calls.length, 0);
});

test('host runtime probe verifies actual Node and sqlite without installation', async () => {
  assert.deepEqual(await verifySetupRuntime(), { nodePath: process.execPath, electronRunAsNode: Boolean(process.versions.electron) });
});

test('Electron Node mode survives launcher parsing and upgrading an existing Node registration', async t => {
  const root = await mkdtemp('/tmp/dsh-electron-'); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { directory: path.join(root, 'runtime'), cliPath: path.resolve('bin/dsh-native-browser.mjs'),
    nodePath: process.execPath, brand: 'chrome', extensionId: 'a'.repeat(32), manifestDir: path.join(root, 'hosts') };
  await installHost(options);
  const result = await installHost({ ...options, electronRunAsNode: true });
  const launcher = await readFile(result.launcher, 'utf8');
  assert.equal(launcherPaths(launcher).electronRunAsNode, true);
  assert.match(launcher, /export ELECTRON_RUN_AS_NODE=1/);
  assert.equal(launcherPaths(launcher.replace('=1', '=0')), undefined);
  assert.equal(launcherPaths(launcher + 'echo wrong\n'), undefined);
  await installHost(options);
  assert.equal(launcherPaths(await readFile(result.launcher, 'utf8')).electronRunAsNode, undefined);
  const plist = brokerServicePlist({ label: SERVICE_LABEL, ...options, electronRunAsNode: true,
    accessMode: 'personal', allowedOrigins: [], stdoutLog: '/tmp/out', stderrLog: '/tmp/err' });
  assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  const odd = { node: "/tmp/a'b/node", cli: '/tmp/file$(echo nope).js', directory: '/tmp/r' };
  assert.deepEqual(launcherPaths(launcherText(odd.node, odd.cli, odd.directory, true)), { ...odd, electronRunAsNode: true });
});
