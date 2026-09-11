import { BrowserError } from '../../contracts/src/index.js';

/** CSS x=a*px+c*py+e, CSS y=b*px+d*py+f. No implicit DPR/scroll term. */
export type ImageToViewport = readonly [number, number, number, number, number, number];
export interface ImageSize { width: number; height: number }
export interface PixelBox { x1: number; y1: number; x2: number; y2: number }

export function validateSize(value: ImageSize): void {
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width < 1 || value.height < 1 || value.width > 32768 || value.height > 32768) {
    throw new BrowserError('INVALID_REQUEST', 'Invalid canonical image dimensions');
  }
}

export function validateBox(box: PixelBox, size: ImageSize): void {
  validateSize(size);
  if (![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite) || box.x1 < 0 || box.y1 < 0
    || box.x2 > size.width || box.y2 > size.height || box.x1 >= box.x2 || box.y1 >= box.y2) {
    throw new BrowserError('INVALID_REQUEST', 'Visual box is empty or outside the canonical image');
  }
}

/** Map all corners, including crop/rotation; never clamp an invalid model result. */
export function boxToViewport(box: PixelBox, image: ImageSize, viewport: ImageSize, transform: ImageToViewport) {
  validateBox(box, image);
  if (![viewport.width, viewport.height].every(v => Number.isFinite(v) && v > 0)
    || transform.length !== 6 || !transform.every(Number.isFinite)) {
    throw new BrowserError('INVALID_REQUEST', 'Invalid screenshot geometry');
  }
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new BrowserError('INVALID_REQUEST', 'Singular or overflowing screenshot transform');
  const corners = [[box.x1, box.y1], [box.x2, box.y1], [box.x1, box.y2], [box.x2, box.y2]]
    .map(([x, y]) => ({ x: a * x! + c * y! + e, y: b * x! + d * y! + f }));
  if (corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)
    || p.x < 0 || p.y < 0 || p.x > viewport.width || p.y > viewport.height)) {
    throw new BrowserError('INVALID_REQUEST', 'Mapped visual box falls outside the captured viewport');
  }
  const mapped = { x1: Math.min(...corners.map(p => p.x)), y1: Math.min(...corners.map(p => p.y)),
    x2: Math.max(...corners.map(p => p.x)), y2: Math.max(...corners.map(p => p.y)) };
  return { box: mapped, point: { x: (mapped.x1 + mapped.x2) / 2, y: (mapped.y1 + mapped.y2) / 2 } };
}
