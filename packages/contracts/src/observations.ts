import { BrowserError, type FullObservation, type ObservationUpdate } from './index.js';
import { observationScope, sameScope } from './validation.js';

/** Deterministic consumer reducer. A delta can NEVER be applied to another base. */
export function applyObservationUpdate(base: FullObservation | undefined, update: ObservationUpdate): FullObservation {
  if (update.format === 'full') return { ...structuredClone(update), scope: observationScope(update.scope) };
  if (!base || base.cursor !== update.baseCursor || base.tab !== update.tab || base.documentEpoch !== update.documentEpoch
    || !sameScope(observationScope(base.scope), observationScope(update.scope))) {
    throw new BrowserError('STALE_TARGET', 'Observation delta requires its exact base cursor and document');
  }
  const nodes = new Map(base.nodes.map(node => [node.id, structuredClone(node)]));
  for (const id of update.nodes.remove) nodes.delete(id);
  for (const node of update.nodes.upsert) nodes.set(node.id, structuredClone(node));
  const order = update.nodes.order ?? [...nodes.keys()];
  if (order.length !== nodes.size || new Set(order).size !== order.length || order.some(id => !nodes.has(id))) {
    throw new BrowserError('INVALID_REQUEST', 'Observation delta has inconsistent node ordering');
  }
  const text = [...base.text];
  if (update.text) {
    const patch = update.text;
    if (!Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.deleteCount)
      || patch.start < 0 || patch.deleteCount < 0 || patch.start + patch.deleteCount > text.length
      || !Array.isArray(patch.insert) || patch.insert.some(value => typeof value !== 'string')) {
      throw new BrowserError('INVALID_REQUEST', 'Observation delta has an invalid text splice');
    }
    text.splice(patch.start, patch.deleteCount, ...patch.insert);
  }
  return { format: 'full', cursor: update.cursor, resyncRequired: false, tab: update.tab, url: update.url,
    title: update.title, documentEpoch: update.documentEpoch, revision: update.revision,
    nodes: order.map(id => nodes.get(id)!), text, truncated: update.truncated, scope: observationScope(update.scope) };
}
