import { constants } from 'node:fs';
import { access, lstat, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { BrowserError } from '../../contracts/src/index.js';
import { localState } from '../../broker/src/local-state.js';
import { acquireBrokerOwnership, type BrokerOwnership } from '../../broker/src/ownership.js';
import { launcherPaths, launcherText } from './launcher.js';
import { commitFiles, snapshot, type FileSnapshot } from './files.js';

export const HOST_NAME = 'com.longmiaoo.dsh_native_browser';
export function manifestDirectory(brand: 'chrome' | 'edge', platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support',
    ...(brand === 'chrome' ? ['Google', 'Chrome'] : ['Microsoft Edge']), 'NativeMessagingHosts');
  if (platform === 'linux') return path.join(home, '.config', brand === 'chrome' ? 'google-chrome' : 'microsoft-edge', 'NativeMessagingHosts');
  throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Installer supports macOS/Linux paths only; Windows ACL/registry is pending');
}

export async function installHost(options: { directory: string; extensionId: string; brand: 'chrome' | 'edge';
  cliPath: string; manifestDir?: string; nodePath?: string }) {
  if (options.brand !== 'chrome' && options.brand !== 'edge') throw new BrowserError('INVALID_REQUEST', 'Browser must be chrome or edge');
  if (!/^[a-p]{32}$/.test(options.extensionId)) throw new BrowserError('INVALID_REQUEST', 'Invalid Chromium extension ID');
  const directory = path.resolve(options.directory), cli = path.resolve(options.cliPath), node = path.resolve(options.nodePath ?? process.execPath);
  const manifestDir = path.resolve(options.manifestDir ?? manifestDirectory(options.brand));
  if (!(await stat(node)).isFile() || !(await stat(cli)).isFile()) throw new BrowserError('INVALID_REQUEST', 'Node and CLI must be regular files');
  await access(node, constants.X_OK); await access(cli, constants.R_OK);
  await localState(directory, true);
  await mkdir(manifestDir, { recursive: true });
  await nativeDirectory(manifestDir);
  return withInstallationLocks(directory, manifestDir, () =>
    installLocked({ directory, cli, node, manifestDir, extensionId: options.extensionId, brand: options.brand }));
}

export async function nativeDirectory(directory: string): Promise<boolean> {
  let s;
  try { s = await lstat(directory); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o022)) {
    throw new BrowserError('POLICY_DENIED', 'Native Messaging directory must be user-owned and not writable by other users');
  }
  return true;
}

export async function withInstallationLocks<T>(directory: string, manifestDir: string, work: () => Promise<T>, lockRuntime = true): Promise<T> {
  // Runtime lock prevents lost combined-origin updates across brands; manifest lock
  // prevents separate runtime directories racing to own the same browser registration.
  // Dedicated directories reuse the proven OS-released SQLite lock, never the live
  // Broker ownership inode and never its socket-recovery operation.
  const locks: BrokerOwnership[] = [];
  try {
    const locations = [path.join(manifestDir, '.dsh-host-install-lock'), ...(lockRuntime ? [path.join(directory, '.host-install-lock')] : [])];
    for (const location of [...new Set(locations)].sort()) {
      try { locks.push(await acquireBrokerOwnership(location)); }
      catch (error) {
        if (error instanceof BrowserError && error.code === 'BROKER_BUSY') throw new BrowserError('INSTALLATION_BUSY', 'Another installation owns this runtime or browser registration');
        throw error;
      }
    }
    return await work();
  } finally { for (const lock of locks.reverse()) lock.close(); }
}

const invalid = () => new BrowserError('POLICY_DENIED', 'Existing host files are malformed or belong to another installation; nothing was overwritten');
function object(value: FileSnapshot): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Do not expose untrusted file contents or parser errors. */ }
  throw invalid();
}
function origins(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 || new Set(value).size !== value.length
    || value.some(v => typeof v !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(v))) throw invalid();
  return value;
}
export function ownedManifest(value: FileSnapshot, directory: string): Record<string, unknown> & { allowed_origins: string[] } {
  const m = object(value);
  if (m.name !== HOST_NAME || m.type !== 'stdio' || m.path !== path.join(directory, 'native-host')
    || m.description !== undefined && typeof m.description !== 'string'
    || Object.keys(m).some(key => !['name', 'description', 'path', 'type', 'allowed_origins'].includes(key))) throw invalid();
  return { ...m, allowed_origins: origins(m.allowed_origins) };
}
async function installLocked(options: { directory: string; cli: string; node: string; manifestDir: string; extensionId: string; brand: 'chrome' | 'edge' }) {
  const { directory, manifestDir } = options;
  const callerOrigin = `chrome-extension://${options.extensionId}/`;
  const configPath = path.join(directory, 'native-host.json'), launcher = path.join(directory, 'native-host');
  const manifest = path.join(manifestDir, `${HOST_NAME}.json`);
  // All three target files are read and validated before publishing any change.
  const [oldConfig, oldLauncher, oldManifest] = await Promise.all([snapshot(configPath), snapshot(launcher), snapshot(manifest)]);
  const allowedOrigins = new Set<string>(), browserOrigins = new Set<string>();
  if (oldConfig) {
    const config = object(oldConfig);
    if (Object.keys(config).some(key => key !== 'allowedOrigins')) throw invalid();
    for (const origin of origins(config.allowedOrigins)) allowedOrigins.add(origin);
  }
  if (oldLauncher) {
    const parsed = launcherPaths(oldLauncher.bytes.toString('utf8'));
    if (!parsed || ![parsed.node, parsed.cli, parsed.directory].every(path.isAbsolute) || path.resolve(parsed.directory) !== directory) throw invalid();
  }
  if (oldManifest) {
    for (const origin of ownedManifest(oldManifest, directory).allowed_origins) { browserOrigins.add(origin); allowedOrigins.add(origin); }
  }
  allowedOrigins.add(callerOrigin);
  browserOrigins.add(callerOrigin);
  if (allowedOrigins.size > 64 || browserOrigins.size > 64) throw new BrowserError('INVALID_REQUEST', 'Native host origin limit reached');
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await commitFiles([
    { file: launcher, before: oldLauncher, bytes: Buffer.from(launcherText(options.node, options.cli, directory)), mode: 0o700 },
    { file: configPath, before: oldConfig, bytes: json({ allowedOrigins: [...allowedOrigins].sort() }), mode: 0o600 },
    { file: manifest, before: oldManifest, bytes: json({ name: HOST_NAME, description: 'DSH user-authorized browser bridge',
      path: launcher, type: 'stdio', allowed_origins: [...browserOrigins].sort() }), mode: 0o600 },
  ]);
  return { manifest, launcher, browser: options.brand };
}
