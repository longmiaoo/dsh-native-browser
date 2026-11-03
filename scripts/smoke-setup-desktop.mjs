// Run with DSH Desktop's executable and ELECTRON_RUN_AS_NODE=1. All files and
// registrations are temporary; never loads/unloads the user's LaunchAgent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifySetupRuntime } from '../dist/packages/dsh-adapter/src/setup.js';
import { quickInstall } from '../dist/packages/installer/src/quick-install.js';
import { diagnose } from '../dist/packages/installer/src/doctor.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { connectBroker } from '../dist/packages/broker/src/client.js';
import { RpcPeer } from '../dist/packages/transport-native/src/rpc.js';
import { providerCapabilities } from '../dist/packages/contracts/src/wire.js';

assert.ok(process.versions.electron, 'Run with the Desktop executable, not standalone Node');
const runtime = await verifySetupRuntime(); assert.equal(runtime.electronRunAsNode, true);
const root = await mkdtemp('/tmp/dsh-desktop-setup-');
const directory = path.join(root, 'runtime'), manifestDir = path.join(root, 'manifests');
const extensionId = 'a'.repeat(32);
let broker, client, native, child, exited;
let phase = 'install', stderr = '';
try {
  const result = await quickInstall({ browser: 'chrome', directory, manifestDir,
    extensionSource: path.resolve('dist/extension/chrome'), extensionId,
    cliPath: path.resolve('bin/dsh-native-browser.mjs'), ...runtime, service: false, open: false });
  broker = await startBroker({ directory, accessMode: 'personal', allowedOrigins: [] });
  client = await connectBroker(directory);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(result.host.launcher, [`chrome-extension://${extensionId}/`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); }); exited = once(child, 'exit');
  native = new RpcPeer(child.stdout, child.stdin);
  native.handle(async method => {
    if (method === 'tabs.list') return [{ id: 'desktop:1', instanceId: 'desktop', url: 'https://example.test/', title: 'Desktop runtime fixture' }];
    throw new Error(`Unexpected ${method}`);
  });
  phase = 'native hello';
  const hello = await native.call('hello', { bootstrap: 1, versions: [1], role: 'provider', capabilities: [...providerCapabilities],
    instance: { id: 'desktop', family: 'chromium', brand: 'chrome', version: 'fixture', profileLabel: 'isolated' } }, AbortSignal.timeout(5000));
  assert.equal(hello.version, 1);
  phase = 'tab query';
  const tabs = await client.call('browser.tabs', { sessionId: 'test', instanceId: 'desktop' }, AbortSignal.timeout(5000));
  assert.equal(tabs[0].title, 'Desktop runtime fixture');
  const doctor = await diagnose({ directory, manifestDir, brand: 'chrome', extensionId });
  assert.equal(doctor.status, 'ready');
  const report = { passed: true, electron: process.versions.electron, node: process.versions.node,
    scope: 'Desktop runtime probe + installed Native Messaging launcher + Broker handshake and tab query; no actual Chrome or LaunchAgent',
    launcherWithoutInheritedElectronEnv: true, doctor: doctor.status };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/setup-desktop.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  throw new Error(`${phase}: ${error.message}; child stderr: ${stderr}`, { cause: error });
} finally {
  native?.close(); child?.kill('SIGTERM'); if (exited) await exited;
  client?.close(); await broker?.close(); await rm(root, { recursive: true, force: true });
}
