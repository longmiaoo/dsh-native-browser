import { BrowserError, originOf, type FrameInventory, type FrameSummary, type Lease } from './index.js';
import type { FrameTarget } from './index.js';

/** First implemented content policy: exact child document AND every ancestor
 * must share the authorized root origin. A same-origin grandchild behind a
 * third-party parent is not an implicit grant across that parent. */
export function sameOriginFrame(inventory: FrameInventory, target: FrameTarget, lease: Lease): FrameSummary {
  const byId = new Map(inventory.frames.map(frame => [frame.id, frame]));
  const frame = byId.get(target.frameId);
  if (!frame || frame.documentEpoch !== target.documentEpoch) throw new BrowserError('STALE_TARGET', 'Frame document is no longer current');
  if (frame.isMain) throw new BrowserError('INVALID_REQUEST', 'Use document observation for the main frame');
  if (inventory.truncated || frame.contextStatus !== 'known') throw new BrowserError('POLICY_DENIED', 'Frame authority is incomplete');
  let current: FrameSummary | undefined = frame; const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id) || current.origin !== lease.origin) throw new BrowserError('POLICY_DENIED', 'Frame ancestor is outside the authorized origin');
    seen.add(current.id);
    if (current.isMain) return frame;
    current = current.parentId === undefined ? undefined : byId.get(current.parentId);
  }
  throw new BrowserError('POLICY_DENIED', 'Frame ancestor is unavailable');
}

/** Validate the portable graph and project an allowlisted, metadata-only result. */
export function frameInventory(raw: FrameInventory, lease: Lease): FrameInventory {
  const valid = (value: unknown, max = 128): value is string => typeof value === 'string' && !!value && value.length <= max;
  const invalid = (): never => { throw new BrowserError('INVALID_REQUEST', 'Invalid frame inventory'); };
  if (!raw || raw.tab !== lease.tab) throw new BrowserError('POLICY_DENIED', 'Frame inventory belongs to another tab');
  if (!valid(raw.documentEpoch, 512) || typeof raw.truncated !== 'boolean' || !Array.isArray(raw.frames)
    || !raw.frames.length || raw.frames.length > 256) invalid();
  const frames: FrameSummary[] = raw.frames.map(frame => {
    if (!frame || !valid(frame.id) || typeof frame.isMain !== 'boolean'
      || frame.parentId !== undefined && !valid(frame.parentId)
      || frame.documentEpoch !== undefined && !valid(frame.documentEpoch, 512)
      || !['known', 'unavailable'].includes(frame.contextStatus)) invalid();
    if (frame.origin !== undefined && (!valid(frame.origin, 2048) || originOf(frame.origin) !== frame.origin)) invalid();
    return { id: frame.id, isMain: frame.isMain, contextStatus: frame.contextStatus,
      ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
      ...(frame.documentEpoch === undefined ? {} : { documentEpoch: frame.documentEpoch }),
      ...(frame.origin === undefined ? {} : { origin: frame.origin }),
      originRelation: frame.origin === undefined ? 'opaque' : frame.origin === lease.origin ? 'same-origin' : 'cross-origin' };
  });
  const byId = new Map(frames.map(frame => [frame.id, frame]));
  const roots = frames.filter(frame => frame.isMain);
  if (byId.size !== frames.length || roots.length !== 1) invalid();
  const root = roots[0]!;
  if (root.parentId !== undefined || root.origin !== lease.origin || root.documentEpoch !== raw.documentEpoch)
    throw new BrowserError('POLICY_DENIED', 'Frame root is outside the authorized document');
  for (const frame of frames) {
    const seen = new Set<string>(); let current = frame;
    while (current !== root) {
      if (seen.has(current.id) || !current.parentId || !byId.has(current.parentId)) invalid();
      seen.add(current.id); current = byId.get(current.parentId!)!;
    }
  }
  const result = { tab: lease.tab, documentEpoch: raw.documentEpoch, frames, truncated: raw.truncated };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 96 * 1024) invalid();
  return result;
}
