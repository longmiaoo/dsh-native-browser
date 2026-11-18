import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isComponentVersion } from '../../contracts/src/wire.js';
import { BrowserError, checkAbort } from '../../contracts/src/index.js';
import { defaultDirectory } from '../../broker/src/local-state.js';
import { diagnose } from '../../installer/src/doctor.js';
import { extensionIdFromManifestKey } from '../../installer/src/extension.js';
import { quickInstall } from '../../installer/src/quick-install.js';
import { openSetup } from '../../installer/src/open-setup.js';
import { snapshot } from '../../installer/src/files.js';
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from './approval-policy.js';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
// Shared by adapter instances in this Host; refreshing a UI must not restart an
// installation. No model tool exposes this controller.
let installation: { directory: string; promise: Promise<unknown> } | undefined;

/** Verify the Host's own runtime, including Desktop's documented Node mode.
 * Never run a browser-supplied executable or search the workspace/PATH. */
export async function verifySetupRuntime() {
  const electronRunAsNode = Boolean(process.versions.electron);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  delete env.NODE_OPTIONS;
  try {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close(); console.log(JSON.stringify({node:process.versions.node,electron:!!process.versions.electron}))"],
    { env, timeout: 5000, maxBuffer: 4096 });
    const result = JSON.parse(stdout.trim());
    const [major = 0, minor = 0] = String(result.node).split('.').map(Number);
    if (!(major > 22 || major === 22 && minor >= 19) || result.electron !== electronRunAsNode) throw new Error('runtime');
    return { nodePath: process.execPath, electronRunAsNode };
  } catch {
    throw new BrowserError('UNSUPPORTED_CAPABILITY', '当前 DSH 运行时不能启动浏览器服务。请更新 DSH（需要 Node 22.19+ 和 node:sqlite），或使用独立 Node 运行文档中的安装命令。');
  }
}

export function createSetupController(directory = defaultDirectory(), dependencies = {
  diagnose, quickInstall, openSetup, verifyRuntime: verifySetupRuntime, platform: process.platform,
}, approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE) {
  directory = path.resolve(directory);
  const extensionPath = path.join(directory, 'extension', 'chrome');
  const source = path.join(packageRoot, 'dist', 'extension', 'chrome');
  const metadata = async () => {
    const [manifestText, packageText] = await Promise.all([
      readFile(path.join(source, 'manifest.json'), 'utf8'),
      readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText);
    const { version } = JSON.parse(packageText);
    return { extensionId: extensionIdFromManifestKey(manifest.key), version, expectedExtensionVersion: manifest.version };
  };
  const stagedManifest = async () => {
    const file = await snapshot(path.join(extensionPath, 'manifest.json'), 16384);
    if (!file) return;
    const { key, version } = JSON.parse(file.bytes.toString('utf8'));
    if (isComponentVersion(version)) return { id: extensionIdFromManifestKey(key), version };
  };
  const status = async () => {
    const meta = await metadata();
    const staged = await stagedManifest().catch(() => undefined);
    const stagedVersion = staged?.id === meta.extensionId ? staged.version : undefined;
    const report = await dependencies.diagnose({ directory, brand: 'chrome', extensionId: meta.extensionId, timeoutMs: 750 });
    const brokerVersion = report.versions?.broker;
    const runningVersions = report.versions?.extensions ?? [];
    const modeMismatch = approvalMode === 'personal' && report.connection.accessMode === 'restricted';
    const nextStep = stagedVersion !== meta.expectedExtensionVersion || brokerVersion !== meta.version ||
      report.status === 'failed' || modeMismatch ? 'sync'
      : !report.connection.matchingBrowserCount ? 'connect'
        : runningVersions.length !== report.connection.matchingBrowserCount ||
          runningVersions.some(version => version !== meta.expectedExtensionVersion) ? 'reload'
          : 'ready';
    return { ...meta, extensionPath, extensionStaged: Boolean(stagedVersion), nextStep,
      versions: { broker: brokerVersion, staged: stagedVersion, running: runningVersions },
      platform: dependencies.platform, supported: dependencies.platform === 'darwin', installing: Boolean(installation),
      policy: { approvalMode, browserAccessMode: report.connection.accessMode ?? 'unknown' }, report };
  };
  return async (endpoint: string, raw: unknown, signal: AbortSignal) => {
    checkAbort(signal);
    if (!['setup.status', 'setup.install', 'setup.open'].includes(endpoint)) {
      return { ok: false, error: { code: 'gateway/not-found', message: 'Unknown setup endpoint', details: {} } };
    }
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : null;
    const valid = keys && (endpoint === 'setup.install'
      ? keys.length === 1 && keys[0] === 'confirmed' && (raw as { confirmed?: unknown }).confirmed === true
      : keys.length === 0);
    if (!valid) return { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid setup request', details: {} } };
    try {
      if (endpoint === 'setup.status') return { ok: true, value: await status() };
      if (dependencies.platform !== 'darwin') throw new BrowserError('UNSUPPORTED_CAPABILITY', '当前自动配置仅支持运行 DSH 的 macOS 主机。');
      if (endpoint === 'setup.open') {
        if (installation) throw new BrowserError('INSTALLATION_BUSY', '配置正在进行，请稍后重试。');
        const meta = await metadata();
        if ((await stagedManifest())?.id !== meta.extensionId) throw new BrowserError('INSTALLATION_FAILED', '请先完成浏览器配置。');
        return { ok: true, value: await dependencies.openSetup({ brand: 'chrome', extensionPath }) };
      }
      if (installation && installation.directory !== directory) {
        throw new BrowserError('INSTALLATION_BUSY', '另一个运行目录正在配置，请完成后再重试。');
      }
      if (!installation) {
        const promise = (async () => {
          const meta = await metadata();
          const runtime = await dependencies.verifyRuntime();
          checkAbort(signal); // No writes before verification and cancellation check.
          // Once started, finish the bounded installer even if the UI closes.
          // No DSH approval settings or tab grants are changed here.
          return dependencies.quickInstall({ browser: 'chrome', directory, extensionSource: source,
            extensionId: meta.extensionId, cliPath: path.join(packageRoot, 'bin', 'dsh-native-browser.mjs'),
            ...runtime, accessMode: 'personal', open: true });
        })();
        const current = installation = { directory, promise };
        void promise.finally(() => { if (installation === current) installation = undefined; }).catch(() => {});
      }
      const result = await installation.promise;
      return { ok: true, value: { result, status: await status() } };
    } catch (error) {
      return { ok: false, error: { code: error instanceof BrowserError ? error.code : 'INSTALLATION_FAILED',
        message: error instanceof BrowserError ? error.message : '未能完成配置或检查。请先重试连接检查；若仍失败，请查看安装文档排查。', details: {} } };
    }
  };
}
