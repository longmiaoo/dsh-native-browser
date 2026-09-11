import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';
import { HOST_NAME, manifestDirectory, nativeDirectory, ownedManifest, withInstallationLocks } from './install.js';
import { commitFiles, removeInstallationFile, snapshot } from './files.js';

export interface UninstallResult {
  browser: 'chrome' | 'edge';
  status: 'removed' | 'not-registered';
  manifest: string;
  manifestRemoved: boolean;
  remainingOrigins: number;
  backup?: string;
  /** This command changes future host registration, not existing process/lease authority. */
  runningConnectionsStopped: false;
  runtimeStatePreserved: true;
}

/** Remove one explicit extension origin from one exact browser registration.
 * Runtime allowlist/token/journal/launcher and other browsers are never deletion targets. */
export async function uninstallHost(options: { directory: string; extensionId: string; brand: 'chrome' | 'edge'; manifestDir?: string }): Promise<UninstallResult> {
  if (options.brand !== 'chrome' && options.brand !== 'edge') throw new BrowserError('INVALID_REQUEST', 'Browser must be chrome or edge');
  if (!/^[a-p]{32}$/.test(options.extensionId)) throw new BrowserError('INVALID_REQUEST', 'Invalid Chromium extension ID');
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Host unregistration supports macOS/Linux only');
  const directory = path.resolve(options.directory), manifestDir = path.resolve(options.manifestDir ?? manifestDirectory(options.brand));
  const manifest = path.join(manifestDir, `${HOST_NAME}.json`), caller = `chrome-extension://${options.extensionId}/`;
  const base = { browser: options.brand, manifest, runningConnectionsStopped: false, runtimeStatePreserved: true } as const;
  const absent = (remainingOrigins = 0): UninstallResult => ({ ...base, status: 'not-registered', manifestRemoved: false, remainingOrigins });
  // Uninstalling an absent registration must not bootstrap a runtime, token or browser directory.
  if (!await nativeDirectory(manifestDir) || !await snapshot(manifest)) return absent();
  let lockRuntime = false;
  try {
    const s = await lstat(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077)) {
      throw new BrowserError('POLICY_DENIED', 'Existing runtime directory is unsafe; no registration changed');
    }
    lockRuntime = true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return withInstallationLocks(directory, manifestDir, async () => {
    const before = await snapshot(manifest); if (!before) return absent();
    const current = ownedManifest(before, directory);
    if (!current.allowed_origins.includes(caller)) return absent(current.allowed_origins.length);
    const remaining = current.allowed_origins.filter(origin => origin !== caller);
    const backup = path.join(manifestDir, `.dsh-host-${randomUUID()}.disabled`);
    // Backup is durable before changing the registration and is retained on any
    // later failure. It is not part of a rollback that could erase the recovery copy.
    await commitFiles([{ file: backup, bytes: before.bytes, mode: 0o600 }]);
    try {
      if (remaining.length) await commitFiles([{ file: manifest, before,
        bytes: Buffer.from(JSON.stringify({ ...current, allowed_origins: remaining }, null, 2) + '\n'), mode: 0o600 }]);
      else await removeInstallationFile(manifest, before);
    } catch {
      throw new BrowserError('INSTALLATION_FAILED', `Host unregistration could not be confirmed; inspect the registration. Original manifest backup retained at ${backup}`);
    }
    return { ...base, status: 'removed', manifestRemoved: remaining.length === 0, remainingOrigins: remaining.length, backup };
  }, lockRuntime);
}
