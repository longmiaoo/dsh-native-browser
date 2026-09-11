import { randomUUID } from 'node:crypto';
import { BrowserError, checkAbort, originOf, type ActionRequest, type BrowserInstance,
  type BrowserProvider, type Lease, type NodeRef, type Observation, type ProviderExecution, type SemanticQuery,
  type Action, type Expected, type ObservationScope, type ProviderResult, type ScrollEvidence, type ScrollPosition, type Screenshot, type TabSummary } from '../../contracts/src/index.js';
import { actionRequest, scrollDelta, string, semanticQuery, pageReadOptions, frameTarget } from '../../contracts/src/validation.js';
import type { PageReadOptions, ObservationPage, FrameTarget } from '../../contracts/src/index.js';
import { actionDeadline, ChangeClock, waitUntil } from './wait.js';
import { keyEvent } from './keyboard.js';
import { wheelEvent } from './mouse.js';
import { scrollMoved, scrollMovedAsRequested } from '../../contracts/src/scrolling.js';
import { checkedScrollPosition, sameScrollPosition, scrollByFunction, scrollStateFunction } from './scroll.js';
import { checkedFunction, checkedValue, checkedLabelFunction, checkedLabelBindingFunction, radioBindingFunction, radioBindingCheckFunction } from './checked.js';
import { geometryFunction, sameGeometry } from './actionability.js';
import { editableFunction } from './editable.js';
import { nativeTextFunction } from './text-input.js';
import { elementStateFunction } from './element-state.js';
import type { SourceFrame } from './frame-sessions.js';
import type { FrameReadBinding } from './frame-read.js';
import { frameInventory, sameOriginFrame } from '../../contracts/src/frames.js';

export interface CommandChannel {
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  onEvent?(listener: (event: string, value: unknown) => void): () => void;
}
interface AXNode {
  ignored?: boolean; backendDOMNodeId?: number;
  role?: { value: string }; name?: { value: string }; value?: { value: unknown };
  properties?: Array<{ name: string; value: { value: unknown } }>;
}
type Target = { backendId: number; role: string; name: string; epoch: string; ref: string; editable?: boolean };
type NodeState = { epoch: string; revision: number; byRef: Map<string, Target>; byBackend: Map<number, Target> };
type FrameRef = { ref: string; key: string; epoch: string; source: SourceFrame };
type PageState = NodeState & { frameRefs: Map<string, FrameRef>; childPages: Map<string, NodeState> };
type Dict = Record<string, any>;
type StateBinding = { objectId: string; epoch: string; ref: string };
const controlRoles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'switch']);
const regionRoles = new Set(['region', 'form', 'group', 'dialog', 'alertdialog', 'main', 'navigation', 'search',
  'complementary', 'banner', 'contentinfo', 'table', 'list', 'tabpanel']);
const maxRetainedRefs = 2048;
const isGenericEditor = (node: AXNode) => node.role?.value === 'generic'
  && node.properties?.some(p => p.name === 'focusable' && p.value.value === true) === true
  && node.properties?.some(p => p.name === 'editable' && (p.value.value === 'plaintext' || p.value.value === 'richtext')) === true;

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
      state = { epoch, revision: 0, byRef: new Map(), byBackend: new Map(), frameRefs: new Map(), childPages: new Map() };
      this.pages.set(lease.tab, state);
    }
    return { frame, state };
  }

  async observe(lease: Lease, signal: AbortSignal): Promise<Observation> {
    return this.readObservation(lease, signal, { kind: 'document' });
  }

  async frames(lease: Lease, signal: AbortSignal) {
    const { frame, state } = await this.document(lease, signal);
    const result = await this.channel.call('frames.list', { lease }, signal) as { frames: SourceFrame[]; truncated: boolean };
    const valid = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 128;
    if (!result || !Array.isArray(result.frames) || !result.frames.length || result.frames.length > 256
      || typeof result.truncated !== 'boolean' || result.frames.some(item => !item || !valid(item.frameId)
        || item.parentId !== undefined && !valid(item.parentId) || item.loaderId !== undefined && !valid(item.loaderId)
        || item.sessionId !== undefined && (typeof item.sessionId !== 'string' || item.sessionId.length > 128)
        || item.context !== undefined && (!item.context || !Number.isSafeInteger(item.context.id) || item.context.id <= 0
          || item.sessionId === undefined || item.context.uniqueId !== undefined && !valid(item.context.uniqueId)))
      || new Set(result.frames.map(item => item.frameId)).size !== result.frames.length)
      throw new BrowserError('INVALID_REQUEST', 'Invalid source frame graph');
    const final = await this.document(lease, signal); checkAbort(signal);
    if (state !== final.state) throw new BrowserError('STALE_TARGET', 'Document changed during frame discovery');
    const roots = result.frames.filter(item => item.parentId === undefined);
    if (roots.length !== 1 || roots[0]!.frameId !== frame.id || roots[0]!.loaderId !== frame.loaderId)
      throw new BrowserError('STALE_TARGET', 'Frame root changed during discovery');
    const refs = new Map<string, FrameRef>();
    for (const item of result.frames) {
      const old = state.frameRefs.get(item.frameId);
      const key = JSON.stringify([item.loaderId, item.sessionId, item.context?.uniqueId ?? item.context?.id]);
      refs.set(item.frameId, { ref: old?.ref ?? 'frame-' + randomUUID(), key, source: { frameId: item.frameId,
        ...(item.parentId === undefined ? {} : { parentId: item.parentId }), ...(item.loaderId === undefined ? {} : { loaderId: item.loaderId }),
        ...(item.origin === undefined ? {} : { origin: item.origin }), ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
        ...(item.context === undefined ? {} : { context: { id: item.context.id, ...(item.context.uniqueId === undefined ? {} : { uniqueId: item.context.uniqueId }) } }) },
        epoch: old?.key === key ? old.epoch : randomUUID() });
    }
    const inventory = frameInventory({ tab: lease.tab, documentEpoch: state.epoch, truncated: result.truncated,
      frames: result.frames.map(item => {
        const ref = refs.get(item.frameId)!;
        if (item.parentId !== undefined && !refs.has(item.parentId)) throw new BrowserError('STALE_TARGET', 'Frame parent disappeared');
        return { id: ref.ref, isMain: item.frameId === frame.id,
          ...(item.parentId === undefined ? {} : { parentId: refs.get(item.parentId)!.ref }),
          ...(item.frameId === frame.id ? { documentEpoch: state.epoch } : item.loaderId ? { documentEpoch: ref.epoch } : {}),
          ...(item.origin === undefined ? {} : { origin: item.origin }),
          originRelation: 'opaque', contextStatus: item.context ? 'known' : 'unavailable' };
      }) }, lease);
    // Commit only validated metadata, then purge child caches whose documents
    // disappeared or changed. The root node-ref cache is unaffected.
    state.frameRefs = refs;
    for (const [id, child] of state.childPages) {
      const current = [...refs.values()].find(item => item.ref === id);
      if (!current || current.epoch !== child.epoch) state.childPages.delete(id);
    }
    return inventory;
  }

  async observeFrame(lease: Lease, raw: FrameTarget, signal: AbortSignal): Promise<Observation> {
    const frame = frameTarget(raw);
    return this.readObservation(lease, signal, { kind: 'frame', frameId: frame.frameId }, undefined, frame);
  }

  async findFrame(lease: Lease, raw: FrameTarget, query: SemanticQuery, signal: AbortSignal, rootRef?: string): Promise<Observation> {
    const frame = frameTarget(raw);
    return this.readObservation(lease, signal, { kind: 'query', frameId: frame.frameId, query: semanticQuery(query),
      ...(rootRef === undefined ? {} : { rootRef: string(rootRef, 128) }) }, undefined, frame);
  }

  async observeFrameSubtree(lease: Lease, raw: FrameTarget, rootRef: string, signal: AbortSignal): Promise<Observation> {
    const frame = frameTarget(raw);
    return this.readObservation(lease, signal, { kind: 'subtree', frameId: frame.frameId, rootRef: string(rootRef, 128) }, undefined, frame);
  }

  async observeSubtree(lease: Lease, rootRef: string, signal: AbortSignal): Promise<Observation> {
    return this.readObservation(lease, signal, { kind: 'subtree', rootRef: string(rootRef, 128) });
  }

  async find(lease: Lease, query: SemanticQuery, signal: AbortSignal, rootRef?: string): Promise<Observation> {
    return this.readObservation(lease, signal, { kind: 'query', query: semanticQuery(query),
      ...(rootRef === undefined ? {} : { rootRef: string(rootRef, 128) }) });
  }

  async readPage(lease: Lease, raw: PageReadOptions, signal: AbortSignal): Promise<ObservationPage> {
    const options = pageReadOptions(raw);
    return await this.readObservation(lease, signal, options.rootRef === undefined ? { kind: 'document' }
      : { kind: 'subtree', rootRef: options.rootRef }, options) as ObservationPage;
  }

  private async readObservation(lease: Lease, signal: AbortSignal, scope: ObservationScope, pageOptions?: PageReadOptions, childTarget?: FrameTarget): Promise<Observation> {
    const { frame, state: pageState } = await this.document(lease, signal);
    let state: NodeState = pageState, binding: FrameReadBinding | undefined;
    if (childTarget) {
      const target = [...pageState.frameRefs.values()].find(item => item.ref === childTarget.frameId);
      if (!target || target.epoch !== childTarget.documentEpoch) throw new BrowserError('STALE_TARGET', 'Unknown or stale child document');
      const source = target.source;
      if (source.frameId === frame.id) throw new BrowserError('INVALID_REQUEST', 'Use the root observation path');
      if (!source.loaderId || !source.context?.uniqueId) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Frame needs a unique default context identity');
      binding = { frameId: source.frameId, loaderId: source.loaderId, contextUniqueId: source.context.uniqueId,
        rootFrameId: frame.id, rootLoaderId: frame.loaderId };
      state = pageState.childPages.get(target.ref) ?? { epoch: target.epoch, revision: 0, byRef: new Map(), byBackend: new Map() };
      if (state.epoch !== target.epoch) throw new BrowserError('STALE_TARGET', 'Frame node cache belongs to another document');
    }
    const rootRef = scope.kind === 'subtree' || scope.kind === 'query' ? scope.rootRef : undefined;
    const root = rootRef === undefined ? undefined : state.byRef.get(rootRef);
    if (rootRef !== undefined && (!root || root.epoch !== state.epoch)) throw new BrowserError('STALE_TARGET', 'Unknown or stale observation root');
    if (root && !binding) await this.checkAXIdentity(lease, root, signal);
    if (root && binding && root.name.length > 1000) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Child observation root name exceeds binding limit');
    // An explicitly revalidated paging root stays live while newer window refs
    // rotate through the bounded LRU; this never resurrects an already-lost ref.
    if (root && pageOptions) { state.byRef.delete(root.ref); state.byRef.set(root.ref, root); }
    // Query the known DOM subtree at source; never silently substitute a whole-page read.
    const childRoot = root ? { root: { backendNodeId: root.backendId, role: root.role, name: root.name, editable: !!root.editable } } : {};
    const result = await this.channel.call(binding ? scope.kind === 'query' ? 'ax.frame.find' : root ? 'ax.frame.subtree' : 'ax.frame' : pageOptions ? 'ax.page' : scope.kind === 'query' ? 'ax.find' : 'ax.read', binding ? scope.kind === 'query' ? { lease, request: { binding, query: scope.query, ...childRoot } } : root ? { lease, request: { binding, ...childRoot } } : { lease, binding } : { lease, request: { frameId: frame.id,
      ...(scope.kind === 'query' ? { query: scope.query } : {}), ...(root ? { backendNodeId: root.backendId } : {}),
      ...(pageOptions?.continuation === undefined ? {} : { continuation: pageOptions.continuation }) } }, signal) as Dict;
    if (pageOptions && (!result.page || !Number.isSafeInteger(result.page.index) || result.page.index < 0
      || typeof result.page.incomplete !== 'boolean' || result.page.continuation !== undefined &&
      (typeof result.page.continuation !== 'string' || !result.page.continuation || result.page.continuation.length > 128)))
      throw new BrowserError('INVALID_REQUEST', 'Invalid provider page metadata');
    if (root && !binding) await this.checkAXIdentity(lease, root, signal);
    const tabs = await this.listTabs(signal);
    const tab = tabs.find(t => t.id === lease.tab);
    if (!tab || originOf(tab.url) !== lease.origin) throw new BrowserError('POLICY_DENIED', 'Page navigated during observation');
    const finalDocument = await this.document(lease, signal);
    if (finalDocument.state !== pageState) throw new BrowserError('STALE_TARGET', 'Document changed during observation');
    if (childTarget) {
      // A completed source read is followed by fresh frame metadata before
      // publishing. Never let late navigation revive an old child cache.
      const inventory = await this.frames(lease, signal);
      sameOriginFrame(inventory, childTarget, lease);
      pageState.childPages.delete(childTarget.frameId); pageState.childPages.set(childTarget.frameId, state);
      while (pageState.childPages.size > 8) pageState.childPages.delete(pageState.childPages.keys().next().value!);
    }
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
      const editable = isGenericEditor(node);
      if (node.ignored || !node.backendDOMNodeId || !controlRoles.has(node.role?.value ?? '') && !isRegion && !editable) continue;
      const backendId = node.backendDOMNodeId, role = node.role!.value, name = node.name?.value ?? '';
      live.add(backendId);
      let target = state.byBackend.get(backendId);
      if (!target || target.role !== role || target.name !== name || !!target.editable !== editable) {
        if (target) { state.byRef.delete(target.ref); state.byBackend.delete(backendId); }
        target = { backendId, role, name, epoch: state.epoch, ref: randomUUID(), ...(editable ? { editable: true } : {}) };
      }
      const entry: NodeRef = { id: target.ref, role, name: name.slice(0, 1000),
        disabled: node.properties?.some(p => p.name === 'disabled' && p.value.value === true) ?? false,
        ...(editable ? { editable: true } : {}),
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
      if (!pageOptions && (scope.kind === 'document' || scope.kind === 'frame') && result.truncated !== true && !live.has(backendId)) { state.byBackend.delete(backendId); state.byRef.delete(target.ref); }
    }
    return { tab: lease.tab, url: tab.url, title: tab.title, documentEpoch: state.epoch,
      revision: ++state.revision, nodes, text, truncated, scope,
      ...(pageOptions ? { page: { index: result.page.index, incomplete: result.page.incomplete,
        ...(result.page.continuation === undefined ? {} : { continuation: result.page.continuation }) } } : {}) };
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
    if (!node || node.ignored || node.role?.value !== target.role || (node.name?.value ?? '') !== target.name
      || !!target.editable !== isGenericEditor(node)) {
      throw new BrowserError('STALE_TARGET', 'Target semantic identity changed while waiting');
    }
    if (requireFocused && !node.properties?.some(property => property.name === 'focused' && property.value.value === true)) {
      throw new BrowserError('NOT_ACTIONABLE', 'Browser accessibility state does not confirm target focus');
    }
    return node;
  }

  private async checkRadioBinding(lease: Lease, objectId: string, binding: string | undefined, signal: AbortSignal) {
    if (!binding) return;
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId,
      functionDeclaration: radioBindingCheckFunction, arguments: [{ objectId: binding }], returnByValue: true }, signal);
    if (result.exceptionDetails || result.result?.value !== true) {
      throw new BrowserError('STALE_TARGET', 'Radio type, tree, form, name or value changed during selection');
    }
  }

  private async readChecked(lease: Lease, target: Target, objectId: string, signal: AbortSignal, radioBinding?: string) {
    await this.checkIdentity(lease, target, signal);
    await this.checkRadioBinding(lease, objectId, radioBinding, signal);
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: checkedFunction, returnByValue: true }, signal);
    const state = result.result?.value;
    if (result.exceptionDetails || state?.connected !== true) throw new BrowserError('STALE_TARGET', 'Checked target disappeared');
    const checked = checkedValue(state.checked);
    if (checked === undefined || state.nativeRadio === true && !radioBinding) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Target has no supported checked state');
    const node = await this.checkIdentity(lease, target, signal);
    await this.checkRadioBinding(lease, objectId, radioBinding, signal);
    const ax = checkedValue(node.properties?.find(p => p.name === 'checked')?.value.value);
    // AX can lag a renderer update; wait for agreement, never infer a toggle from disagreement.
    return ax === checked ? { checked } : undefined;
  }

  private async checkedResult(lease: Lease, target: Target, objectId: string,
    action: Extract<Action, { kind: 'check' }>, signal: AbortSignal, clock: ChangeClock, radioBinding?: string, stateBinding?: StateBinding): Promise<ProviderResult> {
    await waitUntil(async () => (await this.readChecked(lease, target, objectId, signal, radioBinding))?.checked === action.checked ? true : undefined, { signal, clock });
    const result = await this.result(lease, action.expected, objectId, signal, clock, undefined, stateBinding);
    if ((await this.readChecked(lease, target, objectId, signal, radioBinding))?.checked !== action.checked) {
      throw new BrowserError('STALE_TARGET', 'Checked state changed during result observation');
    }
    return { ...result, postcondition: 'passed' };
  }

  private async checkLabelBinding(lease: Lease, labelObject: string, inputObject: string, signal: AbortSignal): Promise<void> {
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId: labelObject,
      functionDeclaration: checkedLabelBindingFunction, arguments: [{ objectId: inputObject }], returnByValue: true }, signal);
    if (result.exceptionDetails || result.result?.value !== true) {
      throw new BrowserError('STALE_TARGET', 'Checked control label association or enabled state changed');
    }
  }

  private async checkFocus(lease: Lease, objectId: string, signal: AbortSignal, editable = false): Promise<void> {
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: focusStateFunction, returnByValue: true }, signal);
    const state = result.result?.value;
    if (result.exceptionDetails || !state?.connected || state.focused !== true || state.disabled || state.type === 'password'
      || editable && state.readOnly) {
      throw new BrowserError('NOT_ACTIONABLE', 'Target no longer owns editable keyboard focus');
    }
  }

  private async editorState(lease: Lease, objectId: string, mode: 'inspect' | 'select' | 'selection' | 'value' | 'append-end' | 'append-position', signal: AbortSignal): Promise<Dict> {
    const result = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId,
      functionDeclaration: editableFunction, arguments: [{ value: mode }], returnByValue: true }, signal);
    checkAbort(signal);
    if (result.exceptionDetails || result.result?.value?.connected !== true) throw new BrowserError('STALE_TARGET', 'Editor disappeared');
    return result.result.value;
  }

  private async append(lease: Lease, target: Target, objectId: string, geometry: Dict,
    action: Extract<Action, { kind: 'append' }>, execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
    const { signal } = execution;
    const editor = geometry.contentEditable === true && !['INPUT', 'TEXTAREA'].includes(geometry.tag);
    if (target.role !== 'textbox' && !target.editable) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Append requires an observed text control');
    const read = async (mode: 'value' | 'end' | 'position' = 'value') => {
      if (editor) return this.editorState(lease, objectId, mode === 'value' ? mode : mode === 'end' ? 'append-end' : 'append-position', signal);
      const response = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: nativeTextFunction,
        arguments: [{ value: mode }], returnByValue: true }, signal);
      checkAbort(signal);
      if (response.exceptionDetails || response.result?.value?.connected !== true) throw new BrowserError('STALE_TARGET', 'Append target disappeared');
      return response.result.value as Dict;
    };
    const before = await read();
    if (before.editable !== true || typeof before.value !== 'string') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Append requires a bounded, unprotected editor or native selection-capable text field');
    const value = before.value + action.text;
    if (before.singleLine === true && /[\r\n]/.test(action.text)) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'A single-line input cannot append line breaks');
    if (value.length > 10000) throw new BrowserError('INVALID_REQUEST', 'Resulting appended text exceeds the value budget');
    if (action.expected?.kind === 'value' && action.expected.value !== value) throw new BrowserError('INVALID_REQUEST', 'Append value expectation must include the existing prefix');
    const check = (state: Dict, caret = false) => {
      if (state.editable !== true) throw new BrowserError('STALE_TARGET', 'Editing target changed before append');
      if (caret && state.atEnd !== true) throw new BrowserError('NOT_ACTIONABLE', 'Append target does not own an end caret');
      if (state.value !== before.value) throw new BrowserError('STALE_TARGET', 'Text changed before append');
      if (typeof state.maxLength === 'number' && state.maxLength >= 0 && value.length > state.maxLength) throw new BrowserError('NOT_ACTIONABLE', 'Append would exceed the current maxlength');
    };
    check(before);
    if (action.text !== '') {
      execution.onDispatch();
      check(await read('end'), true);
      await this.checkIdentity(lease, target, signal, true);
      await this.checkFocus(lease, objectId, signal, true);
      // One final read binds the original text and the end caret in the same call.
      check(await read('position'), true);
      execution.onDispatch();
      await this.cdp(lease, 'Input.insertText', { text: action.text }, signal);
    }
    const matches = async () => {
      await this.checkIdentity(lease, target, signal);
      const state = await read();
      if (state.editable !== true) throw new BrowserError('STALE_TARGET', 'Append target changed after input');
      return state.value === value;
    };
    await waitUntil(async () => await matches() ? true : undefined, { signal, clock });
    const result = await this.result(lease, action.expected?.kind === 'value' ? undefined : action.expected, undefined, signal, clock, undefined, stateBinding);
    if (!await matches()) throw new BrowserError('STALE_TARGET', 'Appended text changed during result observation');
    return { ...result, postcondition: 'passed' };
  }

  private async editorResult(lease: Lease, target: Target, objectId: string, action: Extract<Action, { kind: 'fill' }>,
    signal: AbortSignal, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
    const matches = async () => {
      await this.checkIdentity(lease, target, signal);
      const state = await this.editorState(lease, objectId, 'value', signal);
      if (state.editable !== true) throw new BrowserError('STALE_TARGET', 'Editing host changed after input');
      return state.value === action.text;
    };
    // Always verify the entire edited value, even with a separate page postcondition.
    await waitUntil(async () => await matches() ? true : undefined, { signal, clock });
    const result = await this.result(lease, action.expected?.kind === 'value' ? undefined : action.expected, undefined, signal, clock, undefined, stateBinding);
    if (!await matches()) throw new BrowserError('STALE_TARGET', 'Editor changed during result observation');
    return { ...result, postcondition: 'passed' };
  }

  private async stateMatches(lease: Lease, expected: Extract<Expected, { kind: 'state' }>, binding: StateBinding | undefined,
    signal: AbortSignal): Promise<boolean> {
    if (!binding || binding.ref !== expected.ref) throw new BrowserError('INVALID_REQUEST', 'State expectation was not bound before the action');
    if ((await this.document(lease, signal)).state.epoch !== binding.epoch) throw new BrowserError('STALE_TARGET', 'State expectation document changed');
    const response = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId: binding.objectId,
      functionDeclaration: elementStateFunction, arguments: [{ value: expected.state }], returnByValue: true }, signal);
    const state = response.result?.value;
    // A lost object/context or transport error is NOT evidence of hidden/detached.
    if (response.exceptionDetails || state?.sameDocument !== true || typeof state?.connected !== 'boolean') {
      throw new BrowserError('STALE_TARGET', 'State target moved documents or became unavailable');
    }
    if (state.supported !== true || typeof state.matched !== 'boolean') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Unsupported or unbounded element-state predicate');
    if ((await this.document(lease, signal)).state.epoch !== binding.epoch) throw new BrowserError('STALE_TARGET', 'Document changed during state verification');
    return state.matched;
  }

  private async result(lease: Lease, expected: Expected | undefined, objectId: string | undefined,
    signal: AbortSignal, clock: ChangeClock, navigationLoader?: string, stateBinding?: StateBinding): Promise<ProviderResult> {
    if (!expected) return { observation: await this.observe(lease, signal), postcondition: 'unverified' };
    const observation = await waitUntil(async () => {
      const document = await this.document(lease, signal); // Check actual origin on every predicate iteration.
      // Page.navigate can return before commit. Never verify against the outgoing page.
      if (navigationLoader && document.frame.loaderId !== navigationLoader) return undefined;
      if (expected.kind === 'state' && !await this.stateMatches(lease, expected, stateBinding, signal)) return undefined;
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
      if (expected.kind === 'state' && !await this.stateMatches(lease, expected, stateBinding, signal)) return undefined;
      return observation;
    }, { signal, clock });
    return { observation, postcondition: 'passed' };
  }

  private async scroll(lease: Lease, request: ActionRequest, action: Extract<Action, { kind: 'scroll' }>,
    execution: ProviderExecution, clock: ChangeClock, stateBinding?: StateBinding): Promise<ProviderResult> {
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
      const result = await this.result(lease, action.expected, undefined, signal, clock, undefined, stateBinding);
      if (!sameScrollPosition(after, await read())) throw new BrowserError('STALE_TARGET', 'Scroll position changed during result observation');
      return { ...result, scroll, postcondition: scrollMovedAsRequested(scroll)
        ? action.expected ? result.postcondition : 'passed' : 'unverified' };
    } finally {
      await this.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
    }
  }

  async actFrame(lease:Lease,raw:ActionRequest,execution:ProviderExecution):Promise<ProviderResult>{
    const request=actionRequest(raw),frame=request.frame,action=request.action;
    if(!frame||action.kind!=='click')throw new BrowserError('INVALID_REQUEST','Explicit child click scope is required');
    const deadline=actionDeadline(execution.signal,request.timeoutMs),signal=deadline.signal,clock=new ChangeClock();
    const unsubscribe=this.channel.onEvent?.((event,value)=>{
      const v=value as Dict|undefined;if(event==='page.changed'&&v?.tab===lease.tab&&v?.leaseId===lease.id)clock.pulse();
    });
    try{
      sameOriginFrame(await this.frames(lease,signal),frame,lease);
      const page=this.pages.get(lease.tab)!,child=page.childPages.get(frame.frameId);
      const target=child?.byRef.get(action.ref),source=[...page.frameRefs.values()].find(f=>f.ref===frame.frameId)?.source;
      if(!target||child?.epoch!==frame.documentEpoch||target.epoch!==frame.documentEpoch||!source?.loaderId||!source.context?.uniqueId)
        throw new BrowserError('STALE_TARGET','Child action requires a current observed target and context');
      if(!controlRoles.has(target.role)||target.name.length>1000)throw new BrowserError('UNSUPPORTED_CAPABILITY','Unsupported child click target');
      const root=[...page.frameRefs.values()].find(f=>f.source.parentId===undefined)!.source;
      const bound={binding:{frameId:source.frameId,loaderId:source.loaderId,contextUniqueId:source.context.uniqueId,
        rootFrameId:root.frameId,rootLoaderId:root.loaderId!},backendNodeId:target.backendId,role:target.role,name:target.name};
      // Preflight gives precise not-dispatched failures. Dispatch reruns all
      // source bindings/checks, not a returned coordinate or saved object token.
      const prepared=await this.channel.call('frame.click.prepare',{lease,request:bound},signal) as Dict;
      if(prepared?.acknowledged!==false)throw new BrowserError('INVALID_REQUEST','Invalid child click preparation');
      sameOriginFrame(await this.frames(lease,signal),frame,lease);
      if(this.pages.get(lease.tab)!==page||page.childPages.get(frame.frameId)?.byRef.get(action.ref)!==target)
        throw new BrowserError('STALE_TARGET','Child reference changed during preparation');
      execution.onDispatch();
      const reply=await this.channel.call('frame.click',{lease,request:bound},signal) as Dict;
      if(reply?.acknowledged!==true)throw new BrowserError('INVALID_REQUEST','Child click acknowledgement unavailable');
      const expected=action.expected;
      const observation=await waitUntil(async()=>{
        const observed=await this.observeFrame(lease,frame,signal);
        if(expected?.kind==='text'&&!observed.text.join(' ').replace(/\s+/g,' ').includes(expected.text.replace(/\s+/g,' ')))return undefined;
        return observed;
      },{signal,clock});
      return {observation,postcondition:expected?'passed':'unverified'};
    }finally{unsubscribe?.();deadline.dispose();}
  }

  async act(lease: Lease, request: ActionRequest, execution: ProviderExecution): Promise<ProviderResult> {
    if(request.frame)return this.actFrame(lease,request,execution);
    const deadline = actionDeadline(execution.signal, request.timeoutMs);
    const signal = deadline.signal, clock = new ChangeClock(), action = request.action;
    const unsubscribe = this.channel.onEvent?.((event, raw) => {
      if (event !== 'page.changed' || !raw || typeof raw !== 'object') return;
      const value = raw as Dict;
      if (value.tab === lease.tab && value.leaseId === lease.id) clock.pulse();
    });
    let objectId: string | undefined, labelObject: string | undefined, radioBinding: string | undefined, editingHost = false;
    let stateBinding: StateBinding | undefined;
    try {
      if (action.expected?.kind === 'state') {
        if (action.kind === 'navigate') throw new BrowserError('INVALID_REQUEST', 'Node-state expectations cannot cross navigation');
        const { state } = await this.document(lease, signal), target = state.byRef.get(action.expected.ref);
        if (state.epoch !== request.documentEpoch || !target || target.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'State expectation requires a current known ref');
        await this.checkIdentity(lease, target, signal);
        const resolved = await this.cdp(lease, 'DOM.resolveNode', { backendNodeId: target.backendId }, signal);
        if (!resolved.object?.objectId) throw new BrowserError('STALE_TARGET', 'State target disappeared before the action');
        stateBinding = { objectId: resolved.object.objectId, epoch: request.documentEpoch, ref: action.expected.ref };
        await this.stateMatches(lease, action.expected, stateBinding, signal); // Validate support before any side effect.
        const connected = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId: stateBinding.objectId,
          functionDeclaration: 'function(){return this.isConnected===true&&this.ownerDocument===document;}', returnByValue: true }, signal);
        if (connected.exceptionDetails || connected.result?.value !== true) throw new BrowserError('STALE_TARGET', 'State target disappeared before the action');
      }
      if (action.kind === 'scroll') return await this.scroll(lease, request, action, { signal, onDispatch: () => execution.onDispatch() }, clock, stateBinding);
      if (action.kind === 'wheel') {
        scrollDelta(action);
        if (action.expected?.kind === 'value') throw new BrowserError('INVALID_REQUEST', 'Wheel cannot verify an input value');
      }
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
      if (!controlRoles.has(original.role) && !original.editable && !(action.kind === 'wheel' && regionRoles.has(original.role))) {
        throw new BrowserError('NOT_ACTIONABLE', 'This observation region is not a target for the requested input');
      }
      await this.checkIdentity(lease, original, signal);
      const current = this.pages.get(lease.tab)!.byRef.get(action.ref);
      if (!current || current.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'Target identity changed');
      if (action.kind === 'check' && (!['checkbox', 'switch', 'radio'].includes(current.role) || typeof action.checked !== 'boolean'
        || current.role === 'radio' && !action.checked || action.expected?.kind === 'value')) {
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Check requires a checkbox/switch boolean state or native radio checked:true');
      }
      const resolved = await this.cdp(lease, 'DOM.resolveNode', { backendNodeId: current.backendId }, signal);
      objectId = resolved.object?.objectId;
      if (!objectId) throw new BrowserError('STALE_TARGET', 'Target was removed');
      const targetObject = objectId;
      let pointerObject = targetObject;
      if (action.kind === 'check') {
        if (current.role === 'radio') {
          const binding = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId: targetObject,
            functionDeclaration: radioBindingFunction, returnByValue: false }, signal);
          radioBinding = binding.result?.objectId;
          if (binding.exceptionDetails || !radioBinding) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Only native input[type=radio] selection is supported');
        }
        const state = await waitUntil(() => this.readChecked(lease, current, targetObject, signal, radioBinding), { signal, clock });
        if (state.checked === action.checked) return await this.checkedResult(lease, current, targetObject, action, signal, clock, radioBinding, stateBinding);
        if (!(await this.geometry(lease, targetObject, signal)).ok) {
          const label = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId: targetObject,
            functionDeclaration: checkedLabelFunction, returnByValue: false }, signal);
          labelObject = label.result?.objectId;
          if (label.exceptionDetails) throw new BrowserError('STALE_TARGET', 'Checked control label resolution failed');
          // A hidden/disabled label must not displace a usable offscreen input.
          if (labelObject && (await this.geometry(lease, labelObject, signal)).eligible === true) pointerObject = labelObject;
        }
      }
      const delegatedLabel = pointerObject !== targetObject ? pointerObject : undefined;
      let previous: Dict | undefined, previousAt = 0, scrolled = false;
      const geometry = await waitUntil(async () => {
        await this.checkIdentity(lease, current, signal);
        await this.checkRadioBinding(lease, targetObject, radioBinding, signal);
        if (delegatedLabel) await this.checkLabelBinding(lease, delegatedLabel, targetObject, signal);
        const next = await this.geometry(lease, pointerObject, signal);
        if (next.inViewport === false && !scrolled) {
          scrolled = true; execution.onDispatch();
          await this.cdp(lease, 'DOM.scrollIntoViewIfNeeded', delegatedLabel ? { objectId: delegatedLabel } : { backendNodeId: current.backendId }, signal);
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
      if (action.kind === 'wheel') {
        const finalPoint = await this.geometry(lease, pointerObject, signal, { x: geometry.x, y: geometry.y });
        if (!finalPoint.ok || !sameGeometry(geometry, finalPoint)) {
          throw new BrowserError('NOT_ACTIONABLE', 'Selected wheel point changed before input');
        }
        const event = wheelEvent({ x: geometry.x, y: geometry.y }, action);
        execution.onDispatch();
        await this.cdp(lease, 'Input.dispatchMouseEvent', event, signal);
      } else if (action.kind === 'append') {
        return await this.append(lease, current, targetObject, geometry, action, { signal, onDispatch: () => execution.onDispatch() }, clock, stateBinding);
      } else if (action.kind === 'fill') {
        editingHost = geometry.contentEditable === true && !['INPUT', 'TEXTAREA'].includes(geometry.tag);
        if (current.role !== 'textbox' && !current.editable || !editingHost && !['INPUT', 'TEXTAREA'].includes(geometry.tag) || geometry.readOnly || geometry.type === 'password') {
          throw new BrowserError('UNSUPPORTED_CAPABILITY', 'This input type is not supported by the initial fill implementation');
        }
        if (editingHost && (await this.editorState(lease, objectId, 'inspect', signal)).editable !== true) {
          throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Fill requires one bounded, unprotected contenteditable editing host');
        }
        if (editingHost && action.expected?.kind === 'value' && action.expected.value !== action.text) {
          throw new BrowserError('INVALID_REQUEST', 'Editor value expectation must equal the replacement text');
        }
        execution.onDispatch();
        if (editingHost) {
          const selection = await this.editorState(lease, objectId, 'select', signal);
          if (selection.editable !== true || selection.selected !== true) throw new BrowserError('NOT_ACTIONABLE', 'Editor lost its focus or full-content selection');
        } else {
          const selection = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId, functionDeclaration: selectFunction, returnByValue: true }, signal);
          if (selection.exceptionDetails || selection.result?.value?.focused !== true) throw new BrowserError('NOT_ACTIONABLE', 'Input changed or lost focus during selection');
        }
        await this.checkIdentity(lease, current, signal, true);
        await this.checkFocus(lease, objectId, signal, true);
        if (editingHost) {
          const selection = await this.editorState(lease, objectId, 'selection', signal);
          if (selection.editable !== true || selection.selected !== true) throw new BrowserError('NOT_ACTIONABLE', 'Editor selection changed before input');
        }
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
          (await waitUntil(() => this.readChecked(lease, current, targetObject, signal, radioBinding), { signal, clock })).checked !== action.checked;
        if (needsClick) {
          const finalPoint = await this.geometry(lease, pointerObject, signal, { x: geometry.x, y: geometry.y });
          if (!finalPoint.ok || !sameGeometry(geometry, finalPoint)) {
            throw new BrowserError('NOT_ACTIONABLE', 'Selected click point changed before input');
          }
          if (delegatedLabel) await this.checkLabelBinding(lease, delegatedLabel, targetObject, signal);
          await this.checkRadioBinding(lease, targetObject, radioBinding, signal);
          execution.onDispatch();
          await this.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
          execution.onDispatch();
          await this.cdp(lease, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, signal);
        }
      }
      if (action.kind === 'check') return await this.checkedResult(lease, current, targetObject, action, signal, clock, radioBinding, stateBinding);
      if (action.kind === 'fill' && editingHost) return await this.editorResult(lease, current, targetObject, action, signal, clock, stateBinding);
      if (action.kind === 'fill' && action.expected?.kind === 'state') {
        // An unrelated state already being true must not conceal rejected/truncated input.
        const matches = async () => {
          await this.checkIdentity(lease, current, signal);
          const read = await this.cdp(lease, 'Runtime.callFunctionOn', { objectId,
            functionDeclaration: valueFunction, returnByValue: true }, signal);
          if (read.exceptionDetails || read.result?.value?.connected !== true) throw new BrowserError('STALE_TARGET', 'Filled input disappeared');
          return read.result?.value?.value === action.text;
        };
        await waitUntil(async () => await matches() ? true : undefined, { signal, clock });
        const result = await this.result(lease, action.expected, objectId, signal, clock, undefined, stateBinding);
        if (!await matches()) throw new BrowserError('STALE_TARGET', 'Filled input changed during state verification');
        return result;
      }
      return await this.result(lease, action.expected ?? (action.kind === 'fill' ? { kind: 'value', value: action.text } : undefined), objectId, signal, clock, undefined, stateBinding);
    } finally {
      unsubscribe?.(); deadline.dispose();
      // Release is cleanup only; it must not hide the authoritative action outcome.
      if (labelObject) await this.cdp(lease, 'Runtime.releaseObject', { objectId: labelObject }, AbortSignal.timeout(1000)).catch(() => {});
      if (radioBinding) await this.cdp(lease, 'Runtime.releaseObject', { objectId: radioBinding }, AbortSignal.timeout(1000)).catch(() => {});
      if (objectId) await this.cdp(lease, 'Runtime.releaseObject', { objectId }, AbortSignal.timeout(1000)).catch(() => {});
      if (stateBinding) await this.cdp(lease, 'Runtime.releaseObject', { objectId: stateBinding.objectId }, AbortSignal.timeout(1000)).catch(() => {});
    }
  }
}
