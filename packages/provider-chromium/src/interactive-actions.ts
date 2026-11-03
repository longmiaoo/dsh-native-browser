import { stat } from 'node:fs/promises';
import path from 'node:path';
import { BrowserError, type Action, type ActionRequest, type DownloadEvidence, type Lease, type Observation,
  type ProviderExecution, type ProviderResult } from '../../contracts/src/index.js';
import { string } from '../../contracts/src/validation.js';
import { ChangeClock, waitUntil } from './wait.js';
import { sameGeometry } from './actionability.js';
import { uploadInputFunction, visualHitFunction } from './page-functions.js';
import type { CommandChannel, Dict, PageState, StateBinding, Target } from './provider.js';
import { controlRoles } from './provider.js';

/** The slice of ChromiumProvider the interactive actions (file, download, dialog, visual click) rely on. */
export interface ProviderOps {
  readonly channel: CommandChannel;
  readonly pages: Map<string, PageState>;
  cdp(lease: Lease, method: string, params: unknown, signal: AbortSignal): Promise<Dict>;
  resolveNode(lease: Lease, backendNodeId: number, signal: AbortSignal): Promise<Dict>;
  document(lease: Lease, signal: AbortSignal): Promise<{ frame: Dict; state: PageState }>;
  geometry(lease: Lease, objectId: string, signal: AbortSignal, point?: { x: number; y: number }): Promise<Dict>;
  checkIdentity(lease: Lease, target: Target, signal: AbortSignal, requireFocused?: boolean): Promise<unknown>;
  observe(lease: Lease, signal: AbortSignal): Promise<Observation>;
  result(lease: Lease, expected: any, objectId: string | undefined, signal: AbortSignal, clock: ChangeClock,
    ...rest: any[]): Promise<ProviderResult>;
}

export async function upload(p: ProviderOps, lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'upload' }>,
  execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
  const { signal } = execution;
  const target = p.pages.get(lease.tab)?.byRef.get(action.ref);
  if (!target || target.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Unknown or stale upload target');
  await p.checkIdentity(lease, target, signal);
  const resolved = await p.resolveNode(lease, target.backendId, signal);
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new BrowserError('STALE_TARGET', 'Upload target was removed');
  try {
    const input = await p.cdp(lease, 'Runtime.callFunctionOn', { objectId,
      functionDeclaration: uploadInputFunction,
      returnByValue: true }, signal);
    if (input.exceptionDetails || input.result?.value !== true) {
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Upload requires a connected, enabled <input type=file>');
    }
    execution.onDispatch();
    await p.cdp(lease, 'DOM.setFileInputFiles', { files: action.files, objectId }, signal);
  } finally {
    await p.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
  }
  return await p.result(lease, action.expected, undefined, signal, clock, undefined, stateBinding);
}

export async function choose(p: ProviderOps, lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'choose' }>,
  execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
  const { signal } = execution;
  const target = p.pages.get(lease.tab)?.byRef.get(action.ref);
  if (!target || target.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Unknown or stale choose target');
  if (!controlRoles.has(target.role)) throw new BrowserError('NOT_ACTIONABLE', 'File chooser trigger must be an observed control');
  await p.checkIdentity(lease, target, signal);
  const resolved = await p.resolveNode(lease, target.backendId, signal);
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new BrowserError('STALE_TARGET', 'Choose target was removed');
  let chooserOpened = false;
  const unsubscribe = p.channel.onEvent?.((event, raw) => {
    if (event !== 'fileChooser.opened' || !raw || typeof raw !== 'object') return;
    const value = raw as Dict;
    if (value.tab === lease.tab && value.leaseId === lease.id) { chooserOpened = true; clock.pulse(); }
  });
  try {
    execution.onDispatch();
    await p.cdp(lease, 'Page.setInterceptFileChooserDialog', { enabled: true }, signal);
    let previous: Dict | undefined, previousAt = 0, scrolled = false;
    const geometry = await waitUntil(async () => {
      await p.checkIdentity(lease, target, signal);
      const next = await p.geometry(lease, objectId, signal);
      if (next.inViewport === false && !scrolled) {
        scrolled = true; execution.onDispatch();
        await p.cdp(lease, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendId }, signal);
        previous = undefined; return undefined;
      }
      if (!next.ok) { previous = undefined; return undefined; }
      const stable = previous && sameGeometry(previous, next);
      const now = performance.now();
      if (stable && now - previousAt >= 32) return next;
      if (!stable) { previous = next; previousAt = now; }
      return undefined;
    }, { signal, clock, fallbackMs: 40 });
    await p.checkIdentity(lease, target, signal);
    const finalPoint = await p.geometry(lease, objectId, signal, { x: geometry.x, y: geometry.y });
    if (!finalPoint.ok || !sameGeometry(geometry, finalPoint)) {
      throw new BrowserError('NOT_ACTIONABLE', 'Selected choose point changed before input');
    }
    execution.onDispatch();
    await p.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
    execution.onDispatch();
    await p.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
    try {
      await waitUntil(async () => chooserOpened ? true : undefined, { signal, clock });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'DEADLINE_EXCEEDED') {
        throw new BrowserError('NOT_ACTIONABLE', 'File chooser did not open');
      }
      throw error;
    }
    execution.onDispatch();
    await p.cdp(lease, 'Page.handleFileChooser', { action: 'accept', files: action.files }, signal);
  } finally {
    unsubscribe?.();
    await p.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
  }
  return await p.result(lease, action.expected, undefined, signal, clock, undefined, stateBinding);
}

export async function download(p: ProviderOps, lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'download' }>,
  execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
  const { signal } = execution;
  const target = p.pages.get(lease.tab)?.byRef.get(action.ref);
  if (!target || target.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Unknown or stale download trigger');
  if (!controlRoles.has(target.role)) throw new BrowserError('NOT_ACTIONABLE', 'Download trigger must be an observed control');
  await p.checkIdentity(lease, target, signal);
  const resolved = await p.resolveNode(lease, target.backendId, signal);
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new BrowserError('STALE_TARGET', 'Download trigger was removed');
  let started: { id: number } | undefined;
  let finished: { state: 'complete' | 'interrupted'; filename?: string; receivedBytes?: number; totalBytes?: number; exists?: boolean } | undefined;
  const unsubscribe = p.channel.onEvent?.((event, raw) => {
    if (!raw || typeof raw !== 'object') return;
    const value = raw as Dict;
    if (event === 'download.started' && !started && value.tab === lease.tab && value.leaseId === lease.id
      && Number.isSafeInteger(value.id)) {
      started = { id: value.id };
      clock.pulse();
    } else if (event === 'download.progress' && started && value.id === started.id
      && (value.state === 'complete' || value.state === 'interrupted')) {
      finished = { state: value.state,
        ...(typeof value.filename === 'string' && value.filename ? { filename: value.filename } : {}),
        ...(Number.isSafeInteger(value.receivedBytes) && value.receivedBytes >= 0 ? { receivedBytes: value.receivedBytes } : {}),
        ...(Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0 ? { totalBytes: value.totalBytes } : {}),
        ...(value.exists === false ? { exists: false } : {}) };
      clock.pulse();
    }
  });
  try {
    execution.onDispatch();
    // chrome.debugger rejects browser-level download commands. The extension arms
    // its chrome.downloads observer for exactly this lease, then reports the real
    // DownloadItem id, absolute filename and completion state.
    await p.channel.call('downloads.arm', { lease }, signal);
    let previous: Dict | undefined, previousAt = 0, scrolled = false;
    const geometry = await waitUntil(async () => {
      await p.checkIdentity(lease, target, signal);
      const next = await p.geometry(lease, objectId, signal);
      if (next.inViewport === false && !scrolled) {
        scrolled = true; execution.onDispatch();
        await p.cdp(lease, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendId }, signal);
        previous = undefined; return undefined;
      }
      if (!next.ok) { previous = undefined; return undefined; }
      const stable = previous && sameGeometry(previous, next);
      const now = performance.now();
      if (stable && now - previousAt >= 32) return next;
      if (!stable) { previous = next; previousAt = now; }
      return undefined;
    }, { signal, clock, fallbackMs: 40 });
    await p.checkIdentity(lease, target, signal);
    const finalPoint = await p.geometry(lease, objectId, signal, { x: geometry.x, y: geometry.y });
    if (!finalPoint.ok || !sameGeometry(geometry, finalPoint)) {
      throw new BrowserError('NOT_ACTIONABLE', 'Selected download point changed before input');
    }
    execution.onDispatch();
    await p.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
    execution.onDispatch();
    await p.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
    try {
      await waitUntil(async () => started ? true : undefined, { signal, clock });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'DEADLINE_EXCEEDED') throw new BrowserError('NOT_ACTIONABLE', 'No download started');
      throw error;
    }
    await waitUntil(async () => finished ? true : undefined, { signal, clock });
    if (finished!.state === 'interrupted') throw new BrowserError('NAVIGATION_FAILED', 'Download was interrupted');
    if (finished!.exists === false) throw new BrowserError('NOT_ACTIONABLE', 'Downloaded file is missing');
    if (!finished!.filename) throw new BrowserError('NOT_ACTIONABLE', 'Download filename is unavailable');
    let size: number;
    try { size = (await stat(finished!.filename)).size; }
    catch { throw new BrowserError('NOT_ACTIONABLE', 'Downloaded file is missing'); }
    const evidence: DownloadEvidence = { filename: path.basename(finished!.filename), path: finished!.filename,
      receivedBytes: finished!.receivedBytes ?? size, ...(finished!.totalBytes === undefined ? {} : { totalBytes: finished!.totalBytes }) };
    const observation = action.expected
      ? (await p.result(lease, action.expected, undefined, signal, clock, undefined, stateBinding)).observation
      : await p.observe(lease, signal);
    return { observation, postcondition: 'passed', download: evidence };
  } finally {
    unsubscribe?.();
    await p.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
  }
}

export async function visualClick(p: ProviderOps, lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'visual-click' }>,
  execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
  const { signal } = execution;
  const current = await p.document(lease, signal);
  if (current.state.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Document changed since the screenshot');
  const v = (await p.cdp(lease, 'Page.getLayoutMetrics', {}, signal)).cssVisualViewport;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  if (!v || !near(v.clientWidth, action.viewport.width) || !near(v.clientHeight, action.viewport.height)
    || !near(v.pageX, action.viewport.pageX) || !near(v.pageY, action.viewport.pageY)) {
    throw new BrowserError('STALE_TARGET', 'Viewport scrolled or resized since the screenshot');
  }
  const rootBackend = (await p.cdp(lease, 'DOM.getDocument', { depth: 0, pierce: false }, signal)).root?.backendNodeId;
  const objectId = rootBackend ? (await p.resolveNode(lease, rootBackend, signal)).object?.objectId : undefined;
  if (!objectId) throw new BrowserError('STALE_TARGET', 'Document root is unavailable');
  try {
    const hit = await p.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: visualHitFunction,
      arguments: [{ value: action.point.x }, { value: action.point.y }], returnByValue: true }, signal);
    const value = hit.result?.value;
    if (hit.exceptionDetails || !value?.ok || value.connected !== true || value.disabled === true
      || value.visibility === 'hidden' || value.visibility === 'collapse' || value.pointerEvents === 'none'
      || !(value.rect?.width > 0) || !(value.rect?.height > 0) || !(Number(value.opacity) > 0)) {
      throw new BrowserError('NOT_ACTIONABLE', 'Visual target is not visible or actionable');
    }
    const rect = { x1: value.rect.x, y1: value.rect.y, x2: value.rect.x + value.rect.width, y2: value.rect.y + value.rect.height };
    const overlap = Math.max(0, Math.min(action.box.x2, rect.x2) - Math.max(action.box.x1, rect.x1))
      * Math.max(0, Math.min(action.box.y2, rect.y2) - Math.max(action.box.y1, rect.y1));
    const boxArea = (action.box.x2 - action.box.x1) * (action.box.y2 - action.box.y1);
    const rectArea = (rect.x2 - rect.x1) * (rect.y2 - rect.y1);
    if (overlap <= 0 || overlap / Math.min(boxArea, rectArea) < 0.5) {
      throw new BrowserError('AMBIGUOUS_TARGET', 'Visual target does not overlap the hit element enough');
    }
    if ((await p.document(lease, signal)).state.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Document changed before visual input');
    execution.onDispatch();
    await p.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: action.point.x, y: action.point.y, button: 'left', clickCount: 1 }, signal);
    execution.onDispatch();
    await p.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.point.x, y: action.point.y, button: 'left', clickCount: 1 }, signal);
  } finally {
    await p.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
  }
  const result = await p.result(lease, action.expected, undefined, signal, clock, undefined, stateBinding);
  return { ...result, visual: { screenshotId: action.screenshotId, target: action.target,
    viewportBox: action.box, viewportPoint: action.point } };
}

export async function dialog(p: ProviderOps, lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'dialog' }>,
  execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
  const { signal } = execution;
  let opened: Dict | null = null;
  const unsubscribe = p.channel.onEvent?.((event, raw) => {
    if (event !== 'dialog.opened' || !raw || typeof raw !== 'object') return;
    const value = raw as Dict;
    if (value.tab === lease.tab && value.leaseId === lease.id && typeof value.type === 'string') {
      opened = value; clock.pulse();
    }
  });
  try {
    const pending = await p.channel.call('dialog.pending', { lease }, signal) as Dict | null;
    if (!opened && pending && typeof pending.type === 'string') opened = pending;
    if (!opened) {
      try { await waitUntil(async () => opened ? true : undefined, { signal, clock }); }
      catch (error) {
        if (error instanceof BrowserError && error.code === 'DEADLINE_EXCEEDED') throw new BrowserError('NOT_ACTIONABLE', 'No JavaScript dialog is open');
        throw error;
      }
    }
    execution.onDispatch();
    await p.cdp(lease, 'Page.handleJavaScriptDialog', { accept: action.accept,
      ...(action.accept && action.promptText !== undefined ? { promptText: action.promptText } : {}) }, signal);
    const evidence = { type: opened!.type, message: String(opened!.message ?? ''), accepted: action.accept,
      ...(action.promptText === undefined ? {} : { promptText: action.promptText }) };
    const result = action.expected
      ? await p.result(lease, action.expected, undefined, signal, clock, undefined, stateBinding)
      : { observation: await p.observe(lease, signal), postcondition: 'unverified' as const };
    return { ...result, dialog: evidence };
  } finally { unsubscribe?.(); }
}

