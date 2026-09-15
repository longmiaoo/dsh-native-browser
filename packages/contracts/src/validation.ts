import { BrowserError, browserKeys, elementStates, type ElementState, type Action, type ActionRequest, type BatchRequest, type BrowserKey, type ObserveOptions, type ObservationScope, type SemanticQuery } from './index.js';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserError('INVALID_REQUEST', 'Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new BrowserError('INVALID_REQUEST', 'Invalid string field');
  return value;
}
export function scrollDelta(value: unknown): { deltaX: number; deltaY: number } {
  const v = record(value);
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= 10_000;
  if (!valid(v.deltaX) || !valid(v.deltaY) || v.deltaX === 0 && v.deltaY === 0) {
    throw new BrowserError('INVALID_REQUEST', 'Scroll deltas must be integers within ±10000 CSS pixels and not both zero');
  }
  return { deltaX: v.deltaX, deltaY: v.deltaY };
}
export function semanticQuery(value: unknown): SemanticQuery {
  const v = record(value), name = string(v.name, 1000);
  if (!name.trim() || Object.keys(v).some(key => !['name', 'role'].includes(key))) {
    throw new BrowserError('INVALID_REQUEST', 'Semantic queries require an exact nonblank name and optional role');
  }
  const role = v.role === undefined ? undefined : string(v.role, 80);
  if (role !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(role)) throw new BrowserError('INVALID_REQUEST', 'Invalid semantic role');
  return { name, ...(role === undefined ? {} : { role }) };
}
export function observeOptions(value: unknown): ObserveOptions {
  const v = record(value);
  return { ...(v.cursor === undefined ? {} : { cursor: string(v.cursor, 128) }),
    ...(v.frame === undefined ? {} : { frame: frameTarget(v.frame) }),
    ...(v.rootRef === undefined ? {} : { rootRef: string(v.rootRef, 128) }),
    ...(v.query === undefined ? {} : { query: semanticQuery(v.query) }) };
}
export function frameTarget(value: unknown): import('./index.js').FrameTarget {
  const v = record(value);
  if (Object.keys(v).some(key => !['frameId', 'documentEpoch'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid frame target');
  return { frameId: string(v.frameId, 128), documentEpoch: string(v.documentEpoch, 512) };
}
export function pageReadOptions(value: unknown): import('./index.js').PageReadOptions {
  const v = record(value);
  if (Object.keys(v).some(key => !['frame', 'rootRef', 'continuation'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Unsupported page read option');
  return { ...(v.frame === undefined ? {} : { frame: frameTarget(v.frame) }), ...(v.rootRef === undefined ? {} : { rootRef: string(v.rootRef, 128) }),
    ...(v.continuation === undefined ? {} : { continuation: string(v.continuation, 128) }) };
}
export function observationScope(value: unknown): ObservationScope {
  if (value === undefined) return { kind: 'document' };
  const v = record(value);
  if (v.kind === 'document' && Object.keys(v).length === 1) return { kind: 'document' };
  if (v.kind === 'subtree' && Object.keys(v).every(key => ['kind', 'rootRef', 'frameId'].includes(key)))
    return { kind: 'subtree', rootRef: string(v.rootRef, 128), ...(v.frameId === undefined ? {} : { frameId: string(v.frameId, 128) }) };
  if (v.kind === 'frame' && Object.keys(v).length === 2) return { kind: 'frame', frameId: string(v.frameId, 128) };
  if (v.kind === 'query' && Object.keys(v).every(key => ['kind', 'query', 'rootRef', 'frameId'].includes(key))) {
    return { kind: 'query', query: semanticQuery(v.query), ...(v.rootRef === undefined ? {} : { rootRef: string(v.rootRef, 128) }),
      ...(v.frameId === undefined ? {} : { frameId: string(v.frameId, 128) }) };
  }
  throw new BrowserError('INVALID_REQUEST', 'Invalid observation scope');
}
export function sameScope(a: ObservationScope, b: ObservationScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'document') return true;
  if (a.kind === 'subtree' && b.kind === 'subtree') return a.rootRef === b.rootRef && a.frameId === b.frameId;
  if (a.kind === 'frame' && b.kind === 'frame') return a.frameId === b.frameId;
  return a.kind === 'query' && b.kind === 'query' && a.rootRef === b.rootRef && a.frameId === b.frameId &&
    a.query.name === b.query.name && a.query.role === b.query.role;
}
export function actionRequest(value: unknown): ActionRequest {
  const v = record(value), a = record(v.action);
  if(a.frame!==undefined)throw new BrowserError('INVALID_REQUEST','Frame scope belongs on the action request');
  let action: Action;
  if (a.kind === 'check') {
    if (typeof a.checked !== 'boolean' || Object.keys(a).some(key => !['kind', 'ref', 'checked', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Check requires a boolean desired state and exact target');
    }
    action = { kind: 'check', ref: string(a.ref), checked: a.checked };
  }
  else if (a.kind === 'click') action = { kind: 'click', ref: string(a.ref) };
  else if (a.kind === 'fill' && typeof a.text === 'string' && a.text.length <= 10_000) action = { kind: 'fill', ref: string(a.ref), text: a.text };
  else if (a.kind === 'append') {
    if (typeof a.text !== 'string' || a.text.length > 10000 || Object.keys(a).some(key => !['kind', 'ref', 'text', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Append requires bounded text and one exact target');
    }
    action = { kind: 'append', ref: string(a.ref), text: a.text };
  }
  else if (a.kind === 'press') {
    if (!browserKeys.includes(a.key as BrowserKey) || a.shift !== undefined && typeof a.shift !== 'boolean'
      || Object.keys(a).some(key => !['kind', 'ref', 'key', 'shift', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Unsupported key or modifier; only named page keys and optional Shift are supported');
    }
    action = { kind: 'press', ref: string(a.ref), key: a.key as BrowserKey, shift: a.shift === true };
  }
  else if (a.kind === 'scroll' || a.kind === 'wheel') {
    if (Object.keys(a).some(key => !['kind', 'ref', 'deltaX', 'deltaY', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Unsupported scroll parameter');
    }
    action = a.kind === 'wheel' ? { kind: 'wheel', ref: string(a.ref), ...scrollDelta(a) }
      : { kind: 'scroll', ...scrollDelta(a), ...(a.ref === undefined ? {} : { ref: string(a.ref) }) };
  }
  else if (a.kind === 'navigate') action = { kind: 'navigate', url: string(a.url, 8192) };
  else throw new BrowserError('INVALID_REQUEST', 'Unsupported browser action');
  if (a.expected !== undefined) {
    const e = record(a.expected);
    if (e.kind === 'value' && typeof e.value === 'string' && e.value.length <= 10_000) action.expected = { kind: 'value', value: e.value };
    else if (e.kind === 'url') action.expected = { kind: 'url', url: string(e.url, 8192) };
    else if (e.kind === 'text') action.expected = { kind: 'text', text: string(e.text, 2000) };
    else if (e.kind === 'state' && elementStates.includes(e.state as ElementState)
      && Object.keys(e).every(key => ['kind', 'ref', 'state'].includes(key))) {
      if (action.kind === 'navigate') throw new BrowserError('INVALID_REQUEST', 'Node-state expectations cannot cross navigation');
      action.expected = { kind: 'state', ref: string(e.ref, 128), state: e.state as ElementState };
    }
    else throw new BrowserError('INVALID_REQUEST', 'Unsupported postcondition');
    if ((action.kind === 'scroll' || action.kind === 'wheel') && action.expected.kind === 'value') throw new BrowserError('INVALID_REQUEST', 'Scroll/wheel cannot verify an input value');
    if (action.kind === 'check' && action.expected.kind === 'value') throw new BrowserError('INVALID_REQUEST', 'Check verifies checked state, not the input value attribute');
  }
  const result: ActionRequest = { requestId: string(v.requestId, 128), leaseId: string(v.leaseId),
    documentEpoch: string(v.documentEpoch,512), action };
  if(v.frame!==undefined){
    result.frame=frameTarget(v.frame);
    if(result.documentEpoch!==result.frame.documentEpoch||action.kind!=='click'||action.expected&&action.expected.kind!=='text')
      throw new BrowserError('INVALID_REQUEST','Frame actions currently require click, the child epoch and an optional child-text postcondition');
  }
  if (v.timeoutMs !== undefined) {
    if (!Number.isInteger(v.timeoutMs) || Number(v.timeoutMs) < 1 || Number(v.timeoutMs) > 30_000) {
      throw new BrowserError('INVALID_REQUEST', 'Invalid action timeout');
    }
    result.timeoutMs = Number(v.timeoutMs);
  }
  return result;
}

export function batchRequest(value: unknown): BatchRequest {
  const v = record(value);
  if (Object.keys(v).some(key => !['requestId', 'leaseId', 'documentEpoch', 'steps', 'timeoutMs'].includes(key))
    || !Array.isArray(v.steps) || v.steps.length < 1 || v.steps.length > 8) throw new BrowserError('INVALID_REQUEST', 'Batch requires one to eight explicit steps');
  const requestId = string(v.requestId, 128);
  if (requestId.startsWith('batch:')) throw new BrowserError('INVALID_REQUEST', 'Reserved internal request ID prefix');
  const leaseId = string(v.leaseId), documentEpoch = string(v.documentEpoch);
  const count = v.steps.length;
  const steps = v.steps.map((raw, index) => {
    const step = record(raw);
    if (Object.keys(step).some(key => !['action', 'timeoutMs'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Unsupported batch step field');
    const parsed = actionRequest({ requestId: 'step', leaseId, documentEpoch, action: step.action, timeoutMs: step.timeoutMs });
    if (parsed.action.kind === 'navigate' && index !== count - 1) throw new BrowserError('INVALID_REQUEST', 'Explicit navigation must end a batch');
    return { action: parsed.action, ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }) };
  });
  if (v.timeoutMs !== undefined && (!Number.isInteger(v.timeoutMs) || Number(v.timeoutMs) < 1 || Number(v.timeoutMs) > 30000))
    throw new BrowserError('INVALID_REQUEST', 'Batch deadline must be within 1 to 30000 ms');
  return { requestId, leaseId, documentEpoch, steps, ...(v.timeoutMs === undefined ? {} : { timeoutMs: Number(v.timeoutMs) }) };
}
