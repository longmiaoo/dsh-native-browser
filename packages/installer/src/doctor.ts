import { constants } from 'node:fs';
import { access, lstat, open, stat } from 'node:fs/promises';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';
import { RpcPeer } from '../../transport-native/src/rpc.js';
import { HOST_NAME, manifestDirectory } from './install.js';
import { launcherPaths } from './launcher.js';
import { acceptWelcome, clientRequirements, wireVersion } from '../../contracts/src/wire.js';

type Check = { id: string; status: 'ok' | 'warning' | 'error' | 'skipped'; code: string; message: string; hint?: string };
export interface DoctorReport {
  schemaVersion: 1;
  browser: 'chrome' | 'edge';
  status: 'ready' | 'attention' | 'failed';
  checks: Check[];
  connection: { connected: boolean; instanceCount: number; matchingBrowserCount: number };
}
class Finding extends Error { constructor(readonly code: string) { super(code); } }
const originPattern = /^chrome-extension:\/\/[a-p]{32}\/$/;
function origins(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64 ||
    raw.some(v => typeof v !== 'string' || !originPattern.test(v)) || new Set(raw).size !== raw.length) {
    throw new Finding('INVALID_ORIGINS');
  }
  return raw;
}
function object(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Do not include JSON contents or parser messages in diagnostics. */ }
  throw new Finding('INVALID_JSON');
}
function code(error: unknown): string {
  if (error instanceof Finding) return error.code;
  if (error instanceof BrowserError && ['POLICY_DENIED', 'PROTOCOL_MISMATCH', 'CONNECTION_LOST'].includes(error.code)) return error.code;
  const raw = (error as NodeJS.ErrnoException)?.code;
  return raw === 'ENOENT' ? 'MISSING' : raw === 'EACCES' || raw === 'EPERM' ? 'UNREADABLE' :
    raw === 'ECONNREFUSED' ? 'NOT_LISTENING' : 'CHECK_FAILED';
}

/** Bounded, no-follow, regular/single-link reads; never read/open the SQLite ownership inode. */
async function privateText(file: string, limit: number, executable = false): Promise<string> {
  const before = await lstat(file, { bigint: true });
  const safe = (s: typeof before) => s.isFile() && s.uid === BigInt(process.getuid!()) && s.nlink === 1n &&
    (s.mode & 0o077n) === 0n && (!executable || (s.mode & 0o100n) !== 0n) && s.size <= BigInt(limit);
  if (!safe(before)) throw new Finding('UNSAFE_FILE');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await fd.stat({ bigint: true });
    if (!safe(actual) || actual.dev !== before.dev || actual.ino !== before.ino) throw new Finding('UNSAFE_FILE');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await fd.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (length > limit || after.size !== actual.size || after.mtimeNs !== actual.mtimeNs ||
      named.dev !== actual.dev || named.ino !== actual.ino || !safe(named)) throw new Finding('UNSAFE_FILE');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await fd.close(); }
}

/** Read-only local preflight. A client hello/list is used, never tab reads, grant/input, repair or launch. */
export async function diagnose(options: { directory: string; brand: 'chrome' | 'edge'; extensionId?: string;
  manifestDir?: string; timeoutMs?: number }): Promise<DoctorReport> {
  if (options.brand !== 'chrome' && options.brand !== 'edge') throw new BrowserError('INVALID_REQUEST', 'Browser must be chrome or edge');
  if (options.extensionId !== undefined && !/^[a-p]{32}$/.test(options.extensionId)) throw new BrowserError('INVALID_REQUEST', 'Invalid Chromium extension ID');
  const timeout = options.timeoutMs ?? 1500;
  if (!Number.isInteger(timeout) || timeout < 25 || timeout > 5000) throw new BrowserError('INVALID_REQUEST', 'Diagnostic timeout must be 25–5000 ms');
  const report: DoctorReport = { schemaVersion: 1, browser: options.brand, status: 'ready', checks: [],
    connection: { connected: false, instanceCount: 0, matchingBrowserCount: 0 } };
  const add = (id: string, status: Check['status'], code: string, message: string, hint?: string) => {
    report.checks.push({ id, status, code, message, ...(hint ? { hint } : {}) });
  };
  const finish = () => {
    report.status = report.checks.some(c => c.status === 'error') ? 'failed' : report.checks.some(c => c.status === 'warning') ? 'attention' : 'ready';
    return report;
  };
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    add('platform', 'error', 'UNSUPPORTED_PLATFORM', '此诊断仅支持 macOS/Linux；Windows IPC 与注册表尚未实现。');
    return finish();
  }
  const directory = path.resolve(options.directory);
  const check = async <T>(id: string, run: () => Promise<T>, message: string, hint: string): Promise<T | undefined> => {
    try { const value = await run(); add(id, 'ok', 'OK', message); return value; }
    catch (error) { add(id, 'error', code(error), `${message}：检查未通过。`, hint); return undefined; }
  };
  const runtimeSafe = await check('runtime-directory', async () => {
    const s = await lstat(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077)) throw new Finding('UNSAFE_DIRECTORY');
    if (Buffer.byteLength(path.join(directory, 'broker.sock')) > 100) throw new Finding('SOCKET_PATH_TOO_LONG');
    return true;
  }, '运行目录私有且可访问', '核对 --runtime-dir；首次使用先按文档显式安装。权限异常时先核对所有者，不要删除状态文件。');
  let token: string | undefined;
  let installedOrigins: string[] | undefined;
  if (runtimeSafe) {
    token = await check('auth-token', async () => {
      const value = (await privateText(path.join(directory, 'auth-token'), 128)).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Finding('INVALID_TOKEN');
      return value;
    }, '本地认证令牌有效', '令牌缺失或损坏时先停止相关进程并核对安装；不要分享令牌或盲目重建恢复状态。');
    installedOrigins = await check('host-config', async () => origins(object(await privateText(path.join(directory, 'native-host.json'), 16384)).allowedOrigins),
      '宿主扩展白名单有效', '使用正确扩展 ID 显式执行 install-host；Chrome 与 Edge 的 ID 可能不同。');
    await check('launcher', async () => {
      const parsed = launcherPaths(await privateText(path.join(directory, 'native-host'), 16384, true));
      if (!parsed || ![parsed.node, parsed.cli, parsed.directory].every(path.isAbsolute) || path.resolve(parsed.directory) !== directory) throw new Finding('LAUNCHER_MISMATCH');
      // Node may legitimately be a symlink managed by nvm. Follow it only for metadata/access, never execute it.
      if (!(await stat(parsed.node)).isFile() || !(await stat(parsed.cli)).isFile()) throw new Finding('LAUNCHER_TARGET_MISSING');
      await access(parsed.node, constants.X_OK); await access(parsed.cli, constants.R_OK);
      return true;
    }, '固定宿主启动器及 Node/CLI 路径有效', '检查开发仓库是否被移动、Node 是否被升级或移除；核对路径后重新安装宿主。诊断不会执行启动器。');
  } else {
    for (const id of ['auth-token', 'host-config', 'launcher']) add(id, 'skipped', 'DEPENDENCY_FAILED', '运行目录未通过，未读取内部文件。');
  }
  await check('browser-manifest', async () => {
    const file = path.join(options.manifestDir ?? manifestDirectory(options.brand), `${HOST_NAME}.json`);
    const m = object(await privateText(file, 16384));
    if (m.name !== HOST_NAME || m.type !== 'stdio' || m.path !== path.join(directory, 'native-host')) throw new Finding('MANIFEST_MISMATCH');
    const allowed = origins(m.allowed_origins);
    if (!installedOrigins) throw new Finding('CONFIG_UNAVAILABLE');
    // A per-brand manifest may authorize a subset of the combined host whitelist.
    if (allowed.some(origin => !installedOrigins.includes(origin))) throw new Finding('ORIGIN_MISMATCH');
    if (options.extensionId && !allowed.includes(`chrome-extension://${options.extensionId}/`)) throw new Finding('EXTENSION_ID_MISMATCH');
    return true;
  }, '所选浏览器的宿主注册匹配', '核对 --browser、扩展页面的 ID 和 --runtime-dir；本检查不扫描个人 profile 或企业策略。');
  if (!options.extensionId) add('extension-id', 'warning', 'EXTENSION_ID_UNVERIFIED', '未指定扩展 ID，无法确认当前 profile 中的扩展是否被允许。', '传入 --extension-id=<扩展页面中的 ID> 再检查。');
  if (runtimeSafe && token) {
    const safeSocket = await check('socket', async () => {
      const s = await lstat(path.join(directory, 'broker.sock'));
      if (!s.isSocket() || s.uid !== process.getuid!() || (s.mode & 0o077)) throw new Finding('UNSAFE_SOCKET');
      return true;
    }, 'Broker 端点存在且私有', 'Broker 未启动时按文档显式启动；不要手工删除 socket 或锁文件。');
    if (safeSocket) {
      const controller = new AbortController();
      const socket = net.createConnection(path.join(directory, 'broker.sock'));
      let peer: RpcPeer | undefined;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); socket.destroy(); }, timeout);
      try {
        // Timeout must reject connect as well as subsequent RPCs, including an endpoint that never replies.
        await once(socket, 'connect', { signal: controller.signal });
        peer = new RpcPeer(socket, socket);
        const hello = await peer.call('hello', { bootstrap: 1, versions: [wireVersion], role: 'client', token,
          requiredCapabilities: [...clientRequirements] }, controller.signal);
        acceptWelcome(hello, clientRequirements);
        const instances = await peer.call('browser.instances', {}, controller.signal);
        if (!Array.isArray(instances) || instances.length > 256 || instances.some(i => !i || typeof i !== 'object' || typeof i.brand !== 'string')) throw new Finding('INVALID_RESPONSE');
        report.connection = { connected: true, instanceCount: instances.length,
          matchingBrowserCount: instances.filter(i => i.brand === options.brand).length };
        add('broker', 'ok', 'OK', 'Broker 协议握手与实例查询成功。');
        if (!report.connection.matchingBrowserCount) add('browser-connection', 'warning', 'NO_MATCHING_BROWSER', '尚无所选浏览器连接。', '在目标 profile 打开扩展弹窗，明确允许标签页并连接；不会自动授权。');
        else add('browser-connection', 'ok', 'OK', '检测到所选浏览器连接；不代表已获得标签页租约或模型可理解图片。');
      } catch (error) {
        add('broker', 'error', timedOut ? 'BROKER_TIMEOUT' : code(error), 'Broker 连接或协议检查失败。', '检查独立 Broker 终端的启动错误及版本；诊断不会重启进程、获取锁或修复文件。');
      } finally { clearTimeout(timer); peer?.close(); socket.destroy(); }
    } else add('broker', 'skipped', 'DEPENDENCY_FAILED', '端点检查未通过，未连接。');
  } else add('broker', 'skipped', 'DEPENDENCY_FAILED', '运行目录或认证检查未通过，未连接。');
  return finish();
}
