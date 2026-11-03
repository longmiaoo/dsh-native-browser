import { execFile } from 'node:child_process';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserError } from '../../contracts/src/index.js';
import { commitFiles, snapshot } from './files.js';

const execFileAsync = promisify(execFile);
export const SERVICE_LABEL = 'com.longmiaoo.dsh-native-browser.broker';

export interface BrokerServiceOptions {
  directory: string;
  cliPath: string;
  nodePath?: string;
  electronRunAsNode?: boolean;
  accessMode: 'restricted' | 'personal';
  allowedOrigins?: string[];
  plistDirectory?: string;
  launchctl?: (args: string[]) => Promise<void>;
}

export interface BrokerServiceResult {
  label: string;
  plist: string;
  scope: string;
  loaded: boolean;
  stdoutLog: string;
  stderrLog: string;
}

export function servicePlistDirectory(platform = process.platform, home = homedir()): string {
  if (platform !== 'darwin') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Automatic Broker service is currently implemented for macOS only');
  return path.join(home, 'Library', 'LaunchAgents');
}

const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const validText = (value: string): boolean => value.length > 0 && value.length <= 8192 && !/[\0\r\n]/.test(value);

export function brokerServicePlist(options: { label: string; nodePath: string; cliPath: string; directory: string; electronRunAsNode?: boolean;
  accessMode: 'restricted' | 'personal'; allowedOrigins: string[]; stdoutLog: string; stderrLog: string }): string {
  const values = [options.label, options.nodePath, options.cliPath, options.directory, options.stdoutLog, options.stderrLog];
  if (values.some(value => !validText(value))) throw new BrowserError('INVALID_REQUEST', 'Service paths must be non-empty single-line strings');
  if (options.accessMode === 'restricted' && options.allowedOrigins.length === 0) {
    throw new BrowserError('INVALID_REQUEST', 'Restricted Broker service requires at least one --allow-origin');
  }
  const args = [options.nodePath, options.cliPath, 'broker', `--runtime-dir=${options.directory}`,
    `--access-mode=${options.accessMode}`, ...options.allowedOrigins.map(origin => `--allow-origin=${origin}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${xml(options.label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map(value => `    <string>${xml(value)}</string>`).join('\n')}\n  </array>\n${options.electronRunAsNode ? '  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>\n' : ''}  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>Umask</key><integer>63</integer>\n  <key>StandardOutPath</key><string>${xml(options.stdoutLog)}</string>\n  <key>StandardErrorPath</key><string>${xml(options.stderrLog)}</string>\n</dict>\n</plist>\n`;
}

async function launchctl(args: string[]): Promise<void> { await execFileAsync('/bin/launchctl', args, { timeout: 10000, maxBuffer: 65536 }); }

async function waitForServiceRemoval(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (await serviceIsLoaded()) {
    if (Date.now() >= deadline) throw new BrowserError('INSTALLATION_FAILED', 'Previous Broker service is still stopping. Check service-status and rerun install after it stops.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** One per-user service owns one runtime. A custom install must not replace or
 * stop the Broker serving another runtime/profile. */
export async function checkServiceOwner(directory: string, plistDirectory?: string): Promise<void> {
  const plist = path.join(path.resolve(plistDirectory ?? servicePlistDirectory()), `${SERVICE_LABEL}.plist`);
  const before = await snapshot(plist, 32768);
  if (before && !before.bytes.toString('utf8').includes(`<string>--runtime-dir=${xml(path.resolve(directory))}</string>`)) {
    throw new BrowserError('POLICY_DENIED', 'The installed Broker service belongs to a different runtime. Uninstall that service with its original --runtime-dir before changing runtimes.');
  }
}

/** Install or refresh one user LaunchAgent. Existing file content is validated by
 * the shared bounded atomic writer; no root privilege or system-wide policy is used. */
export async function installBrokerService(options: BrokerServiceOptions): Promise<BrokerServiceResult> {
  if (process.platform !== 'darwin') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Automatic Broker service is currently implemented for macOS only');
  await checkServiceOwner(options.directory, options.plistDirectory);
  const directory = path.resolve(options.directory);
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  const cliPath = path.resolve(options.cliPath);
  const plistDirectory = path.resolve(options.plistDirectory ?? servicePlistDirectory());
  await mkdir(plistDirectory, { recursive: true, mode: 0o700 });
  const folder = await lstat(plistDirectory);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid!() || (folder.mode & 0o022)) {
    throw new BrowserError('POLICY_DENIED', 'LaunchAgents directory must be owned by the current user and not writable by other users');
  }
  const stdoutLog = path.join(directory, 'broker.stdout.log');
  const stderrLog = path.join(directory, 'broker.stderr.log');
  const plist = path.join(plistDirectory, `${SERVICE_LABEL}.plist`);
  const content = Buffer.from(brokerServicePlist({ label: SERVICE_LABEL, nodePath, cliPath, directory,
    electronRunAsNode: options.electronRunAsNode ?? false, accessMode: options.accessMode, allowedOrigins: options.allowedOrigins ?? [], stdoutLog, stderrLog }));
  const before = await snapshot(plist, 32768);
  await commitFiles([{ file: plist, before, bytes: content, mode: 0o600 }]);
  const scope = `gui/${userInfo().uid}`;
  const run = options.launchctl ?? launchctl;
  // Refreshing an existing generation is intentional: bootout stops only this
  // user's label and never signals an unrelated process. Not-loaded is harmless.
  await run(['bootout', `${scope}/${SERVICE_LABEL}`]).catch(() => {});
  // bootout can return before launchd has removed the old job. Re-registering
  // immediately intermittently fails with bootstrap error 5 during upgrades.
  if (!options.launchctl) await waitForServiceRemoval();
  await run(['bootstrap', scope, plist]);
  return { label: SERVICE_LABEL, plist, scope, loaded: true, stdoutLog, stderrLog };
}

export async function uninstallBrokerService(options: { directory: string; plistDirectory?: string; launchctl?: (args: string[]) => Promise<void> }): Promise<{ removed: boolean; plist: string }> {
  if (process.platform !== 'darwin') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Automatic Broker service is currently implemented for macOS only');
  await checkServiceOwner(options.directory, options.plistDirectory);
  const plist = path.join(path.resolve(options.plistDirectory ?? servicePlistDirectory()), `${SERVICE_LABEL}.plist`);
  if (!await snapshot(plist, 32768)) return { removed: false, plist };
  const run = options.launchctl ?? launchctl;
  await run(['bootout', `gui/${userInfo().uid}/${SERVICE_LABEL}`]).catch(() => {});
  if (!options.launchctl) await waitForServiceRemoval();
  try {
    const value = await lstat(plist);
    if (!value.isFile() || value.uid !== process.getuid!() || (value.mode & 0o077)) {
      throw new BrowserError('POLICY_DENIED', 'Refusing to remove an unsafe LaunchAgent file');
    }
    await unlink(plist);
    return { removed: true, plist };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false, plist };
    throw error;
  }
}

export async function serviceIsLoaded(launchctlRunner: (args: string[]) => Promise<void> = launchctl): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await launchctlRunner(['print', `gui/${userInfo().uid}/${SERVICE_LABEL}`]);
    return true;
  } catch { return false; }
}

