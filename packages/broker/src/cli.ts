import { fileURLToPath } from 'node:url';
import { defaultDirectory, localState } from './local-state.js';
import { startBroker } from './server.js';
import { connectBroker } from './client.js';
import { runNativeHost } from '../../transport-native/src/host.js';
import { installHost } from '../../installer/src/install.js';
import { uninstallHost } from '../../installer/src/uninstall.js';
import { diagnose } from '../../installer/src/doctor.js';

export async function main(args: string[]): Promise<void> {
  const command = args[0];
  const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
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
  } else if (command === 'install-host') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const result = await installHost({ directory, brand, ...registration, extensionId: option('extension-id') ?? '',
      cliPath: fileURLToPath(new URL('../../../../bin/dsh-native-browser.mjs', import.meta.url)) });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'uninstall-host') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    console.log(JSON.stringify(await uninstallHost({ directory, brand, ...registration, extensionId: option('extension-id') ?? '' }), null, 2));
  } else if (command === 'doctor') {
    const brand = option('browser') ?? 'chrome';
    if (brand !== 'chrome' && brand !== 'edge') throw new Error('Browser must be chrome or edge');
    const extensionId = option('extension-id');
    const report = await diagnose({ directory, brand, ...registration, ...(extensionId === undefined ? {} : { extensionId }) });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'ready') process.exitCode = 1;
  } else if (command === 'status') {
    await localState(directory);
    const peer = await connectBroker(directory);
    try { console.log(JSON.stringify({ connected: true, instances: await peer.call('browser.instances', {}) }, null, 2)); }
    finally { peer.close(); }
  } else {
    console.log('dsh-native-browser extension-path --browser=chrome\ndsh-native-browser broker --allow-origin=https://example.com\ndsh-native-browser broker --access-mode=personal\ndsh-native-browser install-host --browser=chrome --extension-id=<id>\ndsh-native-browser uninstall-host --browser=chrome --extension-id=<id>\ndsh-native-browser doctor --browser=chrome --extension-id=<id>\ndsh-native-browser status\nAll commands accept --runtime-dir=<private-directory>.\nHost install/uninstall/doctor also accept an explicit --manifest-dir=<registration-directory>.');
  }
}
