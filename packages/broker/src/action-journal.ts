import { constants } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserError, type Action, type ActionResult } from '../../contracts/src/index.js';
import type { ActionJournal, RecoveryRecord } from '../../contracts/src/journal.js';

type Stored = { v: 1; key: string; hash: string; kind: Action['kind']; at: number; expires: number;
  state: 'reserved' | 'settled'; dispatch: 'notDispatched' | 'dispatched'; priorOutcome?: ActionResult['outcome'] };
const hex = /^[a-f0-9]{64}$/;
const unavailable = () => new BrowserError('JOURNAL_UNAVAILABLE', 'Action journal is unavailable; no new action may dispatch');

/** One writer, owned by the Broker after binding its exclusive socket. Unix local disk only. */
export class FileActionJournal implements ActionJournal {
  private readonly records = new Map<string, Stored>();
  private readonly active = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closing = false;
  private closed = false;
  private closeResult: Promise<void> | undefined;
  private bytes = 0;
  private sweep: ReturnType<typeof setInterval> | undefined;
  private constructor(private readonly directory: string, private readonly secret: string, private fd: FileHandle,
    private readonly limits: { maxEntries: number; maxBytes: number; ttlMs: number }, private readonly now: () => number) {}

  static async open(directory: string, secret: string, options: {
    maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number;
  } = {}): Promise<FileActionJournal> {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || dir.mode & 0o077 || !hex.test(secret)) {
      throw new BrowserError('POLICY_DENIED', 'Journal requires a private user-owned directory and local secret');
    }
    const limits = { maxEntries: options.maxEntries ?? 10000, maxBytes: options.maxBytes ?? 20 * 1024 * 1024,
      ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000 };
    if (Object.values(limits).some(v => !Number.isSafeInteger(v) || v < 1)) throw new BrowserError('INVALID_REQUEST', 'Invalid journal limits');
    const file = path.join(directory, 'action-journal.jsonl');
    // NOFOLLOW rejects symlinks; NONBLOCK avoids hanging on a substituted FIFO before fstat.
    let fd: FileHandle;
    try { fd = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
    catch (error) {
      if (['ELOOP', 'EISDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new BrowserError('POLICY_DENIED', 'Journal path must be an accessible private regular file');
      }
      throw unavailable();
    }
    const journal = new FileActionJournal(directory, secret, fd, limits, options.now ?? Date.now);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== dir.uid || stat.mode & 0o077) throw new BrowserError('POLICY_DENIED', 'Journal must be a private, singly-linked regular file');
      if (stat.size > limits.maxBytes) throw new BrowserError('JOURNAL_FULL', 'Journal exceeds its byte limit');
      const data = await fd.readFile(); journal.bytes = data.length;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (text && !text.endsWith('\n')) throw unavailable(); // Torn intent cannot be silently forgotten.
      for (const line of text.split('\n').slice(0, -1)) {
        if (Buffer.byteLength(line) > 1024) throw unavailable();
        const { record, mac, ...extra } = JSON.parse(line);
        if (Object.keys(extra).length || mac !== journal.digest('record', JSON.stringify(record))) throw unavailable();
        journal.validate(record);
        const prior = journal.records.get(record.key);
        if (prior && (prior.hash !== record.hash || prior.at !== record.at || prior.expires !== record.expires
          || prior.kind !== record.kind || prior.state !== 'reserved' || record.state !== 'settled')) throw unavailable();
        journal.records.set(record.key, record);
      }
      // A persisted name is required before any later intent is allowed to dispatch.
      await fd.sync(); await journal.syncDirectory();
      await journal.compact(true);
      if (journal.records.size > limits.maxEntries) throw new BrowserError('JOURNAL_FULL', 'Journal exceeds its entry limit');
      journal.sweep = setInterval(() => {
        if (!journal.failed && !journal.closing) void journal.serialized(() => journal.compact()).catch(() => {});
      }, 60_000);
      journal.sweep.unref();
      return journal;
    } catch (error) { await journal.fd.close(); throw error instanceof BrowserError ? error : unavailable(); }
  }

  private digest(domain: string, value: string): string {
    return createHmac('sha256', this.secret).update(domain).update('\0').update(value).digest('hex');
  }
  private validate(v: any): void {
    const fields = ['v', 'key', 'hash', 'kind', 'at', 'expires', 'state', 'dispatch', ...(v?.state === 'settled' ? ['priorOutcome'] : [])];
    if (!v || typeof v !== 'object' || Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k))
      || v.v !== 1 || !hex.test(v.key) || !hex.test(v.hash) || !['click', 'fill', 'press', 'scroll', 'navigate', 'check', 'wheel'].includes(v.kind)
      || !Number.isSafeInteger(v.at) || v.at < 0 || !Number.isSafeInteger(v.expires) || v.expires <= v.at
      || !['reserved', 'settled'].includes(v.state) || !['notDispatched', 'dispatched'].includes(v.dispatch)
      || v.state === 'reserved' && v.dispatch !== 'dispatched'
      || v.state === 'settled' && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(v.priorOutcome)) throw unavailable();
  }
  private healthy() { if (this.failed || this.closed) throw unavailable(); }
  private view(v: Stored): RecoveryRecord {
    return { state: v.state, recordedAt: v.at, dispatch: v.dispatch,
      ...(v.priorOutcome === undefined ? {} : { priorOutcome: v.priorOutcome }) };
  }
  lookup(key: string, hash: string): RecoveryRecord | undefined {
    this.healthy();
    const id = this.digest('key', key), v = this.records.get(id);
    if (!v || v.expires <= this.now() && !this.active.has(id)) return undefined;
    if (v.hash !== this.digest('payload', hash)) throw new BrowserError('REQUEST_ID_CONFLICT', 'Request ID already used for another payload');
    return this.view(v);
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw unavailable();
    this.healthy();
    const next = this.tail.then(() => { this.healthy(); return operation(); });
    this.tail = next.catch(() => {}); return next;
  }
  private line(record: Stored): Buffer {
    return Buffer.from(JSON.stringify({ record, mac: this.digest('record', JSON.stringify(record)) }) + '\n');
  }
  private async append(record: Stored): Promise<void> {
    const bytes = this.line(record);
    try { await this.fd.writeFile(bytes); await this.fd.sync(); this.bytes += bytes.length; }
    catch { this.failed = true; throw unavailable(); }
  }
  reserve(key: string, hash: string, kind: Action['kind']): Promise<boolean> {
    return this.serialized(async () => {
      if (this.lookup(key, hash)) return false;
      await this.compact();
      if (this.records.size >= this.limits.maxEntries) throw new BrowserError('JOURNAL_FULL', 'Journal entry limit reached');
      const at = this.now(), id = this.digest('key', key);
      const record: Stored = { v: 1, key: id, hash: this.digest('payload', hash), kind, at, expires: at + this.limits.ttlMs,
        state: 'reserved', dispatch: 'dispatched' };
      this.validate(record);
      // Reserve room for BOTH intent and settlement; never erase live fences to admit work.
      if (this.bytes + (this.active.size + 2) * 1024 > this.limits.maxBytes) {
        await this.compact(true);
        if (this.bytes + (this.active.size + 2) * 1024 > this.limits.maxBytes) throw new BrowserError('JOURNAL_FULL', 'Journal byte limit reached');
      }
      this.records.set(id, record); this.active.add(id);
      await this.append(record);
      return true;
    });
  }
  settle(key: string, result: Pick<ActionResult, 'outcome' | 'dispatch'>): Promise<void> {
    return this.serialized(async () => {
      const id = this.digest('key', key), previous = this.records.get(id);
      if (!previous || !this.active.has(id) || previous.state !== 'reserved') throw unavailable();
      const record: Stored = { ...previous, state: 'settled', dispatch: result.dispatch === 'notDispatched' ? 'notDispatched' : 'dispatched',
        priorOutcome: result.outcome };
      this.validate(record);
      await this.append(record);
      this.records.set(id, record); this.active.delete(id);
    });
  }
  private async syncDirectory() {
    const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private async compact(force = false): Promise<void> {
    const retained = [...this.records.values()].filter(v => v.expires > this.now() || this.active.has(v.key));
    if (!force && retained.length === this.records.size) return;
    const temporary = path.join(this.directory, `.action-journal-${randomUUID()}.tmp`);
    let fd: FileHandle | undefined;
    try {
      fd = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      const data = Buffer.concat(retained.map(record => this.line(record)));
      await fd.writeFile(data); await fd.sync();
      await rename(temporary, path.join(this.directory, 'action-journal.jsonl'));
      await this.syncDirectory();
      const old = this.fd; this.fd = fd; fd = undefined; await old.close();
      this.records.clear(); for (const v of retained) this.records.set(v.key, v);
      this.bytes = data.length;
    } catch { this.failed = true; throw unavailable(); }
    finally { await fd?.close(); await unlink(temporary).catch(() => {}); }
  }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    // Drain already queued writes before closing; do not accept new work.
    if (this.sweep) clearInterval(this.sweep);
    this.closing = true;
    this.closeResult = this.tail.then(async () => { this.closed = true; await this.fd.close(); });
    return this.closeResult;
  }
}
