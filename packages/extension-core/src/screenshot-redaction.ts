import { BrowserError } from '../../contracts/src/index.js';

export type ScreenshotQuad = readonly [number, number, number, number, number, number, number, number];
export interface ScreenshotClip { x: number; y: number; width: number; height: number }
export interface ScreenshotPixelSize { width: number; height: number }
export interface ScreenshotRedactionRect { x: number; y: number; width: number; height: number }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
const invalid = (): never => { throw new BrowserError('POLICY_DENIED', 'Cross-origin frame could not be safely redacted'); };

/** Convert absolute-page CDP frame quads into conservative screenshot-pixel boxes.
 * Bounding boxes intentionally cover a little more than transformed iframe pixels
 * so antialiasing at the frame edge cannot leak into the published image. */
export function screenshotRedactionRects(quads: readonly ScreenshotQuad[], clip: ScreenshotClip,
  image: ScreenshotPixelSize): ScreenshotRedactionRect[] {
  if (!clip || ![clip.x, clip.y, clip.width, clip.height].every(finite) || clip.width <= 0 || clip.height <= 0
    || !image || ![image.width, image.height].every(finite) || image.width < 1 || image.height < 1) invalid();
  const sx = image.width / clip.width, sy = image.height / clip.height;
  const result: ScreenshotRedactionRect[] = [];
  for (const quad of quads) {
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(finite)) invalid();
    const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
    const left = Math.max(0, Math.floor((Math.min(...xs) - clip.x) * sx) - 2);
    const top = Math.max(0, Math.floor((Math.min(...ys) - clip.y) * sy) - 2);
    const right = Math.min(image.width, Math.ceil((Math.max(...xs) - clip.x) * sx) + 2);
    const bottom = Math.min(image.height, Math.ceil((Math.max(...ys) - clip.y) * sy) + 2);
    if (right > left && bottom > top) result.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return result;
}

function bytesFromBase64(data: unknown): Uint8Array {
  if (typeof data !== 'string' || !data.length || data.length > 900_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new BrowserError('INVALID_REQUEST', 'Screenshot payload is invalid');
  }
  let binary: string;
  try { binary = atob(data); } catch { throw new BrowserError('INVALID_REQUEST', 'Screenshot payload is invalid'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8192, bytes.length)));
  }
  return btoa(binary);
}

/** Redaction happens inside the MV3 service worker before screenshot bytes cross
 * Native Messaging. No unredacted cross-origin pixels leave the extension. */
export async function redactScreenshotJpeg(data: unknown, clip: ScreenshotClip, quads: readonly ScreenshotQuad[], quality = 70) {
  const source = bytesFromBase64(data);
  if (!quads.length) return { data: data as string, regions: 0 };
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Secure screenshot redaction is unavailable in this browser');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([source.buffer as ArrayBuffer], { type: 'image/jpeg' }));
  }
  catch { throw new BrowserError('INVALID_REQUEST', 'Screenshot image could not be decoded for redaction'); }
  try {
    if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1
      || bitmap.width > 16_384 || bitmap.height > 16_384) invalid();
    const rectangles = screenshotRedactionRects(quads, clip, { width: bitmap.width, height: bitmap.height });
    if (!rectangles.length) return { data: String(data), regions: 0 };
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Secure screenshot redaction is unavailable in this browser');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#d8dce3';
    for (const rectangle of rectangles) context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    const normalizedQuality = Number.isFinite(quality) ? Math.max(0, Math.min(1, quality / 100)) : 0.7;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: normalizedQuality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length || bytes.length > 675_000) throw new BrowserError('QUEUE_FULL', 'Redacted screenshot exceeds preview transport budget');
    return { data: base64FromBytes(bytes), regions: rectangles.length };
  } finally { bitmap.close(); }
}
