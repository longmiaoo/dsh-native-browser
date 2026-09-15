import { createHash, randomUUID } from 'node:crypto';
import { BrowserError, type Screenshot } from '../../contracts/src/index.js';
import { validateSize, type ImageSize, type ImageToViewport } from './geometry.js';

export interface CanonicalImage extends ImageSize { attachmentId: string; bytes: Uint8Array }
export interface ScreenshotRef {
  id: string;
  attachmentId: string;
  sha256: string;
  leaseId: string;
  tab: string;
  documentEpoch: string;
  capturedAt: number;
  expiresAt: number;
  imageSize: ImageSize;
  viewport: Screenshot['viewport'];
  coordinateSpace: 'host-canonical-image-pixels';
  imageToViewport: ImageToViewport;
  redaction: Screenshot['redaction'];
}
type Entry = { owner: string; ref: ScreenshotRef };

/** Metadata only, bounded and task-scoped. Bytes stay in the Host attachment store. */
export class ScreenshotRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options = { maxEntries: 128, ttlMs: 60_000 }, private readonly now = Date.now) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > 4096
      || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 15 * 60_000) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid screenshot registry limits');
    }
  }
  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.ref.expiresAt <= now) this.entries.delete(id);
  }
  register(owner: string, leaseId: string, shot: Screenshot, canonical: CanonicalImage): ScreenshotRef {
    this.prune(); validateSize(canonical);
    const now = this.now(), viewport = shot.viewport, redaction = shot.redaction;
    if (!owner || !leaseId || !shot.tab || !shot.documentEpoch || !canonical.bytes.byteLength
      || canonical.bytes.byteLength > 20 * 1024 * 1024 || !Number.isFinite(shot.capturedAt)
      || shot.capturedAt > now + 1000 || shot.capturedAt + this.options.ttlMs <= now
      || ![viewport.width, viewport.height, viewport.pageX, viewport.pageY].every(Number.isFinite)
      || viewport.width <= 0 || viewport.height <= 0 || viewport.pageX < 0 || viewport.pageY < 0
      || !redaction || redaction.policy !== 'cross-origin-frames' || !Number.isSafeInteger(redaction.frames) || redaction.frames < 0
      || !Number.isSafeInteger(redaction.regions) || redaction.regions < 0 || redaction.regions > redaction.frames) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid or expired screenshot source');
    }
    const sha256 = createHash('sha256').update(canonical.bytes).digest('hex');
    // A canonical ID is content identity, not proof of task authorization.
    if (canonical.attachmentId !== `sha256:${sha256}`) throw new BrowserError('INVALID_REQUEST', 'Attachment identity does not match canonical bytes');
    while (this.entries.size >= this.options.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    const ref: ScreenshotRef = { id: randomUUID(), attachmentId: canonical.attachmentId, sha256,
      leaseId, tab: shot.tab, documentEpoch: shot.documentEpoch, capturedAt: shot.capturedAt,
      expiresAt: Math.min(now + this.options.ttlMs, shot.capturedAt + this.options.ttlMs),
      imageSize: { width: canonical.width, height: canonical.height }, viewport: { ...viewport },
      redaction: { ...redaction },
      coordinateSpace: 'host-canonical-image-pixels',
      imageToViewport: [viewport.width / canonical.width, 0, 0, viewport.height / canonical.height, 0, 0] };
    this.entries.set(ref.id, { owner, ref });
    return structuredClone(ref);
  }
  get(owner: string, id: string): ScreenshotRef {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw new BrowserError('STALE_TARGET', 'Screenshot is unavailable for this owning turn');
    return structuredClone(entry.ref);
  }
  revokeLease(owner: string, leaseId: string): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner && entry.ref.leaseId === leaseId) this.entries.delete(id);
  }
  revokeOwner(owner: string): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id);
  }
  clear(): void { this.entries.clear(); }
}
