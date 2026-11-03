import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

// Installed tarball -> real LaunchAgent -> Chrome-started Native Host -> MV3
// -> actual DSH ToolRuntime. Only temporary profiles/registrations are used.
const root = path.resolve(import.meta.dirname, '..');
const hostRoot = process.argv[2], executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE;
// Allows acceptance while the user has a live Broker, without unloading it.
const noService = process.argv.includes('--no-service');
const verifyRenewal = process.argv.includes('--lease-renewal');
if (process.platform !== 'darwin' || !hostRoot || !executablePath) throw Error('Requires macOS, an installed DSH directory and DSH_CHROME_TEST_EXECUTABLE');
const exec = promisify(execFile), temporary = await mkdtemp('/tmp/dsh-install-');
const profile = path.join(temporary, 'profile'), directory = path.join(temporary, 'runtime');
const plistDirectory = path.join(temporary, 'agents');
const passed = []; let browser, ctx, service, installer, server, isolatedBroker, cleanupComplete = false;
const report = { checkedAt: new Date().toISOString(), passed,
  scope: 'Installed npm tarball, real macOS LaunchAgent, temporary Chrome-for-Testing profile and Native Messaging registration, actual DSH ToolRuntime with default plugin approval mode. Deterministic tool calls; no LLM, daily user profile or business account.' };
if (noService) report.scope = report.scope.replace('real macOS LaunchAgent', 'isolated in-process Broker (no LaunchAgent changes)');
const eventual = async (check, label, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 50)); }
  throw Error(`Timed out: ${label}`);
};
try {
  const installedService = await import('../dist/packages/installer/src/service.js');
  if (!noService) assert.equal(await installedService.serviceIsLoaded(), false, 'Refusing to disturb an existing user Broker service');
  const archive = (await exec('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', temporary], { cwd: root })).stdout.trim().split('\n').at(-1);
  const consumer = path.join(temporary, 'consumer'); await mkdir(consumer);
  await exec('pnpm', ['add', '--dir', consumer, '--ignore-scripts', path.join(temporary, archive)]);
  const packageRoot = path.join(consumer, 'node_modules', 'dsh-native-browser');
  const loadPackage = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
  installer = await loadPackage('dist/packages/installer/src/service.js');
  const { quickInstall } = await loadPackage('dist/packages/installer/src/quick-install.js');
  const { diagnose } = await loadPackage('dist/packages/installer/src/doctor.js');
  const { extensionIdFromManifestKey } = await loadPackage('dist/packages/installer/src/extension.js');
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'dist/extension/chrome/manifest.json'), 'utf8'));
  const options = { browser: 'chrome', extensionSource: path.join(packageRoot, 'dist/extension/chrome'),
    extensionId: extensionIdFromManifestKey(manifest.key), directory, cliPath: path.join(packageRoot, 'bin/dsh-native-browser.mjs'),
    plistDirectory, manifestDir: path.join(profile, 'NativeMessagingHosts'), open: false, service: !noService };
  const installed = await quickInstall(options); service = installed.service;
  if (!noService) { assert.ok(service.loaded); assert.ok(await installer.serviceIsLoaded()); }
  const token = await readFile(path.join(directory, 'auth-token'));
  const repeated = await quickInstall(options); service = repeated.service;
  assert.equal(repeated.extensionPath, installed.extensionPath);
  assert.deepEqual(await readFile(path.join(directory, 'auth-token')), token);
  if (noService) {
    const { startBroker } = await loadPackage('dist/packages/broker/src/server.js');
    isolatedBroker = await startBroker({ directory, accessMode: 'personal', allowedOrigins: [] });
    passed.push('Installed tarball uses an isolated personal Broker; repeated install preserves path and authentication without touching the user service');
  } else passed.push('Installed tarball starts a real LaunchAgent Broker; repeated install restarts it at the same extension path and preserves authentication');

  server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><title>安装验收表单</title><body><h1>安装验收</h1><label for="query">搜索词</label><input id="query"><button id="submit">提交测试</button><p id="result">尚未提交</p><script>document.querySelector("#submit").onclick=()=>document.querySelector("#result").textContent="已提交："+document.querySelector("#query").value</script></body></html>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${installed.extensionPath}`, `--load-extension=${installed.extensionPath}`] });
  report.browserVersion = browser.browser().version();
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname; assert.equal(extensionId, installed.extensionId);
  const page = browser.pages()[0]; await page.goto(origin);
  const cdp = await browser.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(t => t.url === page.url()).targetId });
  const popup = await browser.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`); await page.bringToFront();
  const popupCommand = command => {
    assert.notEqual(command, 'allow', 'Default personal acceptance must not grant individual tabs');
    return popup.evaluate(command => chrome.runtime.sendMessage({ command }), command);
  };
  // Personal mode must work without invoking the popup's per-tab allow action.
  try { await eventual(async () => (await popupCommand('status')).status.startsWith('Connected'), 'native connection'); }
  catch (error) {
    console.error('Popup connection evidence:', JSON.stringify(await popupCommand('status')));
    console.error('Broker startup evidence:', await readFile(path.join(directory, 'broker.stderr.log'), 'utf8').catch(() => 'No service log (isolated Broker)'));
    throw error;
  }
  const diagnostics = { directory, brand: 'chrome', extensionId, manifestDir: options.manifestDir };
  assert.equal((await diagnose(diagnostics)).status, 'ready');
  passed.push('Chrome loads the staged extension, launches the installed Native Host and doctor reports ready');

  const hostRequire = createRequire(path.join(path.resolve(hostRoot), 'package.json'));
  const load = name => import(hostRequire.resolve(name));
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
  const { Session, SessionId } = await load('@deepseek-ai/dsh-session');
  const { LocalAttachmentStore } = await load('@deepseek-ai/dsh-attachment-local');
  report.dshVersion = JSON.parse(await readFile(path.join(hostRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
  ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  await ctx.plugin(LocalAttachmentStore, { dshHome: path.join(temporary, 'attachments') });
  let foreground;
  ctx.provide('connection', { rpc: { handle: (_route, handler) => { foreground = handler; return () => {}; } } });
  ctx.tools.register({ name: 'browser_claim', description: 'Other-plugin namespace fixture',
    parameters: { type: 'object', properties: {} }, output: { schema: {}, render: () => [] }, execute: async () => ({ untouched: true }) });
  const plugin = await loadPackage('index.js');
  await ctx.plugin(plugin, { runtimeDirectory: directory });
  const names = ctx.tools.schemas().map(t => t.name);
  assert.equal(names.filter(n => n.startsWith('native_browser_')).length, 14); assert.ok(names.includes('browser_claim'));
  passed.push('All 14 native_browser tools register beside an existing browser_claim tool without aliases or collisions');
  const session = Session.create(SessionId('installation-acceptance')); session.append('turn/start', { turn: 1 });
  let number = 0;
  const call = async (short, args) => {
    const result = await ctx.tools.execute({ name: `native_browser_${short}`, callId: `install-${++number}`,
      arguments: args, agent: { session }, signal: AbortSignal.timeout(15000) });
    assert.equal(result.isError, false, JSON.stringify(result.content)); return result.value;
  };
  const [instance] = await call('list', {});
  const tabs = await call('list', { instanceId: instance.id });
  let lease = await call('claim', { instanceId: instance.id, tab: tabs.find(t => t.url.startsWith(origin)).id });
  await eventual(() => page.locator('[data-dsh-activity="v1"]').count(), 'control indicator before input');
  assert.equal(await page.locator('[data-dsh-pointer="v1"]').count(), 0, 'Claim/read must not invent a mouse target');
  let observation = await call('observe', { leaseId: lease.id });
  const ref = name => { const node = observation.nodes.find(n => n.name === name); assert.ok(node, name); return node.id; };
  let acted = await call('act', { leaseId: lease.id, requestId: 'install-fill', documentEpoch: observation.documentEpoch,
    action: { kind: 'fill', ref: ref('搜索词'), text: '正式版安装验收' } });
  assert.equal(acted.outcome, 'succeeded'); observation = acted.observation;
  await eventual(() => page.locator('[data-dsh-pointer="v1"]').count(), 'keyboard-only fill pointer before any click');
  assert.notEqual(await page.locator('[data-dsh-pointer="v1"]').evaluate(node => node.style.opacity), '0');
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output/playwright/installation-keyboard-pointer.png') });
  acted = await call('act', { leaseId: lease.id, requestId: 'install-key', documentEpoch: observation.documentEpoch,
    action: { kind: 'press', ref: ref('搜索词'), key: 'ArrowLeft' } });
  observation = acted.observation;
  assert.ok(await page.locator('[data-dsh-pointer="v1"]').count());
  await page.evaluate(() => {
    window.feedbackFrames = []; window.recordFeedback = true;
    const sample = () => {
      const node = document.querySelector('[data-dsh-pointer="v1"]');
      if (node?.dataset.moving === 'true') {
        const m = new DOMMatrixReadOnly(getComputedStyle(node).transform);
        window.feedbackFrames.push({ x: m.m41 + 2, y: m.m42 + 2 });
      }
      if (window.recordFeedback) requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
  });
  acted = await call('act', { leaseId: lease.id, requestId: 'install-click', documentEpoch: observation.documentEpoch,
    action: { kind: 'click', ref: ref('提交测试'), expected: { kind: 'text', text: '已提交：正式版安装验收' } } });
  assert.equal(acted.outcome, 'succeeded'); assert.equal(await page.locator('#result').innerText(), '已提交：正式版安装验收');
  await eventual(() => page.locator('[data-dsh-pointer="v1"]').evaluate(node => node.dataset.moving === 'false'), 'installed cursor arrives at click target');
  const movement = await page.evaluate(() => { window.recordFeedback = false; return window.feedbackFrames; });
  assert.ok(movement.length > 1 && new Set(movement.map(p => p.x)).size > 1, 'Actual DSH fill-to-click action path must produce multiple moving frames');
  await page.screenshot({ path: path.join(root, 'output/playwright/installation-smooth-click.png') });
  passed.push('Actual packed DSH fill-to-click path produces multiple rendered movement frames without delaying input');
  const shot = await call('screenshot', { leaseId: lease.id }); assert.ok(shot.attachment);
  if (verifyRenewal) {
    assert.equal(instance.capabilities.leaseRenewal, true);
    const until = lease.expiresAt + 2000;
    console.error('Renewal acceptance: waiting beyond the original two-minute deadline with no browser-tool activity.');
    while (Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(5000, until - Date.now())));
    assert.equal(await page.locator('[data-dsh-activity="v1"]').count(), 1);
    assert.equal(await page.locator('[data-dsh-pointer="v1"]').count(), 1);
    const result = await call('act', { leaseId: lease.id, requestId: 'after-default-lease-deadline', documentEpoch: observation.documentEpoch,
      action: { kind: 'fill', ref: ref('搜索词'), text: '真实两分钟续期验收' } });
    assert.equal(result.outcome, 'succeeded'); assert.equal(await page.locator('#query').inputValue(), '真实两分钟续期验收');
    report.renewal = { originalExpiresAt: lease.expiresAt, actedAt: Date.now(), exceededOriginalDeadline: true,
      lifetimeMs: 120000, mode: 'personal', foregroundIndicator: true, pointer: true };
    passed.push('Packed default personal mode survives the real two-minute deadline without tool polling, preserves pointer/activity and performs a verified input with the original lease/ref');
  }
  await call('handoff', { leaseId: lease.id });
  await eventual(async () => (await page.locator('[data-dsh-pointer="v1"]').count()) === 0, 'pointer removed on handoff');
  assert.equal(await page.locator('[data-dsh-activity="v1"]').count(),0,'Handoff removes the control indicator');
  passed.push('Fill and keyboard actions show a pointer without a synthetic click; handoff removes it');
  passed.push('Installed package performs Chinese fill, verified click, Host-owned screenshot and handoff through real DSH tools');

  // Public sites supplement local fixtures; no account or external submission.
  await page.goto('https://example.com/', { timeout: 30000 }); await page.bringToFront();
  const publicTabs = await call('list', { instanceId: instance.id });
  lease = await call('claim', { instanceId: instance.id, tab: publicTabs.find(t => t.url.startsWith('https://example.com')).id });
  observation = await call('observe', { leaseId: lease.id });
  assert.equal(observation.title, 'Example Domain'); assert.ok(observation.text.length > 0);
  const publicLink = observation.nodes.find(node => node.role === 'link');
  assert.ok(publicLink, 'public page link is observable');
  const wheeled = await call('act', { leaseId: lease.id, requestId: 'public-pointer-wheel', documentEpoch: observation.documentEpoch,
    action: { kind: 'wheel', ref: publicLink.id, deltaX: 0, deltaY: 100 } });
  assert.notEqual(wheeled.dispatch, 'notDispatched');
  await eventual(() => page.locator('[data-dsh-pointer="v1"]').count(), 'visible virtual pointer');
  assert.notEqual(await page.locator('[data-dsh-pointer="v1"]').evaluate(node => node.style.opacity), '0');
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output/playwright/installation-pointer.png') });
  passed.push('Real HTTPS-page wheel dispatch renders the virtual pointer without external submission; no scroll-success claim');
  const opened = await call('open', { instanceId: instance.id, url: 'https://github.com/longmiaoo/dsh-native-browser' });
  await call('activate', { leaseId: opened.id });
  const docs = await eventual(async () => {
    const view = await call('observe', { leaseId: opened.id });
    return view.title.includes('longmiaoo/dsh-native-browser') && view.text.length > 0 ? view : false;
  }, 'public GitHub repository', 20000);
  assert.ok(docs.url.startsWith('https://github.com/longmiaoo/dsh-native-browser'));
  await call('close', { leaseId: opened.id });
  await call('handoff', { leaseId: lease.id });
  passed.push('Read-only public Example Domain and GitHub repository reads plus agent-tab open, activate and close passed');

  await page.goto(origin); await page.bringToFront();
  const finalTabs = await call('list', { instanceId: instance.id });
  lease = await call('claim', { instanceId: instance.id, tab: finalTabs.find(t => t.url.startsWith(origin)).id });
  const switched = await foreground('foreground', { clientId: '11111111-1111-4111-8111-111111111111',
    revision: 1, issuedAt: Date.now(), sessionId: 'another-conversation' }, AbortSignal.timeout(3000));
  assert.equal(switched.value.released, 1);
  const revoked = await ctx.tools.execute({ name: 'native_browser_observe', callId: 'after-switch', arguments: { leaseId: lease.id }, agent: { session }, signal: AbortSignal.timeout(5000) });
  assert.equal(revoked.isError, true);
  const backgroundClaim = await ctx.tools.execute({ name: 'native_browser_claim', callId: 'background-reclaim', arguments: { instanceId: instance.id, tab: lease.tab }, agent: { session }, signal: AbortSignal.timeout(5000) });
  assert.equal(backgroundClaim.isError, true);
  passed.push('Foreground conversation RPC revokes the installed native stack lease before another conversation can use it (UI notification simulated)');
  await foreground('foreground', { clientId: '11111111-1111-4111-8111-111111111111', revision: 2,
    issuedAt: Date.now(), sessionId: session.id }, AbortSignal.timeout(3000));
  lease = await call('claim', { instanceId: instance.id, tab: finalTabs.find(t => t.url.startsWith(origin)).id });
  await popupCommand('stop');
  const stopped = await ctx.tools.execute({ name: 'native_browser_observe', callId: 'after-stop', arguments: { leaseId: lease.id }, agent: { session }, signal: AbortSignal.timeout(5000) });
  assert.equal(stopped.isError, true);
  passed.push('Real extension Stop invalidates the held DSH lease');
  const temporaryPage = await call('open', { instanceId: instance.id, url: origin + '/temporary' });
  const deliveredPage = await call('open', { instanceId: instance.id, url: origin + '/deliverable' });
  const pendingPage = await call('open', { instanceId: instance.id, url: origin + '/waiting' });
  await call('task', { action: 'mark', leaseId: deliveredPage.id, purpose: 'deliverable' });
  await call('task', { action: 'mark', leaseId: pendingPage.id, purpose: 'handoff' });
  const cleanup = await call('task', { action: 'finish' });
  assert.equal(cleanup.closed, 1); assert.equal(cleanup.retained, 2); assert.equal(cleanup.skipped, 0);
  const remainingTabs = await call('list', { instanceId: instance.id });
  assert.equal(remainingTabs.some(t => t.id === temporaryPage.tab), false);
  assert.ok(remainingTabs.some(t => t.id === deliveredPage.tab));
  assert.ok(remainingTabs.some(t => t.id === pendingPage.tab));
  assert.equal(page.isClosed(), false);
  const repeatedCleanup = await call('task', { action: 'finish' }); assert.equal(repeatedCleanup.closed, 0);
  const autoPage = await call('open', { instanceId: instance.id, url: origin + '/auto-cleanup' });
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await eventual(async () => { try { return !(await call('list', { instanceId: instance.id })).some(t => t.id === autoPage.tab); } catch { return false; } }, 'completed-turn automatic cleanup');
  passed.push('Task finish closes only its temporary page, preserves deliverable/handoff/user tabs, repeats safely, and a completed Host turn automatically cleans an unmarked page');
  report.outcome = 'passed';
} catch (error) { report.outcome = 'failed'; report.failure = error.message; console.error(error); process.exitCode = 1; }
finally {
  await ctx?.fiber.dispose(); await browser?.close(); await isolatedBroker?.close();
  if (installer) {
    const plistExists = await access(path.join(plistDirectory, `${installer.SERVICE_LABEL}.plist`)).then(() => true, () => false);
    if (plistExists) {
      await installer.uninstallBrokerService({ directory, plistDirectory });
      await eventual(async () => !await installer.serviceIsLoaded(), 'LaunchAgent removal');
    }
  }
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true }); cleanupComplete = true;
  report.cleanupComplete = cleanupComplete;
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await writeFile(path.join(root, 'output/playwright/installation-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
