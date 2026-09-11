import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';

export interface FileSnapshot { bytes: Buffer; stat: BigIntStats }
export interface FileChange { file: string; before?: FileSnapshot | undefined; bytes: Buffer; mode: number }
const unsafe = () => new BrowserError('POLICY_DENIED', 'Installation file is unsafe or changed; existing data was preserved');
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
const safe = (s: BigIntStats, limit: number) => s.isFile() && s.nlink === 1n && s.uid === BigInt(process.getuid!())
  && !(s.mode & 0o077n) && s.size <= BigInt(limit);
async function stat(file: string): Promise<BigIntStats | undefined> {
  try { return await lstat(file, { bigint: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}

/** Bounded private regular-file read, never following a target symlink or opening a lock database. */
export async function snapshot(file: string, limit = 16384): Promise<FileSnapshot | undefined> {
  const before = await stat(file); if (!before) return;
  if (!safe(before, limit)) throw unsafe();
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await fd.stat({ bigint: true });
    if (!same(before, actual) || !safe(actual, limit)) throw unsafe();
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) {
      const read = await fd.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await fd.stat({ bigint: true }), named = await stat(file);
    if (length > limit || !same(actual, after) || !named || !same(actual, named) || !safe(named, limit)) throw unsafe();
    return { bytes: bytes.subarray(0, length), stat: after };
  } finally { await fd.close(); }
}

async function unchanged(file: string, expected?: FileSnapshot) {
  const current = await snapshot(file);
  if (expected ? !current || !same(expected.stat, current.stat) || !expected.bytes.equals(current.bytes) : !!current) throw unsafe();
}
async function syncDirectory(directory: string) {
  const fd = await open(directory, constants.O_RDONLY);
  try { await fd.sync(); } finally { await fd.close(); }
}

async function publish(change: FileChange, committed: (value: FileSnapshot) => void) {
  const temp = path.join(path.dirname(change.file), `.dsh-host-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = await open(temp, 'wx', change.mode); created = true;
    let staged: FileSnapshot;
    try {
      await fd.chmod(change.mode); await fd.writeFile(change.bytes); await fd.sync();
      staged = { bytes: change.bytes, stat: await fd.stat({ bigint: true }) };
    } finally { await fd.close(); }
    await unchanged(change.file, change.before);
    await rename(temp, change.file); created = false;
    // Record immediately after rename: even a later fsync failure must roll back.
    // rename can update ctime; obtain the named snapshot before comparisons.
    committed(staged!);
    const named = await snapshot(change.file);
    if (!named || named.stat.ino !== staged!.stat.ino || named.stat.dev !== staged!.stat.dev || !named.bytes.equals(change.bytes)) throw unsafe();
    committed(named);
    await syncDirectory(path.dirname(change.file));
  } finally { if (created) await unlink(temp).catch(() => {}); }
}

/** Cooperating installer locks must already be held. Per-file atomicity, not a cross-directory transaction.
 * The optional publisher is a trusted test seam; the CLI never accepts it. */
export async function commitFiles(changes: FileChange[], publisher: typeof publish = publish): Promise<void> {
  const applied = new Map<FileChange, FileSnapshot>();
  try {
    for (const change of changes) {
      if (change.before?.bytes.equals(change.bytes) && Number(change.before.stat.mode & 0o777n) === change.mode) {
        await unchanged(change.file, change.before); continue;
      }
      await publisher(change, value => applied.set(change, value));
    }
  } catch {
    let rollbackFailed = false;
    for (const [change, installed] of [...applied].reverse()) {
      try {
        // ctime alone may differ after a rename whose acknowledgement failed.
        const current = await snapshot(change.file);
        if (!current || current.stat.dev !== installed.stat.dev || current.stat.ino !== installed.stat.ino
          || !current.bytes.equals(installed.bytes) || current.stat.mode !== installed.stat.mode) throw unsafe();
        if (change.before) await publish({ file: change.file, before: current, bytes: change.before.bytes,
          mode: Number(change.before.stat.mode & 0o777n) }, () => {});
        else { await unchanged(change.file, current); await unlink(change.file); await syncDirectory(path.dirname(change.file)); }
      } catch { rollbackFailed = true; }
    }
    throw new BrowserError('INSTALLATION_FAILED', rollbackFailed
      ? 'Host installation failed; rollback was incomplete. Inspect installation files before retrying; no foreign replacement was overwritten.'
      : 'Host installation failed; published host files were rolled back. Existing runtime identity and recovery data were preserved.');
  }
}

export const publishInstallationFile = publish;

/** Caller holds registration locks and has already persisted a recoverable backup. */
export async function removeInstallationFile(file: string, before: FileSnapshot): Promise<void> {
  await unchanged(file, before);
  await unlink(file);
  await syncDirectory(path.dirname(file));
}
