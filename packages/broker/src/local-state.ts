import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';

export function defaultDirectory(): string { return path.join(homedir(), '.local', 'state', 'dsh-native-browser'); }

export async function localState(directory: string, create = false) {
  if (process.platform === 'win32') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Windows IPC ACL support is not implemented yet');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new BrowserError('POLICY_DENIED', 'Runtime directory must be owned by the current user with mode 0700');
  }
  const tokenPath = path.join(directory, 'auth-token');
  if (create) {
    try {
      const fd = await open(tokenPath, 'wx', 0o600);
      try { await fd.writeFile(randomBytes(32).toString('hex')); } finally { await fd.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const tokenStat = await lstat(tokenPath);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.uid !== stat.uid || (tokenStat.mode & 0o077)) {
    throw new BrowserError('POLICY_DENIED', 'Runtime token must be a private, user-owned regular file');
  }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new BrowserError('POLICY_DENIED', 'Invalid runtime token');
  const socket = path.join(directory, 'broker.sock');
  if (Buffer.byteLength(socket) > 100) throw new BrowserError('INVALID_REQUEST', 'Runtime socket path is too long');
  return { token, socket };
}
