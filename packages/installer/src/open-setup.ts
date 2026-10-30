import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserError } from '../../contracts/src/index.js';

const execFileAsync = promisify(execFile);

export interface SetupOpenCommand { file: string; args: string[] }

/** Only fixed application names and already validated absolute paths are passed
 * to platform openers. No shell interpolation or user-authored URL is used. */
export function setupOpenCommands(options: { platform?: NodeJS.Platform; brand: 'chrome' | 'edge'; extensionPath: string }): SetupOpenCommand[] {
  const platform = options.platform ?? process.platform;
  const extensionPath = path.resolve(options.extensionPath);
  if (platform === 'darwin') {
    const application = options.brand === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    const scheme = options.brand === 'chrome' ? 'chrome' : 'edge';
    return [
      { file: '/usr/bin/open', args: ['-a', application, `${scheme}://extensions/`] },
      { file: '/usr/bin/open', args: ['-R', extensionPath] },
    ];
  }
  throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Automatic setup opening is currently implemented for macOS only');
}

export async function openSetup(options: { platform?: NodeJS.Platform; brand: 'chrome' | 'edge'; extensionPath: string;
  runner?: (command: SetupOpenCommand) => Promise<void> }): Promise<{ openedBrowser: boolean; revealedExtension: boolean }> {
  const commands = setupOpenCommands(options);
  const runner = options.runner ?? (async command => { await execFileAsync(command.file, command.args); });
  await runner(commands[0]!);
  await runner(commands[1]!);
  return { openedBrowser: true, revealedExtension: true };
}
