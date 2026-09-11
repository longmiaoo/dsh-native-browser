import { BrowserError, checkAbort, errorCode, originOf, type Lease } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import { allowedKeyEvent } from '../../provider-chromium/src/keyboard.js';
import { allowedMouseEvent } from '../../provider-chromium/src/mouse.js';
import { axReadRequest, readAXTree } from '../../provider-chromium/src/ax-reader.js';
import { axFindRequest, findAXNodes } from '../../provider-chromium/src/ax-query.js';
import { wireMessage, acceptWelcome, providerCapabilities, providerRequirements, wireVersion } from '../../contracts/src/wire.js';

const HOST = 'com.longmiaoo.dsh_native_browser';
const allowed = new Map<number, string>();
const gates = new Map<number, Lease>();
const attached = new Set<number>();
const queues = new Map<number, Promise<unknown>>();
const changeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const changeSequences = new Map<number, number>();
let port: chrome.runtime.Port | undefined;
let instanceId = crypto.randomUUID();
let status = 'Disconnected';
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
  return { id: string(v.id), owner: string(v.owner, 1024), tab: string(v.tab), instanceId: string(v.instanceId),
    token: string(v.token), origin: originOf(string(v.origin)), expiresAt: Number(v.expiresAt) };
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
  if (gates.get(id)?.token !== lease.token || allowed.get(id) !== lease.origin || lease.expiresAt <= Date.now()) {
    throw new BrowserError('LEASE_REVOKED', 'Local control gate is closed');
  }
  return id;
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
  clearTimeout(changeTimers.get(id)); changeTimers.delete(id);
  changeSequences.delete(id);
  if (forget) allowed.delete(id);
  if (lease) { try { port?.postMessage({ type: 'event', event: 'lease.revoked', value: { leaseId: lease.id } }); } catch {} }
  return enqueue(id, async () => {
    if (attached.has(id)) { attached.delete(id); await chrome.debugger.detach({ tabId: id }).catch(() => {}); }
  });
}

async function execute(method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
  const p = record(raw);
  if (method === 'tabs.list') {
    const result = [];
    for (const [id, origin] of allowed) {
      const tab = await chrome.tabs.get(id).catch(() => undefined);
      if (tab?.url && originOf(tab.url) === origin) result.push({ id: `${instanceId}:${id}`, instanceId, url: tab.url, title: tab.title ?? '' });
    }
    return result;
  }
  const lease = leaseOf(p.lease), id = tabIdOf(lease);
  if (method === 'lease.grant') {
    if (gates.has(id)) throw new BrowserError('LEASE_BUSY', 'Tab already controlled');
    if (allowed.get(id) !== lease.origin) throw new BrowserError('POLICY_DENIED', 'Allow this tab from the extension popup first');
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
  if (method === 'ax.read' || method === 'ax.find') {
    const request = method === 'ax.find' ? axFindRequest(p.request) : axReadRequest(p.request);
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
      const result = method === 'ax.find' ? await findAXNodes(axFindRequest(p.request), send, signal)
        : await readAXTree(request, send, signal);
      const after = (await send('Page.getFrameTree', {})).frameTree?.frame;
      if (!after || after.id !== before.id || after.loaderId !== before.loaderId || originOf(after.url) !== lease.origin) {
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
    if (command === 'Page.navigate' && originOf(string(params.url, 8192)) !== lease.origin) {
      throw new BrowserError('POLICY_DENIED', 'Navigation target is outside the lease origin');
    }
    if (command === 'Runtime.evaluate' && (params.expression !== 'document.readyState' || params.returnByValue !== true
      || Object.keys(params).some(key => !['expression', 'returnByValue'].includes(key)))) {
      throw new BrowserError('POLICY_DENIED', 'Only the fixed document-readiness query is exposed');
    }
    return enqueue(id, async () => {
      await ensure(lease, signal);
      // No await between final gate check and browser dispatch.
      checkGate(lease, signal);
      return await chrome.debugger.sendCommand({ tabId: id }, command, params);
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
        acceptWelcome(m.value, providerRequirements);
        clearTimeout(helloTimer); accepted = true; status = 'Connected';
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
      allowed.set(tab.id, originOf(tab.url ?? '')); connect();
    }
    if (message.command === 'stop' && tab?.id !== undefined) await stop(tab.id);
    return { status, tabAllowed: tab?.id !== undefined && allowed.has(tab.id), controlled: tab?.id !== undefined && gates.has(tab.id) };
  })().then(respond, error => respond({ status: String(error) }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => { void stop(id); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url && allowed.has(id)) {
    try { if (originOf(change.url) !== allowed.get(id)) void stop(id); } catch { void stop(id); }
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
chrome.debugger.onEvent.addListener((source, method) => {
  const id = source.tabId;
  if (id === undefined || !gates.has(id) || !changeEvents.has(method) || changeTimers.has(id)) return;
  changeTimers.set(id, setTimeout(() => {
    changeTimers.delete(id);
    const lease = gates.get(id);
    if (!lease || lease.expiresAt <= Date.now()) return;
    const sequence = (changeSequences.get(id) ?? 0) + 1; changeSequences.set(id, sequence);
    try { port?.postMessage({ type: 'event', event: 'page.changed', value: { tab: lease.tab, leaseId: lease.id, sequence } }); } catch {}
  }, 20));
});
// MV3 restarts deliberately restore no leases and do not reconnect without user intent.
declare const __BROWSER_BRAND__: string;
