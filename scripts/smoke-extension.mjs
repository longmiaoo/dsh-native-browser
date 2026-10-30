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
import { extensionIdFromManifestKey } from '../dist/packages/installer/src/extension.js';
import { verifyFrameGeometryExtension } from './verify-frame-geometry-extension.mjs';

// Only native transport is substituted. The production bundle, popup permission flow,
// tabs API, debugger attachment, CDP dispatch, and Stop gate run in real MV3 Chrome.
const executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE;
if (!executablePath) throw new Error('Set DSH_CHROME_TEST_EXECUTABLE to a Chrome-for-Testing executable supporting Extensions.triggerAction');
const profile = await mkdtemp(path.join(tmpdir(), 'dsh-mv3-smoke-'));
const html = await readFile(new URL('../test/fixtures/form.html', import.meta.url));
const server = http.createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="fixture.txt"' });
    res.end('downloaded fixture');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const foreignServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><body style="margin:0;background:#c00;color:#fff">foreign frame must be redacted</body>');
});
foreignServer.listen(0, '127.0.0.1'); await once(foreignServer, 'listening');
const foreignOrigin = `http://127.0.0.1:${foreignServer.address().port}`;
let context, runtime, poller; let polling = true;
try {
  const extensionPath = path.resolve(import.meta.dirname, '../dist/extension/chrome');
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).hostname;
  const extensionManifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(extensionId, extensionIdFromManifestKey(extensionManifest.key), 'Chrome must honor the packaged stable extension ID');
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
  // Test-harness only: keep page-triggered downloads inside the isolated profile.
  await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'allow',
    downloadPath: path.join(profile, 'downloads'), eventsEnabled: true });
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
  const dispatch = events => {
    for (const event of events) { capturedEvents.push(event); for (const listener of eventListeners) listener(event.event, event.value); }
  };
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
        dispatch(events);
        if (!reply.ok) throw new BrowserError(reply.code, 'Live extension rejected request');
        return reply.value;
      } finally { signal?.removeEventListener('abort', abort); }
    },
  };
  // The production bridge delivers events continuously; this test bridge must too,
  // otherwise waits that never issue a request (chooser/download) cannot observe them.
  poller = (async () => {
    while (polling) {
      try { dispatch(await worker.evaluate(() => globalThis.__smokeBridge.events.splice(0))); } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })();
  const instance = { ...hello.params.instance, capabilities: { ax: true, screenshot: true } };
  const provider = new ChromiumProvider(instance, channel, { downloadRoot: path.join(profile, 'downloads') });
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
  await page.evaluate(() => scrollTo(0, 0));
  const visualShot = await runtime.capture(owner, lease.id, signal);
  const submitRect = await page.locator('#submit').evaluate(element => { const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const visualAction = { kind: 'visual-click', screenshotId: 'mv3-visual-shot', screenshotSha256: 'b'.repeat(64), target: '提交测试',
    viewport: visualShot.viewport, box: { x1: submitRect.x, y1: submitRect.y, x2: submitRect.x + submitRect.width, y2: submitRect.y + submitRect.height },
    point: { x: submitRect.x + submitRect.width / 2, y: submitRect.y + submitRect.height / 2 },
    expected: { kind: 'text', text: '已提交' } };
  const visual = await act('mv3-visual-click', visualAction);
  assert.equal(visual.outcome, 'succeeded');
  assert.equal(visual.visual.screenshotId, 'mv3-visual-shot');
  assert.equal(await page.evaluate(() => window.fixtureClicks.submit), 1);
  await page.evaluate(() => scrollTo(0, 240));
  const staleVisual = await act('mv3-visual-stale', { ...visualAction, expected: { kind: 'text', text: '已提交' } });
  assert.notEqual(staleVisual.outcome, 'succeeded');
  assert.equal(staleVisual.code, 'STALE_TARGET');
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.id = 'uploadInput'; input.setAttribute('aria-label', '选择文件');
    const status = document.createElement('div'); status.id = 'uploadStatus'; status.textContent = 'waiting';
    input.addEventListener('change', () => { status.textContent = input.files?.[0]?.name ?? 'none'; });
    document.body.append(input, status);
  });
  observation = await runtime.observe(owner, lease.id, signal);
  const fileInput = observation.nodes.find(n => n.name === '选择文件'); assert.ok(fileInput, 'upload file input is observable');
  const uploadPath = path.join(profile, 'upload.txt'); await writeFile(uploadPath, 'real upload content');
  assert.equal((await act('mv3-upload', { kind: 'upload', ref: fileInput.id, files: [uploadPath], expected: { kind: 'text', text: 'upload.txt' } })).outcome, 'succeeded');
  assert.equal(await page.locator('#uploadInput').evaluate(element => element.files[0]?.name), 'upload.txt');
  assert.equal(await page.locator('#uploadStatus').textContent(), 'upload.txt');
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'downloadLink'; link.href = '/download'; link.textContent = '下载附件';
    link.setAttribute('aria-label', '下载附件');
    document.body.append(link);
  });
  observation = await runtime.observe(owner, lease.id, signal);
  const downloadLink = observation.nodes.find(n => n.name === '下载附件'); assert.ok(downloadLink, 'download link is observable');
  const downloaded = await act('mv3-download', { kind: 'download', ref: downloadLink.id });
  assert.equal(downloaded.outcome, 'succeeded');
  assert.equal(downloaded.download.filename, 'fixture.txt');
  assert.equal(await readFile(downloaded.download.path, 'utf8'), 'downloaded fixture');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'dialogButton'; button.textContent = '确认弹窗'; button.setAttribute('aria-label', '确认弹窗');
    const status = document.createElement('div'); status.id = 'dialogStatus'; status.textContent = '等待确认';
    button.addEventListener('click', () => {
      window.fixtureDialogs = window.fixtureDialogs || {};
      window.fixtureDialogs.confirm = confirm('确认继续？');
      status.textContent = `确认结果：${window.fixtureDialogs.confirm}`;
    });
    document.body.append(button, status);
  });
  observation = await runtime.observe(owner, lease.id, signal);
  const dialogButton = observation.nodes.find(node => node.name === '确认弹窗'); assert.ok(dialogButton, 'dialog trigger is observable');
  const playwrightDialogs = [];
  page.on('dialog', dialog => playwrightDialogs.push(dialog));
  const clickAttempt = runtime.act(owner, { requestId: 'mv3-dialog-click', leaseId: lease.id,
    documentEpoch: observation.documentEpoch, timeoutMs: 500, action: { kind: 'click', ref: dialogButton.id } }, signal).catch(() => undefined);
  await clickAttempt;
  const handledDialog = await runtime.act(owner, { requestId: 'mv3-dialog', leaseId: lease.id,
    documentEpoch: observation.documentEpoch, timeoutMs: 5000,
    action: { kind: 'dialog', accept: true, expected: { kind: 'text', text: '确认结果：true' } } }, signal);
  assert.equal(handledDialog.outcome, 'succeeded');
  assert.equal(handledDialog.dialog.type, 'confirm');
  assert.equal(handledDialog.dialog.message, '确认继续？');
  assert.equal(handledDialog.dialog.accepted, true);
  assert.equal(await page.evaluate(() => window.fixtureDialogs.confirm), true);
  assert.equal(playwrightDialogs[0]?.type(), 'confirm');
  assert.equal((await act('mv3-nav', { kind: 'navigate', url: `${origin}/next` })).outcome, 'succeeded');
  const cleanScreenshot = await runtime.capture(owner, lease.id, signal); assert.ok(cleanScreenshot.data.length > 100);
  assert.deepEqual(cleanScreenshot.redaction, { policy: 'cross-origin-frames', frames: 0, regions: 0 });
  await page.evaluate(src => {
    const frame = document.createElement('iframe'); frame.src = src; frame.title = 'foreign fixture';
    frame.style.cssText = 'position:fixed;right:20px;top:20px;z-index:9999;width:240px;height:120px;border:4px solid red'; document.body.append(frame);
  }, `${foreignOrigin}/frame`);
  await page.locator('iframe[title="foreign fixture"]').contentFrame().locator('body').waitFor();
  const screenshot = await runtime.capture(owner, lease.id, signal); assert.ok(screenshot.data.length > 100);
  assert.deepEqual(screenshot.redaction, { policy: 'cross-origin-frames', frames: 1, regions: 1 });
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/mv3-redacted.jpg', Buffer.from(screenshot.data, 'base64'));
  await page.locator('iframe[title="foreign fixture"]').evaluate(element => element.remove());
  let foreignDetached = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const inventory = await channel.call('frames.list', { lease }, signal);
    if (inventory.frames.length === 1) { foreignDetached = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(foreignDetached, true, 'Foreign fixture detached before the same-origin frame geometry check');
  assert.ok(capturedEvents.some(e => e.event === 'page.changed'), 'Real debugger event reached the bridge');
  const frameGeometry=await verifyFrameGeometryExtension({page,worker,channel,lease,origin,signal});
  const multiA = await runtime.open(owner, instance.id, `${origin}/form.html?multi=a`, signal);
  const multiB = await runtime.open(owner, instance.id, `${origin}/form.html?multi=b`, signal);
  assert.notEqual(multiA.id, multiB.id);
  await runtime.activate(owner, multiA.id, signal);
  const multiObsA = await runtime.observe(owner, multiA.id, signal);
  const multiObsB = await runtime.observe(owner, multiB.id, signal);
  assert.equal(multiObsA.tab, multiA.tab); assert.equal(multiObsB.tab, multiB.tab);
  const workerTabId = tabHandle => Number(tabHandle.slice(`${instance.id}:`.length));
  const grouped = await worker.evaluate(async ids => {
    const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
    const groupId = tabs[0].groupId;
    const group = groupId >= 0 ? await chrome.tabGroups.get(groupId) : { title: '' };
    return { groupIds: tabs.map(tab => tab.groupId), title: group.title };
  }, [workerTabId(multiA.tab), workerTabId(multiB.tab)]);
  assert.notEqual(grouped.groupIds[0], -1);
  assert.deepEqual(grouped.groupIds, [grouped.groupIds[0], grouped.groupIds[0]]);
  assert.equal(grouped.title, 'DSH Browser');
  await runtime.close(owner, multiB.id, signal);
  await assert.rejects(runtime.observe(owner, multiB.id, signal), error => error.code === 'LEASE_REVOKED');
  assert.equal((await runtime.observe(owner, multiA.id, signal)).tab, multiA.tab);
  await runtime.activate(owner, lease.id, signal);
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
  await runtime.releaseOwner(owner);
  await assert.rejects(runtime.observe(owner, multiA.id, signal), error => error.code === 'LEASE_REVOKED');
  await assert.rejects(runtime.observe(owner, multiB.id, signal), error => error.code === 'LEASE_REVOKED');
  const report = { checkedAt: new Date().toISOString(), browserVersion: context.browser().version(),
    passed: ['Production MV3 bundle loaded', 'Toolbar action grants activeTab', 'Production popup tab approval',
      'Real chrome.debugger attachment', 'AX discovery and verified Chinese input', 'Delayed text result without replay',
      'Real visual-click from a screenshot box after hit-test and viewport checks',
      'Real multi-tab open, activate and release-all across two tabs',
      'Agent-created tabs are grouped and close removes only agent tabs',
      'Real file input upload via DOM.setFileInputFiles', 'Real attachment download via chrome.downloads',
      'Real JavaScript confirm dialog handled after a blocked click deadline',
      'Same-origin navigation', 'JPEG capture',
      'Cross-origin iframe redacted inside MV3', 'Real debugger page change events', 'Popup Stop detaches and blocks later input',
      ...frameGeometry.checks,'Popup Stop denies subsequent bound frame geometry'],
    scope: 'Real isolated Chrome MV3 extension and runtime; native port is a test bridge, not Native Messaging or DSH/model end-to-end' };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/mv3-smoke.json', JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({ path: 'output/playwright/mv3-smoke.png' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  polling = false;
  if (poller) await poller.catch(() => {});
  await runtime?.dispose(); await context?.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => foreignServer.close(resolve));
  // Only the profile created by this process, after the owned browser exits.
  await rm(profile, { recursive: true });
}
