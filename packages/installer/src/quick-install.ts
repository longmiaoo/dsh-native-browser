import path from 'node:path';
import { localState } from '../../broker/src/local-state.js';
import { installHost } from './install.js';
import { stageExtension } from './stage.js';
import { installBrokerService, type BrokerServiceResult } from './service.js';
import { openSetup, type SetupOpenCommand } from './open-setup.js';

export interface QuickInstallOptions {
  browser: 'chrome' | 'edge';
  extensionSource: string;
  extensionId: string;
  directory: string;
  cliPath: string;
  nodePath?: string;
  manifestDir?: string;
  accessMode?: 'restricted' | 'personal';
  allowedOrigins?: string[];
  service?: boolean;
  open?: boolean;
  plistDirectory?: string;
  launchctl?: (args: string[]) => Promise<void>;
  openRunner?: (command: SetupOpenCommand) => Promise<void>;
}

export async function quickInstall(options: QuickInstallOptions) {
  const directory = path.resolve(options.directory);
  const accessMode = options.accessMode ?? 'personal';
  const allowedOrigins = options.allowedOrigins ?? [];
  await localState(directory, true);
  const extension = await stageExtension(options.extensionSource, path.join(directory, 'extension', options.browser));
  const host = await installHost({ directory, brand: options.browser, extensionId: options.extensionId,
    ...(options.manifestDir ? { manifestDir: options.manifestDir } : {}), cliPath: options.cliPath,
    ...(options.nodePath ? { nodePath: options.nodePath } : {}) });
  let service: BrokerServiceResult | undefined;
  if (options.service !== false) {
    service = await installBrokerService({ directory, cliPath: options.cliPath, accessMode, allowedOrigins,
      ...(options.nodePath ? { nodePath: options.nodePath } : {}),
      ...(options.plistDirectory ? { plistDirectory: options.plistDirectory } : {}),
      ...(options.launchctl ? { launchctl: options.launchctl } : {}) });
  }
  let opened: { openedBrowser: boolean; revealedExtension: boolean } | undefined;
  let openError: string | undefined;
  if (options.open !== false) {
    try {
      opened = await openSetup({ brand: options.browser, extensionPath: extension.path,
        ...(options.openRunner ? { runner: options.openRunner } : {}) });
    } catch (error) {
      // The registration and service are valid even if the desktop opener is
      // unavailable (SSH/headless). Keep the exact staged path in the result.
      openError = error instanceof Error ? error.message : String(error);
    }
  }
  return { browser: options.browser, accessMode, extensionId: options.extensionId,
    extensionPath: extension.path, stagedFiles: extension.files, stagedBytes: extension.bytes,
    host, service, opened, ...(openError ? { openError } : {}), manualActionRequired: 'load-unpacked' as const };
}
