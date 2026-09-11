import net from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { BrowserError } from '../../contracts/src/index.js';

const applicationId = 0x44534842; // DSHB. The lock database contains no user data or tables.
const inProcess = new Set<string>();
const busy = () => new BrowserError('BROKER_BUSY', 'Another process owns or is listening on this Broker endpoint');
const unsafe = () => new BrowserError('BROKER_STATE_UNSAFE', 'Broker ownership state is unsafe or unavailable; no recovery files were discarded');
const userId = () => BigInt(process.getuid?.() ?? -1);
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
async function statIfExists(file: string): Promise<BigIntStats | undefined> {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function privateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== userId()
    || stat.mode & 0o077n || stat.size > 64n * 1024n) throw unsafe();
}

/** A local-disk, process-lifetime exclusive lock. Never delete/replace its database inode. */
export interface BrokerOwnership {
  prepareSocket(socket: string): Promise<boolean>;
  close(): void;
}
export async function acquireBrokerOwnership(directory: string): Promise<BrokerOwnership> {
  if (process.platform === 'win32') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Windows Broker ownership is not implemented');
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory, { bigint: true });
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== userId() || dir.mode & 0o077n) throw unsafe();
  const ownerKey = `${dir.dev}:${dir.ino}`;
  if (inProcess.has(ownerKey)) throw busy();
  inProcess.add(ownerKey);
  let db: DatabaseSync | undefined, closed = false;
  try {
    const file = path.join(directory, 'broker-lock.sqlite');
    const initial = await statIfExists(file);
    if (initial) privateFile(initial);
    // Only rollback journals from our fixed metadata transaction are eligible for SQLite recovery.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const sidecar = await statIfExists(file + suffix);
      if (sidecar) { privateFile(sidecar); if (suffix !== '-journal') throw unsafe(); }
    }
    let sqlite: typeof import('node:sqlite');
    try { sqlite = await import('node:sqlite'); }
    catch { throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Broker ownership requires Node built with node:sqlite'); }
    // SQLite alone opens/closes this inode: unrelated fd closes can release POSIX record locks.
    db = new sqlite.DatabaseSync(file, { timeout: 0, allowExtension: false });
    const created = await lstat(file, { bigint: true });
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n || created.uid !== dir.uid) throw unsafe();
    if (initial && !sameFile(initial, created)) throw unsafe();
    if (!initial) await chmod(file, 0o600);
    privateFile(await lstat(file, { bigint: true }));
    db.exec('PRAGMA trusted_schema=OFF');
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw unsafe();
    db.exec('BEGIN EXCLUSIVE');
    const id = db.prepare('PRAGMA application_id').get()?.application_id;
    if (id === 0 && created.size === 0n) {
      db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT; BEGIN EXCLUSIVE`);
    }
    if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId
      || db.prepare('PRAGMA user_version').get()?.user_version !== 1
      || db.prepare('SELECT count(*) AS count FROM sqlite_schema').get()?.count !== 0) throw unsafe();
    const locked = await lstat(file, { bigint: true }); privateFile(locked);
    if (!sameFile(created, locked)) throw unsafe();
    const held = async () => {
      if (closed || !db?.isTransaction) throw unsafe();
      const current = await lstat(file, { bigint: true }); privateFile(current);
      if (!sameFile(locked, current)) throw unsafe();
    };
    return {
      async prepareSocket(socket) {
        if (path.resolve(socket) !== path.resolve(directory, 'broker.sock')) throw unsafe();
        await held();
        const old = await statIfExists(socket);
        if (!old) return false;
        if (!old.isSocket() || old.isSymbolicLink() || old.uid !== dir.uid || old.nlink !== 1n) throw unsafe();
        // A legacy/non-cooperating listener is never removed, even if it lacks our lock.
        const status = await probeSocket(socket);
        if (status === 'live') throw busy();
        await held();
        const current = await statIfExists(socket);
        if (!current) return false;
        if (status !== 'refused' || !sameFile(old, current) || !current.isSocket() || current.uid !== dir.uid) throw unsafe();
        await unlink(socket);
        return true;
      },
      close() {
        if (closed) return;
        closed = true;
        try { if (db?.isTransaction) db.exec('ROLLBACK'); }
        finally { try { db?.close(); } finally { inProcess.delete(ownerKey); } }
      },
    };
  } catch (error) {
    try { db?.close(); } finally { inProcess.delete(ownerKey); }
    if (error instanceof BrowserError) throw error;
    if ([5, 6].includes(Number((error as { errcode?: number }).errcode) & 0xff)) throw busy();
    throw unsafe();
  }
}

function probeSocket(socket: string): Promise<'live' | 'refused' | 'missing'> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    const finish = (value?: 'live' | 'refused' | 'missing') => {
      clearTimeout(timer); client.destroy();
      if (value) resolve(value); else reject(unsafe());
    };
    const timer = setTimeout(() => finish(), 1000);
    client.once('connect', () => finish('live'));
    client.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' ? 'refused' : code === 'ENOENT' ? 'missing' : undefined);
    });
  });
}
