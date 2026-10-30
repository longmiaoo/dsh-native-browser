import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stageExtension } from '../dist/packages/installer/src/stage.js';
import { brokerServicePlist, installBrokerService, uninstallBrokerService, SERVICE_LABEL } from '../dist/packages/installer/src/service.js';
import { quickInstall } from '../dist/packages/installer/src/quick-install.js';

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/dsh-native-browser.mjs', import.meta.url));

async function extensionFixture(root, version = '1') {
  const source = path.join(root, `source-${version}`);
  await mkdir(path.join(source, 'nested'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, version }), { mode: 0o600 });
  await writeFile(path.join(source, 'nested', 'worker.js'), `// ${version}\n`, { mode: 0o600 });
  return source;
}

test('stages extension files under a stable private path and replaces old contents', async t => {
  const root = await mkdtemp('/tmp/dsh-stage-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtime'), { mode: 0o700 });
  const first = await extensionFixture(root, '1');
  const destination = path.join(root, 'runtime', 'extension', 'chrome');
  const staged = await stageExtension(first, destination);
  assert.equal(staged.path, destination);
  assert.equal(staged.files, 3);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).version, '1');
  const second = await extensionFixture(root, '2');
  await stageExtension(second, destination);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).version, '2');
});

test('staging refuses symbolic links and preserves the previous staged copy', async t => {
  const root = await mkdtemp('/tmp/dsh-stage-link-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtime'), { mode: 0o700 });
  const destination = path.join(root, 'runtime', 'extension', 'chrome');
  await stageExtension(await extensionFixture(root, 'safe'), destination);
  const attacked = path.join(root, 'attacked');
  await mkdir(attacked, { mode: 0o700 });
  await symlink('/etc/hosts', path.join(attacked, 'hosts'));
  await assert.rejects(stageExtension(attacked, destination), { code: 'POLICY_DENIED' });
  assert.equal(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')).version, 'safe');
});

test('staging copies pnpm hard-linked package files without mutating the shared source', async t => {
  const root = await mkdtemp('/tmp/dsh-stage-pnpm-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await extensionFixture(root);
  const file = path.join(source, 'nested/worker.js');
  await link(file, path.join(root, 'store-file'));
  const before = await lstat(file);
  await mkdir(path.join(root, 'runtime'), { mode: 0o700 });
  const destination = path.join(root, 'runtime/extension/chrome');
  await stageExtension(source, destination);
  const after = await lstat(file), copied = await lstat(path.join(destination, 'nested/worker.js'));
  assert.equal(before.nlink, 2); assert.equal(after.nlink, 2); assert.equal(after.mode, before.mode);
  assert.equal(copied.nlink, 1); assert.notEqual(copied.ino, after.ino);
  assert.equal(await readFile(path.join(destination, 'nested/worker.js'), 'utf8'), await readFile(file, 'utf8'));
});

test('LaunchAgent plist pins a personal Broker and escapes paths', () => {
  const plist = brokerServicePlist({ label: SERVICE_LABEL, nodePath: '/tmp/a&b/node', cliPath: '/tmp/cli.mjs',
    directory: '/tmp/runtime', accessMode: 'personal', allowedOrigins: [], stdoutLog: '/tmp/out.log', stderrLog: '/tmp/err.log' });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /--access-mode=personal/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.throws(() => brokerServicePlist({ label: SERVICE_LABEL, nodePath: '/tmp/node', cliPath: '/tmp/cli.mjs',
    directory: '/tmp/runtime', accessMode: 'restricted', allowedOrigins: [], stdoutLog: '/tmp/out', stderrLog: '/tmp/err' }));
});

test('quick install stages the extension, registers the host, starts the service and opens setup', async t => {
  // Exercise macOS orchestration on every CI platform. Both OS command runners
  // are mocked below; never invoke the host machine's desktop or launchctl.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const root = await mkdtemp('/tmp/dsh-quick-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const manifestDir = path.join(root, 'native');
  const plistDir = path.join(root, 'agents');
  const calls = [], opened = [];
  const result = await quickInstall({ browser: 'chrome', extensionSource: await extensionFixture(root),
    extensionId: 'a'.repeat(32), directory: runtime, manifestDir, plistDirectory: plistDir,
    cliPath: bin, nodePath: process.execPath, launchctl: async args => { calls.push(args); },
    openRunner: async command => { opened.push(command); }, serviceReady: async () => {} });
  assert.equal(result.accessMode, 'personal');
  assert.equal(result.manualActionRequired, 'load-unpacked');
  assert.equal(result.service.label, SERVICE_LABEL);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap']);
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[0], { file: '/usr/bin/open', args: ['-a', 'Google Chrome', 'chrome://extensions/'] });
  assert.deepEqual(opened[1], { file: '/usr/bin/open', args: ['-R', result.extensionPath] });
  await readFile(path.join(runtime, 'extension', 'chrome', 'manifest.json'));
  await readFile(path.join(manifestDir, 'com.longmiaoo.dsh_native_browser.json'));
  await readFile(path.join(plistDir, `${SERVICE_LABEL}.plist`));
});

test('install and uninstall never replace or stop a service owned by a different runtime', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const root = await mkdtemp('/tmp/dsh-service-owner-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const plistDirectory = path.join(root, 'agents');
  await mkdir(plistDirectory, { mode: 0o700 });
  const file = path.join(plistDirectory, `${SERVICE_LABEL}.plist`);
  const content = brokerServicePlist({ label: SERVICE_LABEL, nodePath: process.execPath, cliPath: bin,
    directory: path.join(root, 'owner'), accessMode: 'personal', allowedOrigins: [], stdoutLog: '/tmp/out', stderrLog: '/tmp/err' });
  await writeFile(file, content, { mode: 0o600 });
  const calls = [], options = { directory: path.join(root, 'other'), plistDirectory,
    launchctl: async args => { calls.push(args); } };
  await assert.rejects(installBrokerService({ ...options, cliPath: bin, accessMode: 'personal' }), { code: 'POLICY_DENIED' });
  await assert.rejects(uninstallBrokerService(options), { code: 'POLICY_DENIED' });
  assert.deepEqual(calls, []);
  assert.equal(await readFile(file, 'utf8'), content);
});

test('Broker service rejects unsupported platforms before creating a LaunchAgent', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let launched = false;
  await assert.rejects(installBrokerService({ directory: '/unused', cliPath: bin,
    accessMode: 'personal', launchctl: async () => { launched = true; } }),
  { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(launched, false);
});

test('unsupported automatic install leaves host registration and runtime untouched', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const root = await mkdtemp('/tmp/dsh-unsupported-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(quickInstall({ browser: 'chrome', extensionSource: await extensionFixture(root),
    extensionId: 'a'.repeat(32), directory: path.join(root, 'runtime'),
    manifestDir: path.join(root, 'native'), cliPath: bin }), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(access(path.join(root, 'runtime')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'native')), { code: 'ENOENT' });
});

test('CLI install supports a headless dry path without opening UI or installing a service', async t => {
  const root = await mkdtemp('/tmp/dsh-cli-install-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [bin, 'install', '--browser=chrome', '--no-service', '--no-open', '--json',
    `--runtime-dir=${path.join(root, 'runtime')}`, `--manifest-dir=${path.join(root, 'native')}`]);
  const result = JSON.parse(stdout);
  assert.equal(result.service, undefined);
  assert.equal(result.opened, undefined);
  assert.equal(result.accessMode, 'personal');
  assert.match(result.extensionPath, /runtime\/extension\/chrome$/);
});
