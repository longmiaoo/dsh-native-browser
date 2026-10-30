import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';
import { localState } from '../../broker/src/local-state.js';
import { installHost } from './install.js';
import { stageExtension } from './stage.js';
import { checkServiceOwner, installBrokerService, serviceIsLoaded, type BrokerServiceResult } from './service.js';
import { diagnose } from './doctor.js';
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
  serviceReady?: () => Promise<void>;
}

export async function quickInstall(options: QuickInstallOptions) {
  // Fail before staging files or registering a host on unsupported platforms.
  if (options.service !== false && process.platform !== 'darwin') {
    throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Automatic installation supports macOS. Use --no-service --no-open only for an explicitly managed Broker.');
  }
  const directory = path.resolve(options.directory);
  const accessMode = options.accessMode ?? 'personal';
  const allowedOrigins = options.allowedOrigins ?? [];
  const diagnostic = () => diagnose({ directory, brand: options.browser, extensionId: options.extensionId,
    ...(options.manifestDir ? { manifestDir: options.manifestDir } : {}), timeoutMs: 250 });
  if (options.service !== false) {
    await checkServiceOwner(directory, options.plistDirectory);
    if (!options.launchctl && !await serviceIsLoaded() && (await diagnostic()).connection.connected) {
      throw new BrowserError('BROKER_BUSY', 'A manually started Broker already owns this runtime. Stop that Broker with Ctrl+C in its terminal, then run install again.');
    }
  }
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
    if (options.serviceReady) await options.serviceReady();
    else {
      const deadline = Date.now() + 5000;
      while (!(await diagnostic()).connection.connected) {
        if (Date.now() >= deadline) throw new BrowserError('INSTALLATION_FAILED', 'Broker service did not become ready. Run doctor and inspect broker.stderr.log in the runtime directory, then rerun install.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
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
