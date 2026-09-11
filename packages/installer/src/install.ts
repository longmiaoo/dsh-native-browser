import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { BrowserError } from '../../contracts/src/index.js';
import { localState } from '../../broker/src/local-state.js';
import { launcherText } from './launcher.js';

export const HOST_NAME = 'com.longmiaoo.dsh_native_browser';
export function manifestDirectory(brand: 'chrome' | 'edge', platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support',
    ...(brand === 'chrome' ? ['Google', 'Chrome'] : ['Microsoft Edge']), 'NativeMessagingHosts');
  if (platform === 'linux') return path.join(home, '.config', brand === 'chrome' ? 'google-chrome' : 'microsoft-edge', 'NativeMessagingHosts');
  throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Installer supports macOS/Linux paths only; Windows ACL/registry is pending');
}

export async function installHost(options: { directory: string; extensionId: string; brand: 'chrome' | 'edge';
  cliPath: string; manifestDir?: string; nodePath?: string }) {
  if (!/^[a-p]{32}$/.test(options.extensionId)) throw new BrowserError('INVALID_REQUEST', 'Invalid Chromium extension ID');
  await localState(options.directory, true);
  const manifestDir = options.manifestDir ?? manifestDirectory(options.brand);
  const callerOrigin = `chrome-extension://${options.extensionId}/`;
  const configPath = path.join(options.directory, 'native-host.json');
  const allowedOrigins = new Set<string>();
  try {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BrowserError('POLICY_DENIED', 'Unexpected native host config file');
    const existing = JSON.parse(await readFile(configPath, 'utf8'));
    for (const origin of existing.allowedOrigins ?? []) {
      if (typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) allowedOrigins.add(origin);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  allowedOrigins.add(callerOrigin);
  const launcher = path.join(options.directory, 'native-host');
  await writeFile(launcher, launcherText(options.nodePath ?? process.execPath, path.resolve(options.cliPath), options.directory), { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ allowedOrigins: [...allowedOrigins] }, null, 2) + '\n', { mode: 0o600 });
  await mkdir(manifestDir, { recursive: true });
  const manifest = path.join(manifestDir, `${HOST_NAME}.json`);
  await writeFile(manifest, JSON.stringify({ name: HOST_NAME, description: 'DSH user-authorized browser bridge',
    path: launcher, type: 'stdio', allowed_origins: [...allowedOrigins] }, null, 2) + '\n', { mode: 0o600 });
  return { manifest, launcher, browser: options.brand };
}
