import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultDirectory, localState } from './local-state.js';
import { startBroker } from './server.js';
import { connectBroker } from './client.js';
import { runNativeHost } from '../../transport-native/src/host.js';
import { installHost } from '../../installer/src/install.js';
import { uninstallHost } from '../../installer/src/uninstall.js';
import { diagnose } from '../../installer/src/doctor.js';
import { extensionIdFromManifestKey } from '../../installer/src/extension.js';
import { quickInstall } from '../../installer/src/quick-install.js';
import { serviceIsLoaded, uninstallBrokerService } from '../../installer/src/service.js';

async function packagedExtension(brand: 'chrome' | 'edge') {
  const extensionPath = fileURLToPath(new URL(`../../../../dist/extension/${brand}`, import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8')) as { key?: unknown };
  const extensionId = typeof manifest.key === 'string' ? extensionIdFromManifestKey(manifest.key) : '';
  return { extensionPath, extensionId };
}

export async function main(args: string[]): Promise<void> {
  const command = args[0];
  const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const flag = (name: string) => args.includes(`--${name}`);
  const directory = option('runtime-dir') ?? defaultDirectory();
  const manifestDir = option('manifest-dir');
  const registration = manifestDir === undefined ? {} : { manifestDir };
  if (command === 'broker') {
    const allowedOrigins = args.filter(arg => arg.startsWith('--allow-origin=')).map(arg => arg.slice(15));
    const accessMode = option('access-mode') ?? 'restricted';
    if (accessMode !== 'restricted' && accessMode !== 'personal') throw new Error('Access mode must be restricted or personal');
    const broker = await startBroker({ directory, allowedOrigins, accessMode });
    console.error(`DSH Browser Broker listening at ${broker.socket}; ${accessMode === 'personal' ? 'personal user-authorized tabs' : `${allowedOrigins.length} approved origin(s)`}${broker.recoveredSocket ? '; recovered stale socket' : ''}`);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void broker.close().catch(error => { console.error(error); process.exitCode = 1; }); } };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (command === 'native-host') {
    await runNativeHost(directory, args.find(arg => arg.startsWith('chrome-extension://')) ?? '');
  } else if (command === 'extension-path') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    console.log(fileURLToPath(new URL(`../../../../dist/extension/${brand}`, import.meta.url)));
  } else if (command === 'install') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const accessMode = option('access-mode') ?? 'personal';
    if (accessMode !== 'restricted' && accessMode !== 'personal') throw new Error('Access mode must be restricted or personal');
    const allowedOrigins = args.filter(arg => arg.startsWith('--allow-origin=')).map(arg => arg.slice(15));
    if (accessMode === 'restricted' && allowedOrigins.length === 0) {
      throw new Error('Restricted install requires at least one --allow-origin=https://example.com');
    }
    const packaged = await packagedExtension(brand);
    const extensionId = option('extension-id') ?? packaged.extensionId;
    if (!extensionId) throw new Error('Packaged extension has no stable key; pass --extension-id explicitly');
    const result = await quickInstall({ browser: brand, extensionSource: packaged.extensionPath, extensionId,
      directory, ...registration, accessMode, allowedOrigins, service: !flag('no-service'), open: !flag('no-open'),
      cliPath: fileURLToPath(new URL('../../../../bin/dsh-native-browser.mjs', import.meta.url)) });
    if (flag('json')) console.log(JSON.stringify(result, null, 2));
    else {
      const browserName = brand === 'chrome' ? 'Chrome' : 'Edge';
      console.log(`\nDSH Native Browser 已准备完成\n\n扩展目录\n  ${result.extensionPath}\n\nNative Messaging Host\n  已注册\n\n本地 Broker\n  ${result.service ? `已作为 ${result.service.label} 启动` : '未自动启动（--no-service）'}\n\n还差 1 步\n  在已打开的 ${browserName} 扩展页开启“开发者模式”，点击“加载已解压的扩展程序”，选择上面的扩展目录。\n  ${result.opened ? `${browserName} 扩展页和扩展目录已自动打开。` : result.openError ? `自动打开失败：${result.openError}` : '按 --no-open 跳过了自动打开。'}\n\n验证\n  dsh plugin --profile web exec dsh-native-browser doctor --browser=${brand}\n`);
    }
  } else if (command === 'uninstall') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const extensionId = option('extension-id') ?? (await packagedExtension(brand)).extensionId;
    const service = await uninstallBrokerService({}).catch(error => ({ removed: false, plist: '', error: error instanceof Error ? error.message : String(error) }));
    const host = await uninstallHost({ directory, brand, ...registration, extensionId });
    console.log(JSON.stringify({ service, host, stagedExtensionPreserved: true }, null, 2));
  } else if (command === 'service-status') {
    console.log(JSON.stringify({ loaded: await serviceIsLoaded() }, null, 2));
  } else if (command === 'setup') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const packaged = await packagedExtension(brand);
    const extensionPath = packaged.extensionPath;
    const extensionId = option('extension-id') ?? packaged.extensionId;
    if (!extensionId) throw new Error('Packaged extension has no stable key; pass --extension-id explicitly');
    const result = await installHost({ directory, brand, ...registration, extensionId,
      cliPath: fileURLToPath(new URL('../../../../bin/dsh-native-browser.mjs', import.meta.url)) });
    console.log(JSON.stringify({ browser: brand, extensionPath, extensionId, host: result,
      nextSteps: [
        'Open chrome://extensions (or edge://extensions), enable Developer mode, choose Load unpacked, and select extensionPath.',
        'If an older unpacked build is already present, remove it first so Chrome does not keep a stale extension ID.',
        'Reload the extension after future npm upgrades.',
      ] }, null, 2));
  } else if (command === 'install-host') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const extensionId = option('extension-id') ?? (await packagedExtension(brand)).extensionId;
    const result = await installHost({ directory, brand, ...registration, extensionId,
      cliPath: fileURLToPath(new URL('../../../../bin/dsh-native-browser.mjs', import.meta.url)) });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'uninstall-host') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const extensionId = option('extension-id') ?? (await packagedExtension(brand)).extensionId;
    console.log(JSON.stringify(await uninstallHost({ directory, brand, ...registration, extensionId }), null, 2));
  } else if (command === 'doctor') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const extensionId = option('extension-id') ?? (await packagedExtension(brand)).extensionId;
    const report = await diagnose({ directory, brand, ...registration, extensionId });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'ready') process.exitCode = 1;
  } else if (command === 'status') {
    await localState(directory);
    const peer = await connectBroker(directory);
    try { console.log(JSON.stringify({ connected: true, instances: await peer.call('browser.instances', {}) }, null, 2)); }
    finally { peer.close(); }
  } else {
    console.log('dsh-native-browser install --browser=chrome\ndsh-native-browser uninstall --browser=chrome\ndsh-native-browser service-status\ndsh-native-browser setup --browser=chrome\ndsh-native-browser extension-path --browser=chrome\ndsh-native-browser broker --allow-origin=https://example.com\ndsh-native-browser broker --access-mode=personal\ndsh-native-browser install-host --browser=chrome\ndsh-native-browser uninstall-host --browser=chrome\ndsh-native-browser doctor --browser=chrome\ndsh-native-browser status\nAll commands accept --runtime-dir=<private-directory>.\ninstall defaults to a personal-mode macOS LaunchAgent and opens Chrome plus the staged extension folder.\nHost commands default to the packaged stable extension ID; use --extension-id=<id> for an older or externally supplied build.\nHost install/uninstall/doctor also accept an explicit --manifest-dir=<registration-directory>.');
  }
}
