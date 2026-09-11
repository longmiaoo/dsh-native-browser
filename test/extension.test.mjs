import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { keyEvent } from '../dist/packages/provider-chromium/src/keyboard.js';
import { brokerCapabilities } from '../dist/packages/contracts/src/wire.js';
const source = await readFile(new URL('../dist/extension/chrome/background.js', import.meta.url), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });

async function fixture({ handshake = true, timers = { setTimeout, clearTimeout } } = {}) {
  const responses = new Map(), sent = [], commands = [];
  const tab = { id: 7, url: 'https://example.test/form', title: 'Fixture' };
  const ports = [];
  const makePort = () => {
    const p = { onMessage: event(), onDisconnect: event(), disconnected: false,
      postMessage(m) { if (this.disconnected) throw new Error('Port closed'); sent.push(m); if (m.type === 'response') responses.get(m.id)?.(m); },
      disconnect() { this.disconnected = true; },
      remoteDisconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
    ports.push(p); return p;
  };
  const chrome = { runtime: { id: 'a'.repeat(32), onMessage: event(), getURL: s => `chrome-extension://${'a'.repeat(32)}/${s}`, connectNative: makePort },
    tabs: { query: async () => [tab], get: async () => ({ ...tab }), onRemoved: event(), onUpdated: event() },
    debugger: { attach: async () => {}, detach: async source => { chrome.debugger.onDetach.emit(source); },
      sendCommand: async (_target, method, params) => { commands.push({ method, params }); return {}; }, onDetach: event(), onEvent: event() } };
  vm.runInNewContext(source, { chrome, crypto: webcrypto, navigator: { userAgent: 'Chrome fixture' },
    URL, TextEncoder, AbortController, ...timers, console });
  const ui = command => new Promise(resolve => chrome.runtime.onMessage.listeners[0]({ command },
    { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }, resolve));
  await ui('allow');
  const port = ports.at(-1);
  const hello = sent.find(m => m.method === 'hello');
  const welcome = (p = ports.at(-1), value = { version: 1, connectionEpoch: 'fixture-connection', capabilities: [...brokerCapabilities] }) =>
    p.onMessage.emit({ type: 'response', id: sent.filter(m => m.method === 'hello').at(-1).id, ok: true, value });
  if (handshake) welcome();
  const instanceId = hello.params.instance.id;
  const lease = { id: 'lease', owner: 'owner', tab: `${instanceId}:7`, instanceId, token: 'token',
    origin: 'https://example.test', expiresAt: Date.now() + 100000 };
  let counter = 0;
  const call = (method, params) => new Promise(resolve => {
    const id = `r-${++counter}`; responses.set(id, resolve);
    ports.at(-1).onMessage.emit({ type: 'request', id, method, params });
  });
  return { chrome, port, ports, welcome, hello, ui, call, lease, commands, tab, sent };
}

test('extension never dispatches a command before a valid welcome', async () => {
  const f = await fixture({ handshake: false });
  f.port.onMessage.emit({ type: 'request', id: 'early', method: 'lease.grant', params: { lease: f.lease } });
  assert.equal(f.port.disconnected, true);
  assert.equal(f.commands.length, 0);
  assert.match((await f.ui('status')).status, /PROTOCOL_MISMATCH/);
});

test('extension rejects incompatible welcomes and clears local connection without onDisconnect', async () => {
  for (const value of [{ version: 2, connectionEpoch: 'c', capabilities: [...brokerCapabilities] },
    { version: 1, connectionEpoch: 'c', capabilities: [] }, { version: 1 }]) {
    const f = await fixture({ handshake: false }); f.welcome(f.port, value);
    assert.equal(f.port.disconnected, true);
    assert.match((await f.ui('status')).status, /PROTOCOL_MISMATCH/);
    await f.ui('connect'); assert.equal(f.ports.length, 2);
    f.welcome(); assert.equal((await f.ui('status')).status, 'Connected');
  }
});

test('extension handshake deadline closes a silent host and late welcome cannot reconnect', async () => {
  const timers = new Map(); let next = 0;
  const f = await fixture({ handshake: false, timers: {
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  } });
  const deadline = [...timers.values()].find(t => t.ms === 3000); assert.ok(deadline); deadline.fn();
  assert.equal(f.port.disconnected, true); assert.equal(timers.size, 0);
  f.welcome(f.port); assert.equal((await f.ui('status')).status, 'Handshake timed out');
  assert.equal(f.commands.length, 0);
});

test('completed request replay closes the gate without repeating a side effect; obsolete port cannot revoke successor', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const params = { lease: f.lease, method: 'Input.insertText', params: { text: 'once' } };
  await f.call('cdp', params); await new Promise(resolve => setImmediate(resolve));
  f.port.onMessage.emit({ type: 'request', id: 'r-2', method: 'cdp', params });
  assert.equal(f.port.disconnected, true);
  assert.equal((await f.ui('status')).controlled, false);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 1);
  await f.ui('connect'); f.welcome();
  const hello = f.sent.filter(m => m.method === 'hello').at(-1);
  const lease = { ...f.lease, id: 'successor', token: 'new-token', instanceId: hello.params.instance.id, tab: `${hello.params.instance.id}:7` };
  assert.equal((await f.call('lease.grant', { lease })).ok, true);
  f.port.onDisconnect.emit();
  f.port.onMessage.emit({ type: 'request', id: 'old-revoke', method: 'lease.revoke', params: { lease } });
  assert.equal((await f.ui('status')).controlled, true);
  assert.equal((await f.call('cdp', { ...params, lease })).ok, true);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 2);
});

test('extension refuses input without lease and allows a current granted lease', async () => {
  const f = await fixture();
  const denied = await f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: { text: 'x' } });
  assert.equal(denied.ok, false); assert.equal(f.commands.length, 0);
  assert.equal((await f.call('lease.grant', { lease: f.lease })).ok, true);
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: { text: 'x' } })).ok, true);
  assert.equal(f.commands.at(-1).method, 'Input.insertText');
});

test('extension Stop closes the gate synchronously while a browser lookup is pending', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  let finishGet;
  f.chrome.tabs.get = async () => new Promise(resolve => { finishGet = () => resolve({ ...f.tab }); });
  const action = f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: { text: 'must not type' } });
  while (!finishGet) await new Promise(resolve => setImmediate(resolve));
  const stop = f.ui('stop');
  await new Promise(resolve => setImmediate(resolve));
  finishGet();
  assert.equal((await action).ok, false);
  await stop;
  assert.equal(f.commands.some(c => c.method === 'Input.insertText'), false);
});

test('old revoke cannot revoke a newer fencing token', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  await f.call('lease.revoke', { lease: f.lease });
  const next = { ...f.lease, id: 'new-lease', token: 'new-token' };
  await f.call('lease.grant', { lease: next });
  await f.call('lease.revoke', { lease: f.lease });
  assert.equal((await f.call('cdp', { lease: next, method: 'Page.getFrameTree', params: {} })).ok, true);
});

test('new origin, unsupported CDP and expired lease all fail closed', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Browser.close', params: {} })).ok, false);
  assert.equal((await f.call('cdp', { lease: { ...f.lease, expiresAt: 1 }, method: 'Input.insertText', params: {} })).ok, false);
  f.tab.url = 'https://different.test/';
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Input.insertText', params: {} })).ok, false);
  assert.equal(f.commands.some(c => c.method === 'Input.insertText'), false);
});

test('native disconnect prevents old-token dispatch and does not reconnect', async () => {
  const f = await fixture();
  await f.call('lease.grant', { lease: f.lease });
  f.port.remoteDisconnect();
  f.port.onMessage.emit({ type: 'request', id: 'late-old-port', method: 'cdp', params: { lease: f.lease, method: 'Input.insertText', params: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.some(c => c.method === 'Input.insertText'), false);
  assert.equal((await f.ui('status')).status, 'Disconnected');
});

test('extension navigation/readiness boundary denies cross-origin and arbitrary evaluation', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const cdp = (method, params) => f.call('cdp', { lease: f.lease, method, params });
  assert.equal((await cdp('Page.navigate', { url: 'https://elsewhere.test/' })).code, 'POLICY_DENIED');
  assert.equal((await cdp('Runtime.evaluate', { expression: 'alert(1)', returnByValue: true })).code, 'POLICY_DENIED');
  assert.equal((await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true, contextId: 42 })).code, 'POLICY_DENIED');
  assert.equal((await cdp('Page.navigate', { url: 'https://example.test/next' })).ok, true);
  assert.equal((await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).ok, true);
});

test('page change hints are coalesced, payload-free and cleared by Stop', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  for (let i = 0; i < 20; i++) f.chrome.debugger.onEvent.emit({ tabId: 7 }, 'Accessibility.nodesUpdated', { secret: 'never transmit' });
  await new Promise(resolve => setTimeout(resolve, 35));
  const hints = f.sent.filter(m => m.event === 'page.changed');
  assert.equal(hints.length, 1);
  assert.deepEqual(Object.keys(hints[0].value).sort(), ['leaseId', 'sequence', 'tab']);
  assert.equal(JSON.stringify(hints).includes('secret'), false);
  f.chrome.debugger.onEvent.emit({ tabId: 7 }, 'Page.lifecycleEvent');
  await f.ui('stop');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.sent.filter(m => m.event === 'page.changed').length, 1);
});

test('subtree CDP reads require an exact backend root and honor the same Stop gate', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    await send(target, method, params);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: f.tab.url } } };
    return { nodes: [{ nodeId: 'root', backendDOMNodeId: 30, role: { value: 'region' }, name: { value: 'Pane' } }] };
  };
  const read = request => f.call('ax.read', { lease: f.lease, request });
  for (const params of [{}, { frameId: 'frame', backendNodeId: -1 }, { frameId: 'frame', backendNodeId: 1, role: 'textbox' }, { objectId: 'guessed' }]) {
    assert.equal((await read(params)).code, 'INVALID_REQUEST');
  }
  assert.equal((await read({ frameId: 'frame', backendNodeId: 30 })).ok, true);
  for (const method of ['Accessibility.getFullAXTree', 'Accessibility.queryAXTree', 'Accessibility.getChildAXNodes']) {
    assert.equal((await f.call('cdp', { lease: f.lease, method, params: {} })).code, 'UNSUPPORTED_CAPABILITY');
  }
  await f.ui('stop');
  assert.equal((await read({ frameId: 'frame', backendNodeId: 30 })).code, 'LEASE_REVOKED');
  assert.equal(f.commands.filter(c => c.method === 'Accessibility.getPartialAXTree').length, 1);
});

test('keyboard gate permits canonical page keys and blocks shortcuts, extra commands and Stop', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const send = params => f.call('cdp', { lease: f.lease, method: 'Input.dispatchKeyEvent', params });
  const down = keyEvent('Tab', true, 'keyDown');
  for (const params of [{ ...down, modifiers: 4 }, { ...down, commands: ['selectAll'] }, { ...down, text: 'inject' },
    { ...down, code: 'KeyL', key: 'l', windowsVirtualKeyCode: 76 }]) assert.equal((await send(params)).code, 'POLICY_DENIED');
  assert.equal((await send(down)).ok, true);
  assert.equal((await send(keyEvent('Tab', true, 'keyUp'))).ok, true);
  await f.ui('stop');
  assert.equal((await send(keyEvent('Enter', false, 'keyDown'))).code, 'LEASE_REVOKED');
  assert.equal(f.commands.filter(c => c.method === 'Input.dispatchKeyEvent').length, 2);
});

test('scroll document discovery only permits a shallow non-piercing root handle', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  const read = params => f.call('cdp', { lease: f.lease, method: 'DOM.getDocument', params });
  for (const params of [{ depth: -1, pierce: false }, { depth: 0, pierce: true }, {}, { depth: 0, pierce: false, extra: true }]) {
    assert.equal((await read(params)).code, 'POLICY_DENIED');
  }
  assert.equal((await read({ depth: 0, pierce: false })).ok, true);
  await f.ui('stop');
  assert.equal((await read({ depth: 0, pierce: false })).code, 'LEASE_REVOKED');
});

test('Stop during a multi-command AX traversal discards data and prevents the next browser call', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  let finish;
  f.chrome.debugger.sendCommand = async (_target, method) => {
    f.commands.push({ method });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: f.tab.url } } };
    if (method === 'Accessibility.getRootAXNode') return { node: { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] } };
    if (method === 'Accessibility.getChildAXNodes') return new Promise(resolve => { finish = () => resolve({ nodes: [{ nodeId: '2', role: { value: 'button' }, name: { value: 'Not returned' } }] }); });
    throw new Error('Unexpected read');
  };
  const read = f.call('ax.read', { lease: f.lease, request: { frameId: 'frame' } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const stopped = f.ui('stop'); await new Promise(resolve => setImmediate(resolve));
  const count = f.commands.length; finish();
  const result = await read; await stopped;
  assert.equal(result.code, 'LEASE_REVOKED'); assert.equal(f.commands.length, count);
  assert.equal(JSON.stringify(result).includes('Not returned'), false);
});

test('AX traversal validates root-frame authority and discards navigation-time mixtures', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  let loader = 'one', reads = 0;
  f.chrome.debugger.sendCommand = async (_target, method) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: loader, url: f.tab.url } } };
    if (method === 'Accessibility.getRootAXNode') { reads++; loader = 'two'; return { node: { nodeId: '1', role: { value: 'RootWebArea' } } }; }
    throw new Error('Unexpected read');
  };
  assert.equal((await f.call('ax.read', { lease: f.lease, request: { frameId: 'other' } })).code, 'POLICY_DENIED');
  assert.equal(reads, 0);
  assert.equal((await f.call('ax.read', { lease: f.lease, request: { frameId: 'frame' } })).code, 'STALE_TARGET');
  assert.equal(reads, 1);
});

test('semantic query exposes only literal constrained filters under the same root-frame gate', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease });
  f.chrome.debugger.sendCommand = async (_target, method, params) => {
    f.commands.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'one', url: f.tab.url } } };
    if (method === 'DOM.getDocument') return { root: { backendNodeId: 1 } };
    if (method === 'Accessibility.queryAXTree') return { nodes: [{ backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'A.*' } }] };
    throw new Error('Unexpected command');
  };
  const read = request => f.call('ax.find', { lease: f.lease, request });
  for (const query of [{}, { name: '' }, { name: 'A.*', regex: true }, { name: 'A.*', selector: '*' }]) {
    assert.equal((await read({ frameId: 'frame', query })).code, 'INVALID_REQUEST');
  }
  assert.equal((await read({ frameId: 'other', query: { name: 'A.*' } })).code, 'POLICY_DENIED');
  const result = await read({ frameId: 'frame', query: { name: 'A.*', role: 'button' } });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.find(c => c.method === 'Accessibility.queryAXTree').params)),
    { backendNodeId: 1, accessibleName: 'A.*', role: 'button' });
  assert.equal((await f.call('cdp', { lease: f.lease, method: 'Accessibility.queryAXTree', params: { backendNodeId: 1 } })).code, 'UNSUPPORTED_CAPABILITY');
});

test('Stop while a semantic query is pending discards its result and does not dispatch another command', async () => {
  const f = await fixture(); await f.call('lease.grant', { lease: f.lease }); let finish;
  f.chrome.debugger.sendCommand = async (_target, method) => {
    f.commands.push({ method });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'one', url: f.tab.url } } };
    if (method === 'Accessibility.queryAXTree') return new Promise(resolve => { finish = () => resolve({ nodes: [{ backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'secret-query-result' } }] }); });
    throw new Error('Unexpected command');
  };
  const read = f.call('ax.find', { lease: f.lease, request: { frameId: 'frame', backendNodeId: 1, query: { name: 'secret-query-result' } } });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const stopped = f.ui('stop'); await new Promise(resolve => setImmediate(resolve));
  const count = f.commands.length; finish();
  const result = await read; await stopped;
  assert.equal(result.code, 'LEASE_REVOKED'); assert.equal(f.commands.length, count);
  assert.equal(JSON.stringify(result).includes('secret-query-result'), false);
});
