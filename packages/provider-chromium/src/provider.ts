import { randomUUID } from 'node:crypto';
import { BrowserError, checkAbort, originOf, type ActionRequest, type BrowserInstance,
  type BrowserProvider, type Lease, type NodeRef, type Observation, type ProviderExecution, type SemanticQuery,
  type Action, type Expected, type ObservationScope, type ProviderResult, type ScrollEvidence, type ScrollPosition, type Screenshot, type TabSummary } from '../../contracts/src/index.js';
import { scrollDelta, string, semanticQuery } from '../../contracts/src/validation.js';
import { actionDeadline, ChangeClock, waitUntil } from './wait.js';
import { keyEvent } from './keyboard.js';
import { scrollMoved, scrollMovedAsRequested } from '../../contracts/src/scrolling.js';
import { checkedScrollPosition, sameScrollPosition, scrollByFunction, scrollStateFunction } from './scroll.js';
import { checkedFunction, checkedValue } from './checked.js';
import { geometryFunction, sameGeometry } from './actionability.js';

export interface CommandChannel {
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  onEvent?(listener: (event: string, value: unknown) => void): () => void;
}
interface AXNode {
  ignored?: boolean; backendDOMNodeId?: number;
  role?: { value: string }; name?: { value: string }; value?: { value: unknown };
  properties?: Array<{ name: string; value: { value: unknown } }>;
}
type Target = { backendId: number; role: string; name: string; epoch: string; ref: string };
type PageState = { epoch: string; revision: number; byRef: Map<string, Target>; byBackend: Map<number, Target> };
type Dict = Record<string, any>;
const controlRoles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'switch']);
const regionRoles = new Set(['region', 'form', 'group', 'dialog', 'alertdialog', 'main', 'navigation', 'search',
  'complementary', 'banner', 'contentinfo', 'table', 'list', 'tabpanel']);
const maxRetainedRefs = 2048;

const valueFunction = `function() {
  return {connected:this.isConnected,value:this.type!=='password'&&typeof this.value==='string'?this.value:null};
}`;
const selectFunction = `function() {
  if (!this.isConnected || this.disabled || this.readOnly || this.type==='password' || !['INPUT','TEXTAREA'].includes(this.tagName))
    throw new Error('Input is no longer editable');
  this.focus({preventScroll:true});
  if (this.getRootNode().activeElement!==this) return {focused:false};
  this.select();
  return {focused:this.getRootNode().activeElement===this};
}`;
const focusFunction = `function() {
  if (!this.isConnected || this.disabled || this.type==='password' || typeof this.focus!=='function')
    return {focused:false};
  this.focus({preventScroll:true});
  return {focused:this.getRootNode().activeElement===this};
}`;
const focusStateFunction = `function() {
  return {connected:this.isConnected,focused:this.getRootNode().activeElement===this,
    disabled:!!this.disabled,readOnly:!!this.readOnly,type:this.type};
}`;

/** Shared Chromium semantics: brand differences stay in BrowserInstance/installer. */
export class ChromiumProvider implements BrowserProvider {
  private readonly pages = new Map<string, PageState>();
  constructor(readonly instance: BrowserInstance, private readonly channel: CommandChannel) {}

  async listTabs(signal: AbortSignal): Promise<TabSummary[]> {
    return await this.channel.call('tabs.list', {}, signal) as TabSummary[];
  }
  async grant(lease: Lease, signal: AbortSignal): Promise<void> {
    await this.channel.call('lease.grant', { lease }, signal);
  }
  async revoke(lease: Lease): Promise<void> {
    this.pages.delete(lease.tab);
    await this.channel.call('lease.revoke', { lease }, AbortSignal.timeout(3000));
  }
  private async cdp(lease: Lease, method: string, params: unknown, signal: AbortSignal): Promise<Dict> {
    checkAbort(signal);
    return await this.channel.call('cdp', { lease, method, params }, signal) as Dict;
  }
  private async document(lease: Lease, signal: AbortSignal) {
    const result = await this.cdp(lease, 'Page.getFrameTree', {}, signal);
    const frame = result.frameTree?.frame;
    if (!frame?.id || !frame.loaderId || originOf(frame.url) !== lease.origin) {
      throw new BrowserError('POLICY_DENIED', 'Current document is outside the lease');
    }
    const epoch = `${frame.id}:${frame.loaderId}`;
    let state = this.pages.get(lease.tab);
    if (!state || state.epoch !== epoch) {
      state = { epoch, revision: 0, byRef: new Map(), byBackend: new Map() };
      this.pages.set(lease.tab, state);
    }
    return { frame, state };
  }

  async observe(lease: Lease, signal: AbortSignal): Promise<Observation> {
    return this.readObservation(lease, signal, { kind: 'document' });
  }

  async observeSubtree(lease: Lease, rootRef: string, signal: AbortSignal): Promise<Observation> {
    return this.readObservation(lease, signal, { kind: 'subtree', rootRef: string(rootRef, 128) });
  }

  async find(lease: Lease, query: SemanticQuery, signal: AbortSignal, rootRef?: string): Promise<Observation> {
    return this.readObservation(lease, signal, { kind: 'query', query: semanticQuery(query),
      ...(rootRef === undefined ? {} : { rootRef: string(rootRef, 128) }) });
  }

  private async readObservation(lease: Lease, signal: AbortSignal, scope: ObservationScope): Promise<Observation> {
    const { frame, state } = await this.document(lease, signal);
    const rootRef = scope.kind === 'document' ? undefined : scope.rootRef;
    const root = rootRef === undefined ? undefined : state.byRef.get(rootRef);
    if (rootRef !== undefined && (!root || root.epoch !== state.epoch)) throw new BrowserError('STALE_TARGET', 'Unknown or stale observation root');
    if (root) await this.checkAXIdentity(lease, root, signal);
    // Query the known DOM subtree at source; never silently substitute a whole-page read.
    const result = await this.channel.call(scope.kind === 'query' ? 'ax.find' : 'ax.read', { lease, request: { frameId: frame.id,
      ...(scope.kind === 'query' ? { query: scope.query } : {}), ...(root ? { backendNodeId: root.backendId } : {}) } }, signal) as Dict;
    if (root) await this.checkAXIdentity(lease, root, signal);
    const tabs = await this.listTabs(signal);
    const tab = tabs.find(t => t.id === lease.tab);
    if (!tab || originOf(tab.url) !== lease.origin) throw new BrowserError('POLICY_DENIED', 'Page navigated during observation');
    const finalDocument = await this.document(lease, signal);
    if (finalDocument.state.epoch !== state.epoch) throw new BrowserError('STALE_TARGET', 'Document changed during observation');
    const nodes: NodeRef[] = [];
    const text: string[] = [];
    const live = new Set<number>();
    let truncated = result.truncated === true;
    let budget = 0, textBudget = 0, controls = 0, regions = 0;
    for (const node of (result.nodes ?? []) as AXNode[]) {
      if (!node.ignored && node.role?.value === 'StaticText' && node.name?.value?.trim()) {
        const fragment = node.name.value;
        const bytes = Buffer.byteLength(fragment);
        if (text.length < 240 && textBudget + bytes <= 32 * 1024) {
          text.push(fragment); textBudget += bytes;
        } else truncated = true;
      }
      const isRegion = regionRoles.has(node.role?.value ?? '') && !!node.name?.value?.trim();
      if (node.ignored || !node.backendDOMNodeId || !controlRoles.has(node.role?.value ?? '') && !isRegion) continue;
      const backendId = node.backendDOMNodeId, role = node.role!.value, name = node.name?.value ?? '';
      live.add(backendId);
      let target = state.byBackend.get(backendId);
      if (!target || target.role !== role || target.name !== name) {
        if (target) { state.byRef.delete(target.ref); state.byBackend.delete(backendId); }
        target = { backendId, role, name, epoch: state.epoch, ref: randomUUID() };
      }
      const entry: NodeRef = { id: target.ref, role, name: name.slice(0, 1000),
        disabled: node.properties?.some(p => p.name === 'disabled' && p.value.value === true) ?? false,
        ...(isRegion ? { kind: 'region' as const } : {}) };
      const checked = checkedValue(node.properties?.find(p => p.name === 'checked')?.value.value);
      if (checked !== undefined && ['checkbox', 'switch', 'radio'].includes(role)) entry.checked = checked;
      // Never expose password values from AX. Editable values are read only for explicit verification.
      const size = Buffer.byteLength(JSON.stringify(entry));
      if ((isRegion ? regions >= 24 : controls >= 120) || budget + size > 40 * 1024) { truncated = true; continue; }
      budget += size; if (isRegion) regions++; else controls++;
      state.byRef.delete(target.ref); state.byRef.set(target.ref, target); state.byBackend.set(backendId, target);
      // Local reads must not accumulate unlimited identities or evict every displayed
      // control while scanning a huge page. Only emitted refs enter this bounded LRU.
      while (state.byRef.size > maxRetainedRefs) {
        const oldest = state.byRef.values().next().value!;
        state.byRef.delete(oldest.ref); state.byBackend.delete(oldest.backendId);
      }
      nodes.push(entry);
    }
    for (const [backendId, target] of state.byBackend) {
      // Absence from a subtree says nothing about nodes elsewhere on the page.
      if (scope.kind === 'document' && result.truncated !== true && !live.has(backendId)) { state.byBackend.delete(backendId); state.byRef.delete(target.ref); }
    }
    return { tab: lease.tab, url: tab.url, title: tab.title, documentEpoch: state.epoch,
      revision: ++state.revision, nodes, text, truncated, scope };
  }

  async capture(lease: Lease, signal: AbortSignal): Promise<Screenshot> {
    const deadline = actionDeadline(signal);
    const clock = new ChangeClock();
    const unsubscribe = this.channel.onEvent?.((event, raw) => {
      const value = raw as Dict | undefined;
      if (event === 'page.changed' && value?.tab === lease.tab && value?.leaseId === lease.id) clock.pulse();
    });
    try {
      // Capturing is read-only. A changed viewport invalidates that image, not the
      // whole user request; retry under one deadline and never return stale pixels.
      return await waitUntil(async () => {
        try { return await this.captureOnce(lease, deadline.signal); }
        catch (error) { if (error instanceof BrowserError && error.code === 'STALE_TARGET') return undefined; throw error; }
      }, { signal: deadline.signal, clock, fallbackMs: 60 });
    } finally { unsubscribe?.(); deadline.dispose(); }
  }

  private async captureOnce(lease: Lease, signal: AbortSignal): Promise<Screenshot> {
    const before = await this.document(lease, signal);
    const tree = await this.cdp(lease, 'Page.getFrameTree', {}, signal);
    const checkFrames = (item: Dict): void => {
      if (originOf(item.frame?.url ?? '') !== lease.origin) throw new BrowserError('POLICY_DENIED', 'Screenshot contains an unapproved frame');
      for (const child of item.childFrames ?? []) checkFrames(child);
    };
    checkFrames(tree.frameTree);
    const metrics = await this.cdp(lease, 'Page.getLayoutMetrics', {}, signal);
    const v = metrics.cssVisualViewport;
    if (!v || v.clientWidth < 1 || v.clientHeight < 1) throw new BrowserError('NOT_ACTIONABLE', 'Viewport unavailable');
    const viewport = { width: v.clientWidth, height: v.clientHeight, pageX: v.pageX, pageY: v.pageY };
    const image = await this.cdp(lease, 'Page.captureScreenshot', { format: 'jpeg', quality: 70,
      captureBeyondViewport: false, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight,
        scale: Math.min(1, 1200 / v.clientWidth) } }, signal);
    if (typeof image.data !== 'string' || image.data.length > 800_000) throw new BrowserError('QUEUE_FULL', 'Screenshot exceeds preview transport budget');
    const after = await this.document(lease, signal);
    checkFrames((await this.cdp(lease, 'Page.getFrameTree', {}, signal)).frameTree);
    const afterViewport = (await this.cdp(lease, 'Page.getLayoutMetrics', {}, signal)).cssVisualViewport;
    if (before.state.epoch !== after.state.epoch || JSON.stringify(v) !== JSON.stringify(afterViewport)) {
      throw new BrowserError('STALE_TARGET', 'Viewport changed during capture');
    }
    return { tab: lease.tab, documentEpoch: after.state.epoch, capturedAt: Date.now(), mimeType: 'image/jpeg', data: image.data, viewport };
  }

  private async geometry(lease: Lease, objectId: string, signal: AbortSignal, point?: { x: number; y: number }): Promise<Dict> {
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration: geometryFunction, returnByValue: true,
      ...(point ? { arguments: [{ value: { x: point.x, y: point.y } }] } : {}),
    }, signal);
    if (result.exceptionDetails || !result.result?.value || result.result.value.connected === false) {
      throw new BrowserError('STALE_TARGET', 'Target was removed during actionability checks');
    }
    return result.result.value;
  }

  private async checkIdentity(lease: Lease, target: Target, signal: AbortSignal, requireFocused = false): Promise<AXNode> {
    const { state } = await this.document(lease, signal);
    if (state.epoch !== target.epoch) throw new BrowserError('STALE_TARGET', 'Document changed before input');
    return this.checkAXIdentity(lease, target, signal, requireFocused);
  }

  private async checkAXIdentity(lease: Lease, target: Target, signal: AbortSignal, requireFocused = false): Promise<AXNode> {
    const result = await this.cdp(lease, 'Accessibility.getPartialAXTree', { backendNodeId: target.backendId, fetchRelatives: false }, signal);
    const node = (result.nodes as AXNode[] | undefined)?.find(n => n.backendDOMNodeId === target.backendId);
    if (!node || node.ignored || node.role?.value !== target.role || (node.name?.value ?? '') !== target.name) {
      throw new BrowserError('STALE_TARGET', 'Target semantic identity changed while waiting');
    }
    if (requireFocused && !node.properties?.some(property => property.name === 'focused' && property.value.value === true)) {
      throw new BrowserError('NOT_ACTIONABLE', 'Browser accessibility state does not confirm target focus');
    }
    return node;
  }

  private async readChecked(lease: Lease, target: Target, objectId: string, signal: AbortSignal) {
    await this.checkIdentity(lease, target, signal);
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: checkedFunction, returnByValue: true }, signal);
    const state = result.result?.value;
    if (result.exceptionDetails || state?.connected !== true) throw new BrowserError('STALE_TARGET', 'Checked target disappeared');
    const checked = checkedValue(state.checked);
    if (checked === undefined) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Target has no supported checkbox state');
    const node = await this.checkIdentity(lease, target, signal);
    const ax = checkedValue(node.properties?.find(p => p.name === 'checked')?.value.value);
    // AX can lag a renderer update; wait for agreement, never infer a toggle from disagreement.
    return ax === checked ? { checked } : undefined;
  }

  private async checkedResult(lease: Lease, target: Target, objectId: string,
    action: Extract<Action, { kind: 'check' }>, signal: AbortSignal, clock: ChangeClock): Promise<ProviderResult> {
    await waitUntil(async () => (await this.readChecked(lease, target, objectId, signal))?.checked === action.checked ? true : undefined, { signal, clock });
    const result = await this.result(lease, action.expected, objectId, signal, clock);
    if ((await this.readChecked(lease, target, objectId, signal))?.checked !== action.checked) {
      throw new BrowserError('STALE_TARGET', 'Checked state changed during result observation');
    }
    return { ...result, postcondition: 'passed' };
  }

  private async checkFocus(lease: Lease, objectId: string, signal: AbortSignal, editable = false): Promise<void> {
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: focusStateFunction, returnByValue: true }, signal);
    const state = result.result?.value;
    if (result.exceptionDetails || !state?.connected || state.focused !== true || state.disabled || state.type === 'password'
      || editable && state.readOnly) {
      throw new BrowserError('NOT_ACTIONABLE', 'Target no longer owns editable keyboard focus');
    }
  }

  private async result(lease: Lease, expected: Expected | undefined, objectId: string | undefined,
    signal: AbortSignal, clock: ChangeClock, navigationLoader?: string): Promise<ProviderResult> {
    if (!expected) return { observation: await this.observe(lease, signal), postcondition: 'unverified' };
    const observation = await waitUntil(async () => {
      const document = await this.document(lease, signal); // Check actual origin on every predicate iteration.
      // Page.navigate can return before commit. Never verify against the outgoing page.
      if (navigationLoader && document.frame.loaderId !== navigationLoader) return undefined;
      if (navigationLoader || expected.kind === 'url') {
        const ready = await this.cdp(lease, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, signal);
        if (!['interactive', 'complete'].includes(ready.result?.value)) return undefined;
      }
      if (expected.kind === 'value') {
        if (!objectId) throw new BrowserError('INVALID_REQUEST', 'Value expectations require an element target');
        const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: valueFunction, returnByValue: true }, signal);
        if (result.exceptionDetails || result.result?.value?.connected === false) throw new BrowserError('STALE_TARGET', 'Input disappeared before its value was verified');
        if (result.result?.value?.value !== expected.value) return undefined;
      }
      if (expected.kind === 'url') {
        const tab = (await this.listTabs(signal)).find(t => t.id === lease.tab);
        if (tab?.url !== expected.url) return undefined;
      }
      const observation = await this.observe(lease, signal);
      if (observation.documentEpoch !== document.state.epoch) return undefined;
      if (expected.kind === 'url' && observation.url !== expected.url) return undefined;
      if (expected.kind === 'text' && !observation.text.join(' ').replace(/\s+/g, ' ')
        .includes(expected.text.replace(/\s+/g, ' '))) return undefined;
      return observation;
    }, { signal, clock });
    return { observation, postcondition: 'passed' };
  }

  private async scroll(lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'scroll' }>,
    execution: ProviderExecution, clock: ChangeClock): Promise<ProviderResult> {
    const { signal } = execution, requested = scrollDelta(action);
    if (action.expected?.kind === 'value') throw new BrowserError('INVALID_REQUEST', 'Scroll cannot verify an input value');
    const { state } = await this.document(lease, signal);
    if (state.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Document changed before scrolling');
    const target = action.ref === undefined ? undefined : state.byRef.get(action.ref);
    if (action.ref !== undefined && (!target || target.epoch !== request.documentEpoch)) throw new BrowserError('STALE_TARGET', 'Unknown or stale scroll target');
    const identity = async () => {
      if ((await this.document(lease, signal)).state.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Document changed during scrolling');
      if (target) await this.checkAXIdentity(lease, target, signal);
    };
    await identity();
    const backendId = target?.backendId ?? (await this.cdp(lease, 'DOM.getDocument', { depth: 0, pierce: false }, signal)).root?.backendNodeId;
    if (!backendId) throw new BrowserError('STALE_TARGET', 'Document scroll root is unavailable');
    const objectId = (await this.cdp(lease, 'DOM.resolveNode', { backendNodeId: backendId }, signal)).object?.objectId;
    if (!objectId) throw new BrowserError('STALE_TARGET', 'Scroll target is unavailable');
    try {
      const read = async () => {
        await identity();
        return checkedScrollPosition(await this.cdp(lease, 'Runtime.callFunctionOn', { objectId,
          functionDeclaration: scrollStateFunction, returnByValue: true }, signal));
      };
      const before = await read();
      await identity();
      execution.onDispatch();
      const dispatched = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: scrollByFunction,
        arguments: [{ value: requested.deltaX }, { value: requested.deltaY }] }, signal);
      if (dispatched.exceptionDetails) throw new BrowserError('NOT_ACTIONABLE', 'Scroll command failed');
      let previous: ScrollPosition | undefined, previousAt = 0;
      const after = await waitUntil(async () => {
        const position = await read(), now = performance.now();
        if (previous && sameScrollPosition(previous, position) && now - previousAt >= 50) return position;
        if (!previous || !sameScrollPosition(previous, position)) { previous = position; previousAt = now; }
        return undefined;
      }, { signal, clock, fallbackMs: 40 });
      const scroll: ScrollEvidence = { target: target ? { kind: 'element', ref: target.ref } : { kind: 'document' },
        requested, before, after, moved: scrollMoved(before, after) };
      const result = await this.result(lease, action.expected, undefined, signal, clock);
      if (!sameScrollPosition(after, await read())) throw new BrowserError('STALE_TARGET', 'Scroll position changed during result observation');
      return { ...result, scroll, postcondition: scrollMovedAsRequested(scroll)
        ? action.expected ? result.postcondition : 'passed' : 'unverified' };
    } finally {
      await this.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
    }
  }

  async act(lease: Lease, request: ActionRequest, execution: ProviderExecution): Promise<ProviderResult> {
    const deadline = actionDeadline(execution.signal, request.timeoutMs);
    const signal = deadline.signal, clock = new ChangeClock(), action = request.action;
    const unsubscribe = this.channel.onEvent?.((event, raw) => {
      if (event !== 'page.changed' || !raw || typeof raw !== 'object') return;
      const value = raw as Dict;
      if (value.tab === lease.tab && value.leaseId === lease.id) clock.pulse();
    });
    let objectId: string | undefined;
    try {
      if (action.kind === 'scroll') return await this.scroll(lease, request, action, { signal, onDispatch: () => execution.onDispatch() }, clock);
      const down = action.kind === 'press' ? keyEvent(action.key, action.shift ?? false, 'keyDown') : undefined;
      if (action.kind === 'navigate') {
        if (originOf(action.url) !== lease.origin) throw new BrowserError('POLICY_DENIED', 'Navigation requires a lease for its exact origin');
        const url = new URL(action.url).href;
        if (action.expected?.kind === 'value') throw new BrowserError('INVALID_REQUEST', 'Navigation cannot verify an input value');
        if ((await this.document(lease, signal)).state.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Document changed before navigation');
        execution.onDispatch();
        const navigation = await this.cdp(lease, 'Page.navigate', { url }, signal);
        if (navigation.errorText || navigation.isDownload) throw new BrowserError('NAVIGATION_FAILED', 'Navigation failed or became a download');
        return await this.result(lease, action.expected ?? { kind: 'url', url }, undefined, signal, clock, navigation.loaderId);
      }
      const original = this.pages.get(lease.tab)?.byRef.get(action.ref);
      if (!original || original.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Unknown or stale target');
      if (!controlRoles.has(original.role)) throw new BrowserError('NOT_ACTIONABLE', 'Observation regions are not input targets');
      await this.checkIdentity(lease, original, signal);
      const current = this.pages.get(lease.tab)!.byRef.get(action.ref);
      if (!current || current.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Target identity changed');
      if (action.kind === 'check' && (!['checkbox', 'switch'].includes(current.role) || typeof action.checked !== 'boolean' || action.expected?.kind === 'value')) {
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Check requires a checkbox/switch and boolean desired state');
      }
      const resolved = await this.cdp(lease, 'DOM.resolveNode', { backendNodeId: current.backendId }, signal);
      objectId = resolved.object?.objectId;
      if (!objectId) throw new BrowserError('STALE_TARGET', 'Target was removed');
      const targetObject = objectId;
      if (action.kind === 'check') {
        const state = await waitUntil(() => this.readChecked(lease, current, targetObject, signal), { signal, clock });
        if (state.checked === action.checked) return await this.checkedResult(lease, current, targetObject, action, signal, clock);
      }
      let previous: Dict | undefined, previousAt = 0, scrolled = false;
      const geometry = await waitUntil(async () => {
        await this.checkIdentity(lease, current, signal);
        const next = await this.geometry(lease, targetObject, signal);
        if (next.inViewport === false && !scrolled) {
          scrolled = true; execution.onDispatch();
          await this.cdp(lease, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: current.backendId }, signal);
          previous = undefined; return undefined;
        }
        if (!next.ok) { previous = undefined; return undefined; }
        const stable = previous && sameGeometry(previous, next);
        const now = performance.now();
        if (stable && now - previousAt >= 32) return next;
        if (!stable) { previous = next; previousAt = now; }
        return undefined;
      }, { signal, clock, fallbackMs: 40 });
      // A final target check happens after waiting; similarly named replacements never inherit the ref.
      await this.checkIdentity(lease, current, signal);
      if (action.kind === 'fill') {
        if (current.role !== 'textbox' || !['INPUT', 'TEXTAREA'].includes(geometry.tag) || geometry.readOnly || geometry.type === 'password') {
          throw new BrowserError('UNSUPPORTED_CAPABILITY', 'This input type is not supported by the initial fill implementation');
        }
        execution.onDispatch();
        const selection = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: selectFunction, returnByValue: true }, signal);
        if (selection.exceptionDetails || selection.result?.value?.focused !== true) throw new BrowserError('NOT_ACTIONABLE', 'Input changed or lost focus during selection');
        await this.checkIdentity(lease, current, signal, true);
        await this.checkFocus(lease, objectId, signal, true);
        execution.onDispatch();
        if (action.text === '') {
          await this.cdp(lease, 'Input.dispatchKeyEvent', keyEvent('Backspace', false, 'keyDown'), signal);
          execution.onDispatch();
          await this.cdp(lease, 'Input.dispatchKeyEvent', keyEvent('Backspace', false, 'keyUp'), signal);
        } else await this.cdp(lease, 'Input.insertText', { text: action.text }, signal);
      } else if (action.kind === 'press') {
        if (geometry.type === 'password') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Keyboard input on password fields is not supported');
        execution.onDispatch();
        const focus = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: focusFunction, returnByValue: true }, signal);
        if (focus.exceptionDetails || focus.result?.value?.focused !== true) throw new BrowserError('NOT_ACTIONABLE', 'Target did not acquire keyboard focus');
        await this.checkIdentity(lease, current, signal, true);
        await this.checkFocus(lease, objectId, signal);
        execution.onDispatch();
        await this.cdp(lease, 'Input.dispatchKeyEvent', down!, signal);
        execution.onDispatch();
        await this.cdp(lease, 'Input.dispatchKeyEvent', keyEvent(action.key, action.shift ?? false, 'keyUp'), signal);
      } else {
        const needsClick = action.kind !== 'check' ||
          (await waitUntil(() => this.readChecked(lease, current, targetObject, signal), { signal, clock })).checked !== action.checked;
        if (needsClick) {
          const finalPoint = await this.geometry(lease, objectId, signal, { x: geometry.x, y: geometry.y });
          if (!finalPoint.ok || !sameGeometry(geometry, finalPoint)) {
            throw new BrowserError('NOT_ACTIONABLE', 'Selected click point changed before input');
          }
          execution.onDispatch();
          await this.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
          execution.onDispatch();
          await this.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
        }
      }
      if (action.kind === 'check') return await this.checkedResult(lease, current, targetObject, action, signal, clock);
      return await this.result(lease, action.expected ?? (action.kind === 'fill' ? { kind: 'value', value: action.text } : undefined), objectId, signal, clock);
    } finally {
      unsubscribe?.(); deadline.dispose();
      // Release is cleanup only; it must not hide the authoritative action outcome.
      if (objectId) await this.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
    }
  }
}
