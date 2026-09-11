import { BrowserError } from '../../contracts/src/index.js';
import { scrollDelta } from '../../contracts/src/validation.js';

const coordinate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1_000_000;

/** One CSS-pixel wheel sample, no modifiers, held buttons or synthetic gesture loop. */
export function wheelEvent(point: { x: number; y: number }, delta: { deltaX: number; deltaY: number }): Record<string, string | number> {
  if (!coordinate(point.x) || !coordinate(point.y)) throw new BrowserError('INVALID_REQUEST', 'Invalid wheel point');
  return { type: 'mouseWheel', x: point.x, y: point.y, ...scrollDelta(delta) };
}

/** Exact encoding shared by the provider and final MV3 input gate. */
export function allowedMouseEvent(params: Record<string, unknown>): boolean {
  if (!coordinate(params.x) || !coordinate(params.y)) return false;
  let expected: Record<string, string | number>;
  if (params.type === 'mouseWheel') {
    try { expected = wheelEvent({ x: params.x, y: params.y }, scrollDelta(params)); }
    catch { return false; }
  } else if (params.type === 'mousePressed' || params.type === 'mouseReleased') {
    expected = { type: params.type, x: params.x, y: params.y, button: 'left', clickCount: 1 };
  } else return false;
  return Object.keys(params).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => params[key] === value);
}
