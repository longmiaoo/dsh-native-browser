import assert from 'node:assert/strict';
import { brokerCapabilities } from '../dist/packages/contracts/src/wire.js';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { verifyFrameGeometryExtension } from './verify-frame-geometry-extension.mjs';

// Only native transport is substituted. The production bundle, popup permission flow,
// tabs API, debugger attachment, CDP dispatch, and Stop gate run in real MV3 Chrome.
const executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE;
if (!executablePath) throw new Error('Set DSH_CHROME_TEST_EXECUTABLE to a Chrome-for-Testing executable supporting Extensions.triggerAction');
const profile = await mkdtemp(path.join(tmpdir(), 'dsh-mv3-smoke-'));
const html = await readFile(new URL('../test/fixtures/form.html', import.meta.url));
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let context, runtime;
try {
  const extensionPath = path.resolve(import.meta.dirname, '../dist/extension/chrome');
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(() => {
    const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of this.listeners) fn(value); } });
    const bridge = globalThis.__smokeBridge = { sent: [], pending: new Map(), events: [] };
    const port = bridge.port = { onMessage: event(), onDisconnect: event(),
      postMessage(message) {
        bridge.sent.push(message);
        if (message.type === 'event') bridge.events.push(message);
        if (message.type === 'response') { bridge.pending.get(message.id)?.(message); bridge.pending.delete(message.id); }
      }, disconnect() { this.disconnected = true; } };
    chrome.runtime.connectNative = () => port;
  });
  const page = context.pages()[0]; await page.goto(`${origin}/`);
  const browserCDP = await context.browser().newBrowserCDPSession();
  // The experimental test API runs the real toolbar action and grants activeTab.
  const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tabTarget = targetInfos.find(t => t.url === page.url()); assert.ok(tabTarget);
  await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
  // A separate popup document is scriptable by the test driver. The active tab stays
  // the fixture; sender identity and all production popup handlers remain unchanged.
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.evaluate(() => document.querySelector('#allow').click());
  const hello = await worker.evaluate(async () => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const hello = globalThis.__smokeBridge.sent.find(m => m.method === 'hello');
      if (hello) return hello;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Production popup did not start native connection');
  });
  await worker.evaluate(({ helloId, capabilities }) => globalThis.__smokeBridge.port.onMessage.emit({ type: 'response', id: helloId, ok: true,
    value: { version: 1, connectionEpoch: 'isolated-mv3-test', capabilities } }), { helloId: hello.id, capabilities: [...brokerCapabilities] });
  let counter = 0;
  const eventListeners = new Set(), capturedEvents = [];
  const channel = {
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    async call(method, params, signal) {
      if (signal?.aborted) throw new BrowserError('CANCELLED', 'Test caller cancelled');
      const id = `smoke-${++counter}`;
      const abort = () => { void worker.evaluate(id => globalThis.__smokeBridge.port.onMessage.emit({ type: 'cancel', id }), id).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const { reply, events } = await worker.evaluate(async message => {
          const bridge = globalThis.__smokeBridge;
          const reply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { bridge.pending.delete(message.id); reject(new Error('Extension response timeout')); }, 5000);
            bridge.pending.set(message.id, response => { clearTimeout(timer); resolve(response); });
            bridge.port.onMessage.emit(message);
          });
          return { reply, events: bridge.events.splice(0) };
        }, { type: 'request', id, method, params });
        for (const event of events) { capturedEvents.push(event); for (const listener of eventListeners) listener(event.event, event.value); }
        if (!reply.ok) throw new BrowserError(reply.code, 'Live extension rejected request');
        return reply.value;
      } finally { signal?.removeEventListener('abort', abort); }
    },
  };
  const instance = { ...hello.params.instance, capabilities: { ax: true, screenshot: true } };
  const provider = new ChromiumProvider(instance, channel);
  runtime = new BrowserRuntime(async request => new URL(request.tab.url).origin === origin);
  runtime.register(provider);
  const signal = AbortSignal.timeout(20000), owner = 'mv3-smoke';
  const tabs = await runtime.listTabs(instance.id, signal); assert.equal(tabs.length, 1); assert.equal(tabs[0].url, `${origin}/`);
  const lease = await runtime.claim(owner, instance.id, tabs[0].id, signal);
  let observation = await runtime.observe(owner, lease.id, signal);
  const act = async (requestId, action) => {
    const result = await runtime.act(owner, { requestId, leaseId: lease.id, documentEpoch: observation.documentEpoch, action }, signal);
    if (result.observation) observation = result.observation;
    return result;
  };
  const field = observation.nodes.find(n => n.name === '搜索词'); assert.ok(field);
  assert.equal((await act('mv3-fill', { kind: 'fill', ref: field.id, text: '真实 MV3 输入' })).outcome, 'succeeded');
  assert.equal(await page.locator('#query').inputValue(), '真实 MV3 输入');
  const delayed = observation.nodes.find(n => n.name === '延迟反馈'); assert.ok(delayed);
  assert.equal((await act('mv3-click', { kind: 'click', ref: delayed.id, expected: { kind: 'text', text: '延迟保存成功' } })).outcome, 'succeeded');
  assert.equal(await page.evaluate(() => window.fixtureClicks.delayed), 1);
  assert.equal((await act('mv3-nav', { kind: 'navigate', url: `${origin}/next` })).outcome, 'succeeded');
  const screenshot = await runtime.capture(owner, lease.id, signal); assert.ok(screenshot.data.length > 100);
  assert.ok(capturedEvents.some(e => e.event === 'page.changed'), 'Real debugger event reached the bridge');
  const frameGeometry=await verifyFrameGeometryExtension({page,worker,channel,lease,origin,signal});
  await popup.evaluate(() => document.querySelector('#stop').click());
  // Wait for the actual popup response, not a fixed delay.
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('未授权'));
  const nextField = observation.nodes.find(n => n.name === '搜索词');
  const stopped = await act('after-stop', { kind: 'fill', ref: nextField.id, text: 'must not type' });
  assert.notEqual(stopped.outcome, 'succeeded'); assert.equal(stopped.dispatch, 'notDispatched');
  assert.equal(await page.locator('#query').inputValue(), '');
  // getTargets().attached also includes Playwright's own connection. Check that
  // THIS extension cannot use the debugger after its Stop handler has settled.
  const detached = await worker.evaluate(async tabId => {
    try { await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'); return false; }
    catch (error) { return /not attached/i.test(String(error)); }
  }, Number(lease.tab.slice(`${instance.id}:`.length)));
  assert.equal(detached, true);
  await assert.rejects(channel.call('frame.geometry',{lease,request:frameGeometry.request},signal),{code:'LEASE_REVOKED'});
  await runtime.release(owner, lease.id);
  const report = { checkedAt: new Date().toISOString(), browserVersion: context.browser().version(),
    passed: ['Production MV3 bundle loaded', 'Toolbar action grants activeTab', 'Production popup tab approval',
      'Real chrome.debugger attachment', 'AX discovery and verified Chinese input', 'Delayed text result without replay',
      'Same-origin navigation', 'JPEG capture', 'Real debugger page change events', 'Popup Stop detaches and blocks later input',
      ...frameGeometry.checks,'Popup Stop denies subsequent bound frame geometry'],
    scope: 'Real isolated Chrome MV3 extension and runtime; native port is a test bridge, not Native Messaging or DSH/model end-to-end' };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/mv3-smoke.json', JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({ path: 'output/playwright/mv3-smoke.png' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime?.dispose(); await context?.close();
  await new Promise(resolve => server.close(resolve));
  // Only the profile created by this process, after the owned browser exits.
  await rm(profile, { recursive: true });
}
