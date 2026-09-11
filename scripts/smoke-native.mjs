import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as plugin from '../index.js';
import { startIsolatedBroker } from './isolated-broker.mjs';
import { installHost } from '../dist/packages/installer/src/install.js';
import { uninstallHost } from '../dist/packages/installer/src/uninstall.js';
import { providerCapabilities, providerRequirements } from '../dist/packages/contracts/src/wire.js';
import { diagnose } from '../dist/packages/installer/src/doctor.js';
import { applyObservationUpdate } from 'dsh-native-browser/observations';
import { verifyKeyboard } from './verify-keyboard.mjs';
import { verifyEditable } from './verify-editable.mjs';
import { verifyAppend } from './verify-append.mjs';
import { verifyElementState } from './verify-element-state.mjs';
import { verifyScroll } from './verify-scroll.mjs';
import { verifyActionability } from './verify-actionability.mjs';
import { verifyLargeObservation } from './verify-large-observation.mjs';
import { verifySemanticQuery } from './verify-semantic-query.mjs';
import { verifyChecked } from './verify-checked.mjs';
import { verifyCheckLabels } from './verify-check-labels.mjs';
import { verifyWheel } from './verify-wheel.mjs';
import { verifyRadio } from './verify-radio.mjs';
import { verifyScreenshotPublication } from './verify-screenshot-publication.mjs';

// Full local transport: DSH tools -> Unix socket -> Broker -> Native Host stdio
// -> Chrome nativeMessaging -> production MV3 debugger -> loopback fixture.
// No model, user profile, native port mock, or renderer execution seam is used.
const executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE, hostRoot = process.argv[2];
if (!executablePath || !hostRoot) throw new Error('Set DSH_CHROME_TEST_EXECUTABLE and pass the installed @deepseek-ai/dsh directory');
const hostRequire = createRequire(path.join(path.resolve(hostRoot), 'package.json'));
const load = name => import(hostRequire.resolve(name));
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
const { Session, SessionId } = await load('@deepseek-ai/dsh-session');
const { LocalAttachmentStore } = await load('@deepseek-ai/dsh-attachment-local');
const directory = await mkdtemp(path.join(tmpdir(), 'dsh-native-smoke-'));
const profile = path.join(directory, 'chrome-profile');
const html = await readFile(new URL('../test/fixtures/form.html', import.meta.url));
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browserContext, broker, ctx;
const passed = [];
const observationMetrics = {};
const serializedBytes = value => Buffer.byteLength(JSON.stringify(value));
const pageContent = ({ format, cursor, resyncRequired, resyncReason, revision, ...content }) => content;
const eventually = async (check, description, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
};
try {
  broker = await startIsolatedBroker({ directory, allowedOrigins: [origin] });
  passed.push('Production Broker CLI runs in its own Node process with exclusive lifetime ownership');
  const extensionPath = path.resolve(import.meta.dirname, '../dist/extension/chrome');
  browserContext = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = browserContext.serviceWorkers()[0] ?? await browserContext.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).hostname;
  const installOptions = { directory, extensionId, brand: 'chrome',
    cliPath: path.resolve(import.meta.dirname, '../bin/dsh-native-browser.mjs'),
    manifestDir: path.join(profile, 'NativeMessagingHosts') };
  const installed = await installHost(installOptions);
  assert.ok(installed.manifest.startsWith(profile + path.sep));
  const installFiles = [installed.manifest, installed.launcher, path.join(directory, 'native-host.json'), path.join(directory, 'auth-token')];
  const beforeInstall = await Promise.all(installFiles.map(async file => ({ bytes: await readFile(file), stat: await lstat(file, { bigint: true }) })));
  assert.deepEqual(await installHost(installOptions), installed);
  for (let i=0;i<installFiles.length;i++) {
    assert.ok((await readFile(installFiles[i])).equals(beforeInstall[i].bytes));
    assert.equal((await lstat(installFiles[i], { bigint: true })).ino, beforeInstall[i].stat.ino);
  }
  passed.push('Repeated production host installation preserves registration files and runtime identity while Broker is live');
  const page = browserContext.pages()[0]; await page.goto(`${origin}/`);
  const browserCDP = await browserContext.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const target = targetInfos.find(t => t.url === page.url()); assert.ok(target);
  await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  const popup = await browserContext.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const popupCommand = async command => popup.evaluate(command => chrome.runtime.sendMessage({ command }), command);
  await popupCommand('allow');
  await eventually(async () => (await popupCommand('status')).status === 'Connected', 'real native host handshake');
  passed.push('Chrome-started Native Host from isolated profile manifest');
  const diagnosticOptions = { directory, brand: 'chrome', extensionId, manifestDir: path.join(profile, 'NativeMessagingHosts') };
  const diagnostic = await diagnose(diagnosticOptions);
  assert.equal(diagnostic.status, 'ready', JSON.stringify(diagnostic));
  assert.deepEqual(diagnostic.connection, { connected: true, instanceCount: 1, matchingBrowserCount: 1 });
  passed.push('Read-only doctor validates real isolated installation and Chrome connection');

  ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  await ctx.plugin(LocalAttachmentStore, { dshHome: path.join(directory, 'dsh-test-home') });
  await ctx.plugin(plugin, { runtimeDirectory: directory });
  const session = Session.create(SessionId('native-smoke')), otherSession = Session.create(SessionId('other-session'));
  session.append('turn/start', { turn: 1 });
  let callNumber = 0;
  const call = (name, args, options = {}) => ctx.tools.execute({ name, callId: `native-${++callNumber}`, arguments: args,
    agent: { session: options.session ?? session }, signal: options.signal ?? AbortSignal.timeout(15000) });
  const value = async (name, args, options) => {
    const result = await call(name, args, options);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
    return result.value;
  };
  const instances = await value('browser_list', {}); assert.equal(instances.length, 1);
  const instance = instances[0];
  const tabs = await value('browser_list', { instanceId: instance.id }); assert.equal(tabs.length, 1);
  const tab = tabs[0]; assert.equal(tab.url, `${origin}/`);
  const denied = await call('browser_claim', { instanceId: instance.id, tab: tab.id });
  assert.equal(denied.isError, true);
  let approvalHandler = async () => 'allowed-once';
  ctx.provide('approval', { request: (...args) => approvalHandler(...args) });
  let lease = await value('browser_claim', { instanceId: instance.id, tab: tab.id });
  let observation = await value('browser_observe', { leaseId: lease.id });
  passed.push('Real DSH registry, approval denial, approved tab claim and AX observation');
  assert.equal((await diagnose(diagnosticOptions)).status, 'ready');
  await value('browser_observe', { leaseId: lease.id });
  passed.push('Doctor connection teardown preserves the active DSH tab lease');
  assert.equal(observation.format, 'full'); assert.equal(typeof observation.cursor, 'string');
  const initial = observation;
  const unchanged = await value('browser_observe', { leaseId: lease.id, cursor: initial.cursor });
  assert.equal(unchanged.format, 'delta'); assert.equal(unchanged.baseCursor, initial.cursor);
  assert.deepEqual(unchanged.nodes, { upsert: [], remove: [] }); assert.equal(unchanged.text, undefined);
  observationMetrics.fullBytes = serializedBytes(initial);
  observationMetrics.unchangedDeltaBytes = serializedBytes(unchanged);
  assert.ok(observationMetrics.unchangedDeltaBytes < observationMetrics.fullBytes * 0.85);
  await page.locator('#result').evaluate(element => { element.textContent = '增量观察：正文已更新'; });
  const changed = await value('browser_observe', { leaseId: lease.id, cursor: unchanged.cursor });
  assert.equal(changed.format, 'delta'); assert.ok(changed.text.insert.includes('增量观察：正文已更新'));
  observation = applyObservationUpdate(applyObservationUpdate(initial, unchanged), changed);
  // An independent consumer can still advance from its own older baseline.
  const olderConsumer = await value('browser_observe', { leaseId: lease.id, cursor: initial.cursor });
  assert.deepEqual(pageContent(applyObservationUpdate(initial, olderConsumer)), pageContent(observation));
  const fresh = await value('browser_observe', { leaseId: lease.id });
  assert.deepEqual(pageContent(observation), pageContent(fresh));
  observationMetrics.textDeltaBytes = serializedBytes(changed);
  observationMetrics.scope = 'UTF-8 JSON response bytes for document-scope views from bounded AX traversal; no token/latency claim';
  passed.push('Real DSH/native observation deltas reconstruct current text and independent consumer cursors');
  const region = fresh.nodes.find(n => n.kind === 'region' && n.name === '搜索表单'); assert.ok(region);
  const local = await value('browser_observe', { leaseId: lease.id, rootRef: region.id, cursor: fresh.cursor });
  assert.equal(local.format, 'full'); assert.equal(local.resyncReason, 'scope-changed');
  assert.deepEqual(local.scope, { kind: 'subtree', rootRef: region.id });
  assert.ok(local.text.includes('增量观察：正文已更新'));
  assert.equal(local.text.includes('仅本机测试，无真实账号或业务数据。'), false);
  assert.equal(local.nodes.some(n => n.name === '页底输入'), false);
  assert.equal(local.nodes.find(n => n.name === '搜索词').id, fresh.nodes.find(n => n.name === '搜索词').id);
  passed.push('Real scoped AX query returns only the selected named region, retaining current control identities');
  const localDelta = await value('browser_observe', { leaseId: lease.id, rootRef: region.id, cursor: local.cursor });
  assert.equal(localDelta.format, 'delta');
  assert.deepEqual(pageContent(applyObservationUpdate(local, localDelta)), pageContent(local));
  const whole = await value('browser_observe', { leaseId: lease.id, cursor: localDelta.cursor });
  assert.equal(whole.format, 'full'); assert.equal(whole.resyncReason, 'scope-changed');
  assert.deepEqual(whole.scope, { kind: 'document' });
  passed.push('Scoped deltas stay in their region; omitting rootRef explicitly resyncs the whole-document view');
  // Replace only the container, moving its original children so their listeners/identity remain intact.
  await page.locator('#search-region').evaluate(element => {
    const replacement = element.cloneNode(false);
    while (element.firstChild) replacement.append(element.firstChild);
    element.replaceWith(replacement);
  });
  assert.equal((await call('browser_observe', { leaseId: lease.id, rootRef: region.id })).isError, true);
  observation = await value('browser_observe', { leaseId: lease.id });
  assert.notEqual(observation.nodes.find(n => n.kind === 'region' && n.name === '搜索表单').id, region.id);
  passed.push('A replaced region cannot silently rebind an old root reference to its lookalike');
  const act = async (requestId, action, options = {}) => {
    const result = await value('browser_act', { requestId, leaseId: lease.id, documentEpoch: observation.documentEpoch,
      action, timeoutMs: options.timeoutMs ?? 4000 }, options);
    if (result.observation) observation = result.observation;
    return result;
  };
  const field = observation.nodes.find(n => n.name === '搜索词'); assert.ok(field);
  assert.equal((await act('native-fill', { kind: 'fill', ref: field.id, text: '原生通信 · DSH' })).outcome, 'succeeded');
  assert.equal(await page.locator('#query').inputValue(), '原生通信 · DSH');
  passed.push(...await verifyKeyboard({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyEditable({ page, observe: options => value('browser_observe', { leaseId: lease.id, ...options }), act }));
  passed.push(...await verifyAppend({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyElementState({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyChecked({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyCheckLabels({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyRadio({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyWheel({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyScroll({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  passed.push(...await verifyActionability({ page, observe: () => value('browser_observe', { leaseId: lease.id }), act }));
  const large = await verifyLargeObservation({ page,
    observe: options => value('browser_observe', { leaseId: lease.id, ...options }), act });
  passed.push(...large.passed); observationMetrics.largePage = large.metrics;
  passed.push(...await verifySemanticQuery({ page,
    observe: options => value('browser_observe', { leaseId: lease.id, ...options }), act }));
  observation = await value('browser_observe', { leaseId: lease.id });
  const delayed = observation.nodes.find(n => n.name === '延迟反馈'); assert.ok(delayed);
  assert.equal((await act('native-click', { kind: 'click', ref: delayed.id, expected: { kind: 'text', text: '延迟保存成功' } })).outcome, 'succeeded');
  passed.push('Verified Chinese input and delayed text through the complete local stack');
  const afterAction = await value('browser_observe', { leaseId: lease.id, cursor: observation.cursor });
  assert.equal(afterAction.format, 'delta'); assert.equal(afterAction.baseCursor, observation.cursor);
  assert.deepEqual(afterAction.nodes, { upsert: [], remove: [] }); assert.equal(afterAction.text, undefined);
  observation = applyObservationUpdate(observation, afterAction);
  passed.push('Action result supplies a valid cursor for the next incremental observation');

  const screenshot = await call('browser_screenshot', { leaseId: lease.id });
  assert.equal(screenshot.isError, false, JSON.stringify(screenshot.content));
  assert.ok(screenshot.content.some(block => block.type === 'image' && block.attachment));
  const image = await ctx.attachments.readImage(screenshot.value.attachment);
  assert.ok(image.data.byteLength > 1000); assert.ok(screenshot.value.attachment.width > 0);
  passed.push('Real browser screenshot admitted to actual DSH image attachment store');
  assert.equal(screenshot.value.screenshot.sha256, createHash('sha256').update(image.data).digest('hex'));
  assert.equal(screenshot.value.screenshot.attachmentId, screenshot.value.attachment.attachmentId);
  assert.equal(screenshot.value.screenshot.leaseId, lease.id);
  assert.deepEqual(screenshot.value.screenshot.imageSize, { width: screenshot.value.attachment.width, height: screenshot.value.attachment.height });
  passed.push('Screenshot reference binds canonical Host pixels, dimensions and owning lease');
  const foreign = await call('browser_observe', { leaseId: lease.id }, { session: otherSession });
  assert.equal(foreign.isError, true);
  passed.push('Different DSH session cannot use another session lease');

  const clickCount = await page.evaluate(() => window.fixtureClicks.delayed);
  const never = { kind: 'click', ref: delayed.id, expected: { kind: 'text', text: 'will never be present' } };
  const timedOut = await act('unknown-no-replay', never, { timeoutMs: 350 });
  assert.equal(timedOut.outcome, 'unknown'); assert.equal(timedOut.code, 'DEADLINE_EXCEEDED');
  assert.deepEqual(await act('unknown-no-replay', never, { timeoutMs: 350 }), timedOut);
  assert.equal(await page.evaluate(() => window.fixtureClicks.delayed), clickCount + 1);
  passed.push('Post-dispatch timeout stays unknown and duplicate request does not click twice');

  await page.evaluate(() => { document.querySelector('#cover').style.display = 'block'; });
  const cancel = new AbortController();
  const cancelling = call('browser_act', { requestId: 'cancel-native', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { kind: 'fill', ref: field.id, text: 'must not type' }, timeoutMs: 3000 }, { signal: cancel.signal });
  const timer = setTimeout(() => cancel.abort(), 120);
  const cancelled = await cancelling; clearTimeout(timer);
  assert.ok(cancelled.isError || cancelled.value?.outcome === 'cancelled');
  // A queued observe only resolves after the cancelled operation is quiescent.
  await value('browser_observe', { leaseId: lease.id });
  assert.equal(await page.locator('#query').inputValue(), '原生通信 · DSH');
  passed.push('DSH cancellation propagates across RPC/native bridge before input');

  const stopping = call('browser_act', { requestId: 'stop-native', leaseId: lease.id, documentEpoch: observation.documentEpoch,
    action: { kind: 'fill', ref: field.id, text: 'must not type either' }, timeoutMs: 3000 });
  await popupCommand('stop');
  const stopped = await stopping;
  assert.ok(stopped.isError || stopped.value?.outcome === 'cancelled' || stopped.value?.outcome === 'failed');
  assert.equal((await call('browser_observe', { leaseId: lease.id })).isError, true);
  assert.equal(await page.locator('#query').inputValue(), '原生通信 · DSH');
  await page.evaluate(() => { document.querySelector('#cover').style.display = 'none'; });
  passed.push('Popup Stop revokes the Broker lease and blocks pending input');

  await popupCommand('allow');
  lease = await value('browser_claim', { instanceId: instance.id, tab: tab.id });
  const afterStop = await value('browser_observe', { leaseId: lease.id, cursor: observation.cursor });
  assert.equal(afterStop.format, 'full'); assert.equal(afterStop.resyncRequired, true);
  assert.equal(afterStop.resyncReason, 'cursor-unavailable');
  assert.notEqual(afterStop.nodes.find(n => n.name === '搜索词').id, field.id);
  passed.push('Stop and reclaim invalidate old cursors and element references across the real native stack');
  const publication=await verifyScreenshotPublication({attachments:ctx.attachments,call,value,popupCommand,eventually,
    lease,instanceId:instance.id,tabId:tab.id});
  lease=publication.lease;passed.push(...publication.passed);
  ctx.emit('session/event', session, { type: 'turn/end' });
  await eventually(async () => (await call('browser_observe', { leaseId: lease.id })).isError, 'turn-end lease release');
  passed.push('Canonical DSH turn/end event releases native tab control');

  let finishApproval, approvalStarted;
  const started = new Promise(resolve => { approvalStarted = resolve; });
  approvalHandler = () => new Promise(resolve => { finishApproval = resolve; approvalStarted(); });
  const lateClaim = call('browser_claim', { instanceId: instance.id, tab: tab.id });
  await started;
  ctx.emit('session/event', session, { type: 'turn/end' });
  finishApproval('allowed-once');
  const late = await lateClaim;
  assert.equal(late.isError, true, 'Approval completed after turn/end must not acquire a lease');
  approvalHandler = async () => 'allowed-once';
  passed.push('Late approval cannot grant browser authority after its DSH turn ended');

  lease = await value('browser_claim', { instanceId: instance.id, tab: tab.id });
  const oldLease = lease;
  const recoveryObservation = await value('browser_observe', { leaseId: lease.id });
  const recoveryButton = recoveryObservation.nodes.find(n => n.name === '提交测试'); assert.ok(recoveryButton);
  const recoveryRequest = { requestId: 'durable-before-restart', leaseId: lease.id, documentEpoch: recoveryObservation.documentEpoch,
    action: { kind: 'click', ref: recoveryButton.id, expected: { kind: 'text', text: '已提交：原生通信 · DSH' } } };
  const beforeRecoveryClick = await page.evaluate(() => window.fixtureClicks.submit);
  assert.equal((await value('browser_act', recoveryRequest)).outcome, 'succeeded');
  assert.equal(await page.evaluate(() => window.fixtureClicks.submit), beforeRecoveryClick + 1);
  const killed = await broker.kill(); broker = undefined;
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal((await lstat(path.join(directory, 'broker.sock'))).isSocket(), true);
  await eventually(async () => (await popupCommand('status')).status === 'Disconnected' ||
    !(await popupCommand('status')).controlled, 'native disconnect closes extension gate');
  broker = await startIsolatedBroker({ directory, allowedOrigins: [origin] });
  assert.equal(broker.recoveredSocket, true);
  passed.push('A replacement CLI Broker safely recovers the stale socket left by SIGKILL');
  await eventually(async () => {
    const result = await call('browser_list', {}); return !result.isError && result.value.length === 0;
  }, 'Broker restart without extension auto-reconnect');
  assert.equal((await call('browser_observe', { leaseId: oldLease.id })).isError, true);
  const recoveredAction = await value('browser_act', recoveryRequest);
  assert.equal(recoveredAction.code, 'RECOVERY_REQUIRED'); assert.equal(recoveredAction.outcome, 'unknown');
  assert.equal(recoveredAction.recovery.priorOutcome, 'succeeded'); assert.equal(recoveredAction.observation, undefined);
  assert.equal(await page.evaluate(() => window.fixtureClicks.submit), beforeRecoveryClick + 1);
  passed.push('Same DSH turn recovers private action metadata after Broker restart without restoring a lease or clicking again');
  await popupCommand('allow');
  const reconnected = await eventually(async () => {
    const result = await call('browser_list', {}); return !result.isError && result.value.length === 1 && result.value[0];
  }, 'explicit reconnect');
  assert.notEqual(reconnected.id, instance.id);
  assert.equal(await page.locator('#query').inputValue(), '原生通信 · DSH');
  passed.push('Broker restart does not restore a lease or replay input; explicit reconnect gets a new instance');

  const reconnectedTabs = await value('browser_list', { instanceId: reconnected.id });
  lease = await value('browser_claim', { instanceId: reconnected.id, tab: reconnectedTabs[0].id });
  assert.equal((await call('browser_act', { ...recoveryRequest, leaseId: lease.id })).isError, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks.submit), beforeRecoveryClick + 1);
  passed.push('Reclaiming a tab cannot reuse the old request ID with a changed lease payload');
  observation = await value('browser_observe', { leaseId: lease.id });
  const beforeNavigation = observation;
  const nextUrl = `${origin}/next-document`;
  const navigation = await act('cursor-document-replacement', { kind: 'navigate', url: nextUrl,
    expected: { kind: 'url', url: nextUrl } });
  assert.equal(navigation.outcome, 'succeeded');
  const afterNavigation = await value('browser_observe', { leaseId: lease.id, cursor: beforeNavigation.cursor });
  assert.equal(afterNavigation.format, 'full'); assert.equal(afterNavigation.resyncRequired, true);
  assert.equal(afterNavigation.resyncReason, 'document-changed');
  assert.notEqual(afterNavigation.documentEpoch, beforeNavigation.documentEpoch);
  assert.deepEqual(pageContent(afterNavigation), pageContent(navigation.observation));
  await value('browser_handoff', { leaseId: lease.id });
  passed.push('Real document navigation returns a full resync instead of a cross-document delta');

  // A control-free native hello probe: Chrome performs fresh host discovery and
  // launches the real stdio bridge. No page reads, lease grant or input is requested.
  const probeNativeRegistration = () => worker.evaluate(({ capabilities, requiredCapabilities }) => new Promise(resolve => {
    const timer=setTimeout(()=>resolve({error:'Native registration probe timed out'}),5000);
    chrome.runtime.sendNativeMessage('com.longmiaoo.dsh_native_browser', {
      type:'request',id:'registration-probe',method:'hello',params:{bootstrap:1,versions:[1],role:'provider',capabilities,requiredCapabilities,
        instance:{id:crypto.randomUUID(),family:'chromium',brand:'chrome',version:'registration-probe',profileLabel:'isolated probe'}},
    }, response=>{clearTimeout(timer); const error=chrome.runtime.lastError?.message; resolve(error?{error}:{response});});
  }), {capabilities:[...providerCapabilities],requiredCapabilities:[...providerRequirements]});
  assert.equal((await probeNativeRegistration()).response?.ok,true);
  const oldManifest=await readFile(installed.manifest);
  const removed=await uninstallHost(installOptions);
  assert.equal(removed.manifestRemoved,true);assert.equal(removed.runningConnectionsStopped,false);
  assert.ok((await readFile(removed.backup)).equals(oldManifest));
  assert.match((await probeNativeRegistration()).error,/Specified native messaging host not found/);
  assert.ok((await value('browser_list',{})).some(i=>i.id===reconnected.id));
  passed.push('Unregistering the isolated host blocks fresh Chrome native messaging, preserves backup and does not claim to stop existing connections');
  await installHost(installOptions);
  assert.equal((await probeNativeRegistration()).response?.ok,true);
  passed.push('Explicit reinstall restores fresh Chrome-started host handshake after unregistration');

  const host = JSON.parse(await readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  const imageExtension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[screenshot.value.attachment.mediaType];
  assert.ok(imageExtension, 'The Host canonical screenshot must have a known image format');
  const toolScreenshotPath = `output/playwright/native-tool-screenshot.${imageExtension}`;
  const report = { checkedAt: new Date().toISOString(), browserVersion: browserContext.browser().version(),
    dshVersion: host.version, passed, observationMetrics,
    toolScreenshot: { path: toolScreenshotPath, sha256: screenshot.value.screenshot.sha256,
      stage: 'Actual DSH tool image after Chinese input and delayed text verification, before Stop/navigation' },
    scope: 'Real MV3/nativeMessaging/Chrome-started Native Host/Unix socket/independent Broker CLI process/DSH ToolRuntime and attachments, including Broker SIGKILL and restart; isolated loopback fixture, no LLM or user signed-in account' };
  await mkdir('output/playwright', { recursive: true });
  await writeFile(toolScreenshotPath, image.data);
  await writeFile('output/playwright/native-smoke.json', JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({ path: 'output/playwright/native-smoke.png' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await ctx?.fiber.dispose();
  await browserContext?.close();
  await broker?.close();
  await new Promise(resolve => server.close(resolve));
  // The only recursive deletion is this process's newly created isolated directory.
  await rm(directory, { recursive: true });
}
