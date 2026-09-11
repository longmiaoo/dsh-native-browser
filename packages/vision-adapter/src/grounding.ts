import { BrowserError } from '../../contracts/src/index.js';
import { boxToViewport, type PixelBox } from './geometry.js';
import type { ScreenshotRegistry } from './screenshots.js';

export interface VisualCandidate {
  screenshotId: string;
  screenshotSha256: string;
  leaseId: string;
  tab: string;
  documentEpoch: string;
  expiresAt: number;
  box: PixelBox;
  coordinateSpace: 'host-canonical-image-pixels';
  sourceWidth: number;
  sourceHeight: number;
  viewportBox: PixelBox;
  viewportPoint: { x: number; y: number };
  targetDescription: string;
  source: 'dsh-vision-router-public-ground';
}

/** Consume only the PUBLIC vision_ground result (already un-letterboxed upstream).
 * A candidate is untrusted evidence, never a browser input authorization.
 */
export function parseRouterGrounding(registry: ScreenshotRegistry, owner: string, screenshotId: string,
  targetDescription: string, raw: unknown): VisualCandidate {
  const ref = registry.get(owner, screenshotId);
  if (typeof targetDescription !== 'string' || !targetDescription.trim() || targetDescription.length > 500) {
    throw new BrowserError('INVALID_REQUEST', 'A bounded visual target description is required');
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024) throw new BrowserError('INVALID_REQUEST', 'Expected bounded public vision_ground JSON');
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new BrowserError('INVALID_REQUEST', 'Invalid vision_ground JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserError('INVALID_REQUEST', 'Invalid grounding result');
  if (value.ok === false) throw new BrowserError('VISION_UNAVAILABLE', 'Vision Router did not produce a usable result');
  if (value.width !== ref.imageSize.width || value.height !== ref.imageSize.height
    || (value.coordinateSpace !== undefined && value.coordinateSpace !== ref.coordinateSpace)) {
    throw new BrowserError('STALE_TARGET', 'Grounding dimensions or coordinate space do not match the authorized screenshot');
  }
  const box: PixelBox = { x1: value.x1, y1: value.y1, x2: value.x2, y2: value.y2 };
  const mapped = boxToViewport(box, ref.imageSize, ref.viewport, ref.imageToViewport);
  return { screenshotId: ref.id, screenshotSha256: ref.sha256, leaseId: ref.leaseId, tab: ref.tab,
    documentEpoch: ref.documentEpoch, expiresAt: ref.expiresAt, box, coordinateSpace: ref.coordinateSpace,
    sourceWidth: ref.imageSize.width, sourceHeight: ref.imageSize.height, viewportBox: mapped.box,
    viewportPoint: mapped.point, targetDescription, source: 'dsh-vision-router-public-ground' };
}
