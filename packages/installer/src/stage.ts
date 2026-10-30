import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';

const MAX_ENTRIES = 2048;
const MAX_BYTES = 64 * 1024 * 1024;

interface CopyBudget { entries: number; bytes: number }

function refused(): never {
  throw new BrowserError('POLICY_DENIED', 'Packaged extension contains an unsafe or oversized file');
}

async function safeDirectory(directory: string): Promise<void> {
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid!() || (value.mode & 0o077)) refused();
}

async function copyTree(source: string, target: string, budget: CopyBudget): Promise<void> {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) refused();
  await mkdir(target, { mode: 0o700 });
  const entries = (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (++budget.entries > MAX_ENTRIES) refused();
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    const value = await lstat(from);
    if (entry.isDirectory()) {
      if (!value.isDirectory() || value.isSymbolicLink()) refused();
      await copyTree(from, to, budget);
    } else if (entry.isFile()) {
      // pnpm legitimately hard-links immutable package-store files on Linux.
      // Reading those into a new private file is safe; never chmod/mutate the
      // source inode. Destination/runtime state still uses private single links.
      if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid!() || value.size > MAX_BYTES) refused();
      budget.bytes += value.size;
      if (budget.bytes > MAX_BYTES) refused();
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o600);
    } else refused();
  }
}

/** Copy a packaged MV3 directory to a stable per-user path without following links.
 * The final directory is swapped under a private runtime directory, so a later
 * package update does not invalidate the directory selected in Chrome. */
export async function stageExtension(source: string, destination: string): Promise<{ path: string; files: number; bytes: number }> {
  const sourceDirectory = path.resolve(source), destinationDirectory = path.resolve(destination);
  const parent = path.dirname(destinationDirectory);
  try { await mkdir(parent, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await safeDirectory(parent);
  const temporary = path.join(parent, `.extension-${randomUUID()}.tmp`);
  const backup = path.join(parent, `.extension-${randomUUID()}.old`);
  const budget: CopyBudget = { entries: 0, bytes: 0 };
  let movedOld = false, movedNew = false;
  try {
    await copyTree(sourceDirectory, temporary, budget);
    try {
      const existing = await lstat(destinationDirectory);
      if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid!() || (existing.mode & 0o077)) refused();
      await rename(destinationDirectory, backup);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporary, destinationDirectory);
    movedNew = true;
    if (movedOld) await rm(backup, { recursive: true, force: true });
    return { path: destinationDirectory, files: budget.entries, bytes: budget.bytes };
  } catch (error) {
    if (movedNew) await rm(destinationDirectory, { recursive: true, force: true }).catch(() => {});
    if (movedOld) await rename(backup, destinationDirectory).catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (error instanceof BrowserError) throw error;
    throw new BrowserError('INSTALLATION_FAILED', 'Could not stage the browser extension; the previous staged copy was preserved');
  }
}
