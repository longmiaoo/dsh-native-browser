import { BrowserError, checkAbort, errorCode, originOf, type Lease } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import { allowedKeyEvent } from '../../provider-chromium/src/keyboard.js';
import { allowedMouseEvent } from '../../provider-chromium/src/mouse.js';
import { axReadRequest, readAXTree } from '../../provider-chromium/src/ax-reader.js';
import { axFindRequest, findAXNodes } from '../../provider-chromium/src/ax-query.js';
import { AXPager, axPageRequest } from '../../provider-chromium/src/ax-pager.js';
import { FrameSessions } from '../../provider-chromium/src/frame-sessions.js';
import { frameReadBinding, readFrameAX } from '../../provider-chromium/src/frame-read.js';
import { frameFindRequest, findFrameAX } from '../../provider-chromium/src/frame-query.js';
import { frameTextRequest, hasFrameText } from '../../provider-chromium/src/frame-text.js';
import { frameSubtreeRequest, readFrameSubtree } from '../../provider-chromium/src/frame-subtree.js';
import { framePageRequest, readFramePage } from '../../provider-chromium/src/frame-page.js';
import { frameGeometryRequest, readFrameGeometry } from '../../provider-chromium/src/frame-geometry-read.js';
import { frameClickRequest, frameClick } from '../../provider-chromium/src/frame-click.js';
import { wireMessage, acceptWelcome, personalBrokerCapability, providerCapabilities, providerRequirements, wireVersion } from '../../contracts/src/wire.js';

const HOST = 'com.longmiaoo.dsh_native_browser';
type TabConsent = Readonly<{ origin: string; scope: 'tab' }>;
const allowed = new Map<number, TabConsent>();
const gates = new Map<number, Lease>();
const pager = new AXPager();
const frameSessions = new Map<number, FrameSessions>();
const attached = new Set<number>();
const queues = new Map<number, Promise<unknown>>();
const changeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const changeSequences = new Map<number, number>();
let port: chrome.runtime.Port | undefined;
let instanceId = crypto.randomUUID();
let status = 'Disconnected';
let brokerPersonal = false;
const methods = new Set(['Page.getFrameTree', 'DOM.resolveNode', 'DOM.getDocument',
  'Runtime.callFunctionOn', 'Runtime.releaseObject', 'Input.insertText', 'Input.dispatchMouseEvent',
  'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Accessibility.getPartialAXTree',
  'DOM.scrollIntoViewIfNeeded', 'Input.dispatchKeyEvent', 'Page.navigate', 'Runtime.evaluate']);

function tabIdOf(lease: Lease): number {
  const prefix = `${instanceId}:`;
  if (lease.instanceId !== instanceId || !lease.tab.startsWith(prefix)) throw new BrowserError('LEASE_REVOKED', 'Wrong browser instance');
  const id = Number(lease.tab.slice(prefix.length));
  if (!Number.isSafeInteger(id) || id < 0) throw new BrowserError('INVALID_REQUEST', 'Invalid tab handle');
  return id;
}
function leaseOf(value: unknown): Lease {
  const v = record(value);
  if (!Number.isSafeInteger(v.expiresAt) || Number(v.expiresAt) > Date.now() + 5 * 60_000) {
    throw new BrowserError('INVALID_REQUEST', 'Invalid lease deadline');
  }
  const scope = v.scope === undefined ? 'origin' : v.scope;
  if (scope !== 'origin' && scope !== 'tab') throw new BrowserError('INVALID_REQUEST', 'Invalid lease scope');
  return { id: string(v.id), owner: string(v.owner, 1024), tab: string(v.tab), instanceId: string(v.instanceId),
    token: string(v.token), origin: originOf(string(v.origin)), scope, expiresAt: Number(v.expiresAt) };
}
function enqueue<T>(id: number, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(id, result);
  void result.finally(() => { if (queues.get(id) === result) queues.delete(id); }).catch(() => {});
  return result;
}
function checkGate(lease: Lease, signal: AbortSignal): number {
  checkAbort(signal);
  const id = tabIdOf(lease);
  const gate = gates.get(id), consent = allowed.get(id), scope = lease.scope ?? 'origin';
  const personalGrant = brokerPersonal && scope === 'tab';
  if (gate?.token !== lease.token || (gate.scope ?? 'origin') !== scope || !personalGrant && !consent
    || !personalGrant && scope === 'origin' && consent!.origin !== lease.origin || lease.expiresAt <= Date.now()) {
    throw new BrowserError('LEASE_REVOKED', 'Local control gate is closed');
  }
  return id;
}

type PointerPhase = 'move' | 'click' | 'wheel';
function showVirtualPointer(id: number, params: Record<string, unknown>): void {
  const type = params.type;
  if (type !== 'mousePressed' && type !== 'mouseReleased' && type !== 'mouseWheel') return;
  const x = Number(params.x), y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const phase: PointerPhase = type === 'mouseReleased' ? 'click' : type === 'mouseWheel' ? 'wheel' : 'move';
  // The persistent isolated content script keeps pointer rendering independent
  // from the action queue. Existing tabs receive it once on demand.
  const message = { type: 'dsh.pointer.v1', action: 'show', x, y, phase };
  void chrome.tabs.sendMessage(id, message).catch(async () => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['pointer.js'] });
    await chrome.tabs.sendMessage(id, message);
  }).catch(() => {});
}
function removeVirtualPointer(id: number): void {
  void chrome.tabs.sendMessage(id, { type: 'dsh.pointer.v1', action: 'remove' }).catch(() => {});
}
async function ensure(lease: Lease, signal: AbortSignal): Promise<number> {
  const id = checkGate(lease, signal);
  const tab = await chrome.tabs.get(id);
  checkGate(lease, signal);
  if (originOf(tab.url ?? '') !== lease.origin) {
    throw new BrowserError('POLICY_DENIED', 'Tab changed or user stopped control');
  }
  return id;
}
function stop(id: number, forget = true): Promise<void> {
  const lease = gates.get(id);
  // This synchronous change is the last-mile Stop guarantee, before any network/IPC.
  gates.delete(id);
  frameSessions.get(id)?.dispose(); frameSessions.delete(id);
  if (lease) pager.revoke(lease.token + '|');
  clearTimeout(changeTimers.get(id)); changeTimers.delete(id);
  changeSequences.delete(id);
  removeVirtualPointer(id);
  if (forget) allowed.delete(id);
  if (lease) { try { port?.postMessage({ type: 'event', event: 'lease.revoked', value: { leaseId: lease.id } }); } catch {} }
  return enqueue(id, async () => {
    if (attached.has(id)) { attached.delete(id); await chrome.debugger.detach({ tabId: id }).catch(() => {}); }
  });
}

async function frameGraph(lease: Lease, signal: AbortSignal) {
  const id = await ensure(lease, signal);
  const send = async (sessionId: string, command: string, params: Record<string, unknown>, currentSignal: AbortSignal, beforeDispatch?: () => void) => {
    await ensure(lease, currentSignal); checkGate(lease, currentSignal);
    beforeDispatch?.();
    const result = await chrome.debugger.sendCommand({ tabId: id, ...(sessionId ? { sessionId } : {}) }, command, params) as Record<string, any>;
    if (command === 'Input.dispatchMouseEvent') showVirtualPointer(id, params);
    await ensure(lease, currentSignal); return result;
  };
  let graph = frameSessions.get(id);
  if (!graph) {
    graph = new FrameSessions(send, () => { void stop(id, false); }); frameSessions.set(id, graph);
    try { await graph.start(signal); }
    // Auto-attachment may already be active. Close the gate synchronously;
    // detach is queued, so do not await it from inside this queue slot.
    catch (error) { if (frameSessions.get(id) === graph) void stop(id, false); throw error; }
  }
  return { graph, send };
}

async function execute(method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = record(raw);
  if (method === 'tabs.list') {
    const result = [];
    const candidates = brokerPersonal
      ? (await chrome.tabs.query({})).map(tab => [tab.id, tab] as const)
      : [...allowed].map(([id]) => [id, undefined] as const);
    for (const [id, known] of candidates) {
      if (id === undefined) continue;
      const tab = known ?? await chrome.tabs.get(id).catch(() => undefined);
      try {
        if (tab?.url) { originOf(tab.url); result.push({ id: `${instanceId}:${id}`, instanceId, url: tab.url, title: tab.title ?? '' }); }
      } catch { /* Internal or unsupported pages never enter the control inventory. */ }
    }
    return result;
  }
  const lease = leaseOf(p.lease), id = tabIdOf(lease);
  if (method === 'lease.grant') {
    if (gates.has(id)) throw new BrowserError('LEASE_BUSY', 'Tab already controlled');
    const consent = allowed.get(id);
    const personalGrant = brokerPersonal && (lease.scope ?? 'origin') === 'tab';
    if (!personalGrant && (!consent || (lease.scope ?? 'origin') === 'origin' && consent.origin !== lease.origin)) {
      throw new BrowserError('POLICY_DENIED', 'Allow this tab from the extension popup first');
    }
    gates.set(id, lease);
    try {
      return await enqueue(id, async () => {
        await ensure(lease, signal);
        if (!attached.has(id)) { await chrome.debugger.attach({ tabId: id }, '1.3'); attached.add(id); }
        await ensure(lease, signal);
        await chrome.debugger.sendCommand({ tabId: id }, 'Page.enable');
        await chrome.debugger.sendCommand({ tabId: id }, 'Page.setLifecycleEventsEnabled', { enabled: true });
        await chrome.debugger.sendCommand({ tabId: id }, 'Accessibility.enable');
        await chrome.debugger.sendCommand({ tabId: id }, 'DOM.enable');
        await ensure(lease, signal);
        return { granted: true };
      });
    } catch (error) { if (gates.get(id)?.token === lease.token) await stop(id, false); throw error; }
  }
  if (method === 'lease.revoke') {
    if (gates.get(id)?.token === lease.token) await stop(id, false);
    return { released: true };
  }
  if (method === 'frames.list') {
    if (Object.keys(p).length !== 1) throw new BrowserError('INVALID_REQUEST', 'Frame discovery only accepts its lease');
    return enqueue(id, async () => {
      const { graph, send } = await frameGraph(lease, signal);
      const before = (await send('', 'Page.getFrameTree', {}, signal)).frameTree?.frame;
      const result = await graph.snapshot(signal);
      const after = (await send('', 'Page.getFrameTree', {}, signal)).frameTree?.frame;
      if (!before?.loaderId || !after || before.id !== after.id || before.loaderId !== after.loaderId
        || originOf(before.url) !== lease.origin || originOf(after.url) !== lease.origin) throw new BrowserError('STALE_TARGET', 'Root document changed during frame discovery');
      return result;
    });
  }
  if(method==='frame.click.prepare'||method==='frame.click'){
    if(Object.keys(p).some(key=>!['lease','request'].includes(key)))throw new BrowserError('INVALID_REQUEST','Invalid frame click command');
    const request=frameClickRequest(p.request);
    return enqueue(id,async()=>{
      const {graph}=await frameGraph(lease,signal);
      const result=await frameClick(graph,request,lease.origin,signal,method==='frame.click');
      await ensure(lease,signal);return result;
    });
  }
  if (method === 'frame.geometry') {
    if(Object.keys(p).some(key=>!['lease','request'].includes(key)))throw new BrowserError('INVALID_REQUEST','Invalid frame geometry read');
    const request=frameGeometryRequest(p.request);
    return enqueue(id,async()=>{
      const {graph}=await frameGraph(lease,signal);
      const result=await readFrameGeometry(graph,request,lease.origin,signal);
      await ensure(lease,signal);return result;
    });
  }
  if (method === 'ax.frame') {
    if (Object.keys(p).some(key => !['lease', 'binding'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid frame read');
    const binding = frameReadBinding(p.binding);
    return enqueue(id, async () => {
      const { graph } = await frameGraph(lease, signal);
      const result = await readFrameAX(graph, binding, lease.origin, signal);
      await ensure(lease, signal); return result;
    });
  }
  if (method === 'ax.frame.page') {
    if (Object.keys(p).some(key => !['lease', 'request'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid child page');
    const request = framePageRequest(p.request);
    return enqueue(id, async () => {
      const { graph } = await frameGraph(lease, signal);
      const result = await readFramePage(graph, request, lease.origin, signal, pager, lease.token);
      try { await ensure(lease, signal); return result; }
      catch (error) { pager.discard(result.page.continuation); throw error; }
    });
  }
  if (method === 'ax.frame.text') {
    if (Object.keys(p).some(key => !['lease', 'request'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid child text check');
    const request = frameTextRequest(p.request);
    return enqueue(id, async () => {
      const { graph } = await frameGraph(lease, signal);
      const result = await hasFrameText(graph, request, lease.origin, signal);
      await ensure(lease, signal); return result;
    });
  }
  if (method === 'ax.frame.find' || method === 'ax.frame.subtree') {
    if (Object.keys(p).some(key => !['lease', 'request'].includes(key))) throw new BrowserError('INVALID_REQUEST', 'Invalid child query');
    const request = method === 'ax.frame.find' ? frameFindRequest(p.request) : frameSubtreeRequest(p.request);
    return enqueue(id, async () => {
      const { graph } = await frameGraph(lease, signal);
      const result = await (method === 'ax.frame.find' ? findFrameAX : readFrameSubtree)(graph, request, lease.origin, signal);
      await ensure(lease, signal); return result;
    });
  }
  if (method === 'ax.read' || method === 'ax.find' || method === 'ax.page') {
    const request = method === 'ax.page' ? axPageRequest(p.request) : method === 'ax.find' ? axFindRequest(p.request) : axReadRequest(p.request);
    return enqueue(id, async () => {
      const send = async (command: string, params: Record<string, unknown>) => {
        await ensure(lease, signal);
        checkGate(lease, signal);
        const result = await chrome.debugger.sendCommand({ tabId: id }, command, params) as Record<string, any>;
        await ensure(lease, signal);
        return result;
      };
      const before = (await send('Page.getFrameTree', {})).frameTree?.frame;
      if (!before || before.id !== request.frameId || !before.loaderId || originOf(before.url) !== lease.origin) {
        throw new BrowserError('POLICY_DENIED', 'AX read requires the currently leased root frame');
      }
      const result = method === 'ax.page' ? await pager.read(axPageRequest(p.request), lease.token + '|' + before.id + ':' + before.loaderId, send, signal)
        : method === 'ax.find' ? await findAXNodes(axFindRequest(p.request), send, signal)
        : await readAXTree(request, send, signal);
      const after = (await send('Page.getFrameTree', {})).frameTree?.frame;
      if (!after || after.id !== before.id || after.loaderId !== before.loaderId || originOf(after.url) !== lease.origin) {
        if (method === 'ax.page') pager.revoke(lease.token + '|');
        throw new BrowserError('STALE_TARGET', 'Document changed during AX traversal');
      }
      return result;
    });
  }
  if (method === 'cdp') {
    const command = string(p.method);
    if (!methods.has(command)) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'CDP method is not exposed');
    const params = record(p.params);
    if (command === 'DOM.getDocument' && (params.depth !== 0 || params.pierce !== false || Object.keys(params).length !== 2)) {
      throw new BrowserError('POLICY_DENIED', 'Only the root document handle is exposed');
    }
    if (command === 'Input.dispatchKeyEvent' && !allowedKeyEvent(params)) {
      throw new BrowserError('POLICY_DENIED', 'Only canonical page-key events are exposed');
    }
    if (command === 'Input.dispatchMouseEvent' && !allowedMouseEvent(params)) {
      throw new BrowserError('POLICY_DENIED', 'Only canonical left-click and unmodified wheel events are exposed');
    }
    if (command === 'Page.navigate') {
      const targetOrigin = originOf(string(params.url, 8192));
      if (targetOrigin !== lease.origin || (lease.scope ?? 'origin') === 'origin' && targetOrigin !== allowed.get(id)?.origin) {
        throw new BrowserError('POLICY_DENIED', 'Navigation target is outside the lease scope');
      }
    }
    if (command === 'Runtime.evaluate' && (params.expression !== 'document.readyState' || params.returnByValue !== true
      || Object.keys(params).some(key => !['expression', 'returnByValue'].includes(key)))) {
      throw new BrowserError('POLICY_DENIED', 'Only the fixed document-readiness query is exposed');
    }
    return enqueue(id, async () => {
      if (command === 'Page.navigate' && (lease.scope ?? 'origin') === 'tab') {
        checkGate(lease, signal);
        const current = await chrome.tabs.get(id);
        originOf(current.url ?? '');
        checkGate(lease, signal);
      } else await ensure(lease, signal);
      if (command === 'Page.captureScreenshot') {
        // Root Page.getFrameTree omits attached OOPIFs. Inspect all sessions at
        // the last mile, including captures made before explicit frame discovery.
        const { graph, send } = await frameGraph(lease, signal);
        const before = await graph.snapshot(signal);
        if (before.truncated || before.frames.some(frame => frame.origin !== lease.origin))
          throw new BrowserError('POLICY_DENIED', 'Screenshot frame authority is incomplete');
        const image = await send('', command, params, signal);
        const after = await graph.snapshot(signal);
        if (after.truncated || after.frames.some(frame => frame.origin !== lease.origin))
          throw new BrowserError('POLICY_DENIED', 'Screenshot contains an unapproved frame');
        if (before.revision !== after.revision || JSON.stringify(before.frames) !== JSON.stringify(after.frames))
          throw new BrowserError('STALE_TARGET', 'Frame documents changed during capture');
        return image;
      }
      // No await between final gate check and browser dispatch.
      checkGate(lease, signal);
      const result = await chrome.debugger.sendCommand({ tabId: id }, command, params);
      if (command === 'Input.dispatchMouseEvent') showVirtualPointer(id, params);
      return result;
    });
  }
  throw new BrowserError('INVALID_REQUEST', 'Unknown extension command');
}

function connect(): void {
  if (port) return;
  instanceId = crypto.randomUUID();
  const current = chrome.runtime.connectNative(HOST);
  port = current; status = 'Connecting';
  const helloId = crypto.randomUUID();
  const pending = new Map<string, AbortController>(), seen = new Set<string>();
  let accepted = false, closed = false;
  const teardown = (message: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(helloTimer);
    for (const controller of pending.values()) controller.abort();
    pending.clear(); seen.clear();
    if (port === current) {
      pager.clear(); brokerPersonal = false;
      port = undefined; status = message;
      for (const id of gates.keys()) void stop(id, false);
    }
  };
  // Port.disconnect() does not fire onDisconnect on the initiating side.
  const disconnect = (message: string) => {
    teardown(message);
    try { current.disconnect(); } catch { /* already disconnected */ }
  };
  const helloTimer = setTimeout(() => disconnect('Handshake timed out'), 3000);
  current.onMessage.addListener((raw: unknown) => {
    if (port !== current) return; // An obsolete port cannot change the new connection's gates or status.
    try {
      const m = wireMessage(raw);
      if (m.type === 'response' && m.id === helloId) {
        if (accepted) throw new BrowserError('PROTOCOL_MISMATCH', 'Repeated handshake reply');
        if (!m.ok) { disconnect(`Handshake rejected: ${m.code}`); return; }
        const welcome = acceptWelcome(m.value, providerRequirements);
        brokerPersonal = welcome.capabilities.includes(personalBrokerCapability);
        clearTimeout(helloTimer); accepted = true; status = brokerPersonal ? 'Connected · Personal' : 'Connected';
        return;
      }
      if (!accepted || m.type === 'event' || m.type === 'response') throw new BrowserError('PROTOCOL_MISMATCH', 'Unexpected message before or after handshake');
      const id = m.id;
      if (m.type === 'cancel') { pending.get(id)?.abort(); return; }
      if (seen.has(id) || seen.size >= 10000 || pending.size >= 32) throw new Error('Duplicate request or capacity');
      seen.add(id);
      const controller = new AbortController(); pending.set(id, controller);
      void execute(string(m.method), m.params, controller.signal).then(value => {
        checkAbort(controller.signal);
        if (port !== current) throw new BrowserError('CONNECTION_LOST', 'Connection changed');
        const response = wireMessage({ type: 'response', id, ok: true, value: value ?? null });
        if (new TextEncoder().encode(JSON.stringify(response)).length > 900_000) {
          throw new BrowserError('QUEUE_FULL', 'Response exceeds bridge budget');
        }
        current.postMessage(response);
      }).catch(error => {
        try { current.postMessage({ type: 'response', id, ok: false, code: errorCode(error) }); } catch {}
      }).finally(() => pending.delete(id));
    } catch { disconnect('Handshake or message rejected: PROTOCOL_MISMATCH'); }
  });
  current.onDisconnect.addListener(() => {
    const failed = chrome.runtime.lastError; // Read Chrome's error, but do not expose arbitrary host text.
    teardown(failed ? 'Native host disconnected' : 'Disconnected');
  });
  try {
    current.postMessage(wireMessage({ type: 'request', id: helloId, method: 'hello', params: {
      bootstrap: 1, versions: [wireVersion], role: 'provider', capabilities: [...providerCapabilities],
      requiredCapabilities: [...providerRequirements],
      instance: { id: instanceId, family: 'chromium', brand: __BROWSER_BRAND__,
        version: navigator.userAgent, profileLabel: 'User-authorized profile' },
    } }));
  } catch { disconnect('Native host handshake could not be sent'); }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (message.command === 'connect') connect();
    if (message.command === 'allow' && tab?.id !== undefined) {
      allowed.set(tab.id, { origin: originOf(tab.url ?? ''), scope: 'tab' }); connect();
    }
    if (message.command === 'stop' && tab?.id !== undefined) await stop(tab.id);
    return { status, tabAllowed: tab?.id !== undefined && allowed.has(tab.id), controlled: tab?.id !== undefined && gates.has(tab.id) };
  })().then(respond, error => respond({ status: String(error) }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => { void stop(id); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url && allowed.has(id)) {
    try {
      const origin = originOf(change.url), gate = gates.get(id);
      if (gate && (gate.scope ?? 'origin') === 'origin' && origin !== gate.origin) void stop(id, false);
    } catch { void stop(id); }
  }
});
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) {
    const wasAttached = attached.delete(source.tabId);
    if (wasAttached && gates.has(source.tabId)) void stop(source.tabId);
  }
});
// Payload-free, coalesced hints: page data and AX subtrees never ride the event channel.
const changeEvents = new Set(['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.lifecycleEvent',
  'DOM.documentUpdated', 'Accessibility.nodesUpdated', 'Accessibility.loadComplete']);
chrome.debugger.onEvent.addListener((source, method, params) => {
  const id = source.tabId;
  if (id !== undefined && gates.has(id)) frameSessions.get(id)?.event(source.sessionId ?? '', method, params);
  if (id !== undefined && gates.has(id) && method === 'Page.frameNavigated'
    && !source.sessionId && !(params as { frame?: { parentId?: string } })?.frame?.parentId) pager.revoke(gates.get(id)!.token + '|');
  if (id === undefined || !gates.has(id) || !changeEvents.has(method) || changeTimers.has(id)) return;
  changeTimers.set(id, setTimeout(() => {
    changeTimers.delete(id);
    const lease = gates.get(id);
    if (!lease || lease.expiresAt <= Date.now()) return;
    const sequence = (changeSequences.get(id) ?? 0) + 1; changeSequences.set(id, sequence);
    try { port?.postMessage({ type: 'event', event: 'page.changed', value: { tab: lease.tab, leaseId: lease.id, sequence } }); } catch {}
  }, 20));
});
// Connecting is not authorization in restricted mode. In explicit personal mode,
// the Broker's negotiated capability is the durable operator intent; leases still
// fence every action and are cleared on disconnect, handoff and expiry.
connect();
declare const __BROWSER_BRAND__: string;
