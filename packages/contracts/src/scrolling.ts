import { BrowserError, type Action, type ScrollEvidence, type ScrollPosition } from './index.js';
import { record, scrollDelta, string } from './validation.js';

export function scrollPosition(value: unknown): ScrollPosition {
  const v = record(value), keys = ['x', 'y', 'scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'] as const;
  const position = {} as ScrollPosition;
  for (const key of keys) {
    const number = v[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || key !== 'x' && key !== 'y' && number < 0) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid scroll position evidence');
    }
    position[key] = number;
  }
  return position;
}

export function scrollMoved(before: ScrollPosition, after: ScrollPosition): boolean {
  return Math.abs(after.x - before.x) > 0.5 || Math.abs(after.y - before.y) > 0.5;
}

/** Native signed offsets support RTL/reverse layouts; do not assume a zero lower bound. */
export function scrollMovedAsRequested(evidence: ScrollEvidence): boolean {
  const aligned = (request: number, actual: number) => Math.abs(actual) <= 0.5 || request !== 0 && Math.sign(request) === Math.sign(actual);
  return evidence.moved && aligned(evidence.requested.deltaX, evidence.after.x - evidence.before.x)
    && aligned(evidence.requested.deltaY, evidence.after.y - evidence.before.y);
}

export function validateScrollEvidence(value: unknown, action: Extract<Action, { kind: 'scroll' }>): ScrollEvidence {
  const v = record(value), target = record(v.target), requested = scrollDelta(v.requested);
  if (requested.deltaX !== action.deltaX || requested.deltaY !== action.deltaY
    || (action.ref === undefined ? target.kind !== 'document' || Object.keys(target).length !== 1
      : target.kind !== 'element' || target.ref !== action.ref || Object.keys(target).length !== 2)) {
    throw new BrowserError('INVALID_REQUEST', 'Scroll evidence does not match the requested target and deltas');
  }
  const before = scrollPosition(v.before), after = scrollPosition(v.after);
  if (v.moved !== scrollMoved(before, after)) throw new BrowserError('INVALID_REQUEST', 'Scroll movement evidence is inconsistent');
  return { target: action.ref === undefined ? { kind: 'document' } : { kind: 'element', ref: string(target.ref) },
    requested, before, after, moved: v.moved };
}
