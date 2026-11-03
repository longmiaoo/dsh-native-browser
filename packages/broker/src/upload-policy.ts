import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';

/** Folders a user ordinarily picks upload files from. Extend with --upload-root. */
export function defaultUploadRoots(home = homedir()): string[] {
  return ['Downloads', 'Desktop', 'Documents'].map(name => path.join(home, name));
}

const denied = () => new BrowserError('POLICY_DENIED',
  'Upload files must be existing, non-hidden regular files inside an allowed upload folder '
  + '(default: Downloads, Desktop, Documents; the Broker accepts more with --upload-root). Ask the user to move the file there.');

async function canonical(file: string): Promise<string | undefined> {
  try { return await realpath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Resolve configured roots once at startup. Missing folders are skipped, never created. */
export async function resolveUploadRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = new Set<string>();
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new BrowserError('INVALID_REQUEST', 'Upload roots must be absolute paths');
    const real = await canonical(root);
    if (real && (await stat(real)).isDirectory()) resolved.add(real);
  }
  return [...resolved];
}

function inside(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : undefined;
}

/**
 * The page and the model choose upload paths; only this Broker sees the real
 * filesystem. Symlinks are resolved before the allowlist check, so a link inside
 * Downloads cannot point at ~/.ssh. Returns the canonical paths to dispatch.
 */
export async function authorizeUploadFiles(files: readonly string[], roots: readonly string[],
  forbidden: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const file of files) {
    if (!path.isAbsolute(file)) throw denied();
    const real = await canonical(file).catch(() => undefined);
    if (!real) throw denied();
    if (forbidden.some(dir => real === dir || inside(dir, real))) throw denied();
    const relative = roots.map(root => inside(root, real)).find(value => value !== undefined);
    if (relative === undefined || relative.split(path.sep).some(part => part.startsWith('.'))) throw denied();
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile()) throw denied();
    result.push(real);
  }
  return result;
}
