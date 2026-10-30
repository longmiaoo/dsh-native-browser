import { BrowserError, browserKeys, elementStates, type ElementState, type Action, type ActionRequest, type BatchRequest, type BrowserKey, type ObserveOptions, type ObservationScope, type SemanticQuery } from './index.js';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserError('INVALID_REQUEST', 'Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new BrowserError('INVALID_REQUEST', 'Invalid string field');
  return value;
}
const absoluteWindowsPath = /^[A-Za-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/;
export function localPath(value: unknown): string {
  const file = string(value, 4096);
  if (file.includes('\0') || /[\r\n]/.test(file) || file.includes('://')) {
    throw new BrowserError('INVALID_REQUEST', 'Local paths must not contain control characters or URL schemes');
  }
  if (!file.startsWith('/') && !absoluteWindowsPath.test(file)) {
    throw new BrowserError('INVALID_REQUEST', 'Local paths must be absolute');
  }
  return file;
}
export function uploadFile(value: unknown): string { return localPath(value); }
export function downloadEvidence(value: unknown): import('./index.js').DownloadEvidence {
  const v = record(value);
  const filename = string(v.filename, 255);
  if (/[\\/\0\r\n]/.test(filename) || filename === '.' || filename === '..') {
    throw new BrowserError('INVALID_REQUEST', 'Download filename must be a single safe name');
  }
  if (!Number.isSafeInteger(v.receivedBytes) || Number(v.receivedBytes) < 0) {
    throw new BrowserError('INVALID_REQUEST', 'Download byte count is invalid');
  }
  if (v.totalBytes !== undefined && (!Number.isSafeInteger(v.totalBytes) || Number(v.totalBytes) < Number(v.receivedBytes))) {
    throw new BrowserError('INVALID_REQUEST', 'Download total must cover its received bytes');
  }
  return { filename, path: localPath(v.path), receivedBytes: Number(v.receivedBytes),
    ...(v.totalBytes === undefined ? {} : { totalBytes: Number(v.totalBytes) }) };
}
const bounded = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BrowserError('INVALID_REQUEST', `Invalid ${label}`);
  }
  return value;
};
export function visualBox(value: unknown): { x1: number; y1: number; x2: number; y2: number } {
  const v = record(value);
  if (Object.keys(v).some(key => !['x1', 'y1', 'x2', 'y2'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Visual box accepts only x1/y1/x2/y2');
  const box = { x1: bounded(v.x1, 0, 1_000_000, 'visual box'), y1: bounded(v.y1, 0, 1_000_000, 'visual box'),
    x2: bounded(v.x2, 0, 1_000_000, 'visual box'), y2: bounded(v.y2, 0, 1_000_000, 'visual box') };
  if (box.x1 >= box.x2 || box.y1 >= box.y2) throw new BrowserError('INVALID_REQUEST', 'Visual box must have positive area');
  return box;
}
export function visualPoint(value: unknown): { x: number; y: number } {
  const v = record(value);
  if (Object.keys(v).some(key => !['x', 'y'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Visual point accepts only x/y');
  return { x: bounded(v.x, 0, 1_000_000, 'visual point'), y: bounded(v.y, 0, 1_000_000, 'visual point') };
}
function visualViewport(value: unknown) {
  const v = record(value);
  if (Object.keys(v).some(key => !['width', 'height', 'pageX', 'pageY'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid visual viewport');
  return { width: bounded(v.width, 1, 1_000_000, 'viewport width'), height: bounded(v.height, 1, 1_000_000, 'viewport height'),
    pageX: bounded(v.pageX, 0, 10_000_000, 'viewport pageX'), pageY: bounded(v.pageY, 0, 10_000_000, 'viewport pageY') };
}
export function visualEvidence(value: unknown): import('./index.js').VisualEvidence {
  const v = record(value);
  return { screenshotId: string(v.screenshotId, 128), target: string(v.target, 500),
    viewportBox: visualBox(v.viewportBox), viewportPoint: visualPoint(v.viewportPoint) };
}
export function dialogEvidence(value: unknown): import('./index.js').DialogEvidence {
  const v = record(value);
  if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(v.type))) throw new BrowserError('INVALID_REQUEST', 'Invalid dialog type');
  if (typeof v.message !== 'string' || v.message.length > 2000 || typeof v.accepted !== 'boolean') throw new BrowserError('INVALID_REQUEST', 'Invalid dialog evidence');
  if (v.promptText !== undefined && (typeof v.promptText !== 'string' || v.promptText.length > 1000)) throw new BrowserError('INVALID_REQUEST', 'Invalid dialog prompt text');
  return { type: v.type as import('./index.js').DialogEvidence['type'], message: v.message, accepted: v.accepted,
    ...(v.promptText === undefined ? {} : { promptText: v.promptText }) };
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
  else if (a.kind === 'upload') {
    if (Object.keys(a).some(key => !['kind', 'ref', 'files', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Upload requires one exact file-input target and bounded local files');
    }
    if (!Array.isArray(a.files) || a.files.length < 1 || a.files.length > 64) {
      throw new BrowserError('INVALID_REQUEST', 'Upload requires one to sixty-four local files');
    }
    action = { kind: 'upload', ref: string(a.ref), files: a.files.map(uploadFile) };
  }
  else if (a.kind === 'choose') {
    if (Object.keys(a).some(key => !['kind', 'ref', 'files', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Choose requires one exact chooser trigger and bounded local files');
    }
    if (!Array.isArray(a.files) || a.files.length < 1 || a.files.length > 64) {
      throw new BrowserError('INVALID_REQUEST', 'Choose requires one to sixty-four local files');
    }
    action = { kind: 'choose', ref: string(a.ref), files: a.files.map(uploadFile) };
  }
  else if (a.kind === 'download') {
    if (Object.keys(a).some(key => !['kind', 'ref', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Download requires one exact trigger and no path or URL parameters');
    }
    action = { kind: 'download', ref: string(a.ref) };
  }
  else if (a.kind === 'visual-click') {
    if (Object.keys(a).some(key => !['kind', 'screenshotId', 'screenshotSha256', 'target', 'viewport', 'box', 'point', 'expected'].includes(key))) {
      throw new BrowserError('INVALID_REQUEST', 'Visual click accepts only a grounded screenshot target');
    }
    const sha256 = string(a.screenshotSha256, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new BrowserError('INVALID_REQUEST', 'Invalid visual screenshot digest');
    const viewport = visualViewport(a.viewport), box = visualBox(a.box), point = visualPoint(a.point);
    if (box.x2 > viewport.width || box.y2 > viewport.height || point.x > viewport.width || point.y > viewport.height
      || point.x < box.x1 || point.x > box.x2 || point.y < box.y1 || point.y > box.y2) {
      throw new BrowserError('INVALID_REQUEST', 'Visual target lies outside its captured viewport');
    }
    action = { kind: 'visual-click', screenshotId: string(a.screenshotId, 128), screenshotSha256: sha256,
      target: string(a.target, 500), viewport, box, point };
  }
  else if (a.kind === 'dialog') {
    if (Object.keys(a).some(key => !['kind', 'accept', 'promptText', 'expected'].includes(key)) || typeof a.accept !== 'boolean') {
      throw new BrowserError('INVALID_REQUEST', 'Dialog requires a boolean accept and optional prompt text');
    }
    if (a.promptText !== undefined && (typeof a.promptText !== 'string' || a.promptText.length > 1000 || !a.accept)) {
      throw new BrowserError('INVALID_REQUEST', 'Dialog prompt text requires accept=true and at most 1000 characters');
    }
    action = { kind: 'dialog', accept: a.accept, ...(a.promptText === undefined ? {} : { promptText: a.promptText }) };
  }
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
    if ((action.kind === 'upload' || action.kind === 'choose' || action.kind === 'download') && (action.expected.kind === 'value' || action.expected.kind === 'url')) throw new BrowserError('INVALID_REQUEST', 'File actions verify page text or node state, not input value or navigation');
    if (action.kind === 'visual-click' && (action.expected.kind === 'value' || action.expected.kind === 'url')) throw new BrowserError('INVALID_REQUEST', 'Visual click verifies page text or node state, not input value or navigation');
    if (action.kind === 'dialog' && (action.expected.kind === 'value' || action.expected.kind === 'url')) throw new BrowserError('INVALID_REQUEST', 'Dialog verifies page text or node state, not input value or navigation');
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
