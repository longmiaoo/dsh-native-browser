import assert from 'node:assert/strict';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { verifyKeyboard } from './verify-keyboard.mjs';
import { verifyEditable } from './verify-editable.mjs';
import { verifyAppend } from './verify-append.mjs';
import { verifyElementState } from './verify-element-state.mjs';
import { verifyScroll } from './verify-scroll.mjs';
import { verifyActionability } from './verify-actionability.mjs';
import { readAXTree } from '../dist/packages/provider-chromium/src/ax-reader.js';
import { findAXNodes } from '../dist/packages/provider-chromium/src/ax-query.js';
import { verifyLargeObservation } from './verify-large-observation.mjs';
import { verifySemanticQuery } from './verify-semantic-query.mjs';
import { verifyChecked } from './verify-checked.mjs';
import { verifyCheckLabels } from './verify-check-labels.mjs';
import { verifyWheel } from './verify-wheel.mjs';
import { verifyRadio } from './verify-radio.mjs';

/** Run against our local fixture only. This checks live CDP semantics, NOT chrome.debugger/native setup. */
export async function verifyLiveProvider(page) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  const session = await page.context().newCDPSession(page);
  const instance = { id: 'live-test', family: 'chromium', brand: 'chrome', version: 'live', profileLabel: 'isolated fixture', capabilities: { ax: true, screenshot: true } };
  let token, activeLease;
  const listeners = new Set();
  for (const event of ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.lifecycleEvent', 'DOM.documentUpdated', 'Accessibility.nodesUpdated', 'Accessibility.loadComplete']) {
    session.on(event, () => { if (activeLease) for (const listener of listeners) listener('page.changed', { tab: activeLease.tab, leaseId: activeLease.id }); });
  }
  const inputCommands = [];
  const axReads = [];
  const projectedReads = [];
  const send = async (method, params) => {
    const result = await session.send(method, params);
    if (method.startsWith('Accessibility.')) axReads.push({ method, bytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  };
  const provider = new ChromiumProvider(instance, { onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async call(method, params, signal) {
    if (method === 'tabs.list') return [{ id: 'fixture-tab', instanceId: instance.id, url: page.url(), title: await page.title() }];
    if (method === 'lease.grant') { activeLease = params.lease; token = params.lease.token; await session.send('Page.enable'); await session.send('Page.setLifecycleEventsEnabled', { enabled: true }); await session.send('Accessibility.enable'); await session.send('DOM.enable'); return {}; }
    if (method === 'lease.revoke') { if (token === params.lease.token) { token = undefined; activeLease = undefined; } return {}; }
    assert.equal(params.lease.token, token);
    if (method === 'ax.find') return findAXNodes(params.request, send, signal);
    if (method === 'ax.read') {
      const result = await readAXTree(params.request, send, signal);
      projectedReads.push(Buffer.byteLength(JSON.stringify(result)));
      return result;
    }
    if (params.method.startsWith('Input.')) inputCommands.push(params.method);
    return send(params.method, params.params);
  } });
  const runtime = new BrowserRuntime(async r => new URL(r.tab.url).hostname === '127.0.0.1');
  runtime.register(provider);
  const signal = AbortSignal.timeout(30000);
  try {
    const lease = await runtime.claim('live-fixture', instance.id, 'fixture-tab', signal);
    // Measurement-only baseline, never used to implement observation or supply refs.
    const baselineBytes = Buffer.byteLength(JSON.stringify(await session.send('Accessibility.getFullAXTree')));
    const o = await runtime.observe('live-fixture', lease.id, signal);
    const root = o.nodes.find(n => n.kind === 'region' && n.name === '搜索表单'); assert.ok(root);
    const readStart = axReads.length;
    const local = await runtime.observe('live-fixture', lease.id, signal, { rootRef: root.id });
    assert.deepEqual(local.scope, { kind: 'subtree', rootRef: root.id });
    assert.ok(local.text.includes('尚未提交')); assert.equal(local.nodes.some(n => n.name === '页底输入'), false);
    assert.equal(local.text.includes('仅本机测试，无真实账号或业务数据。'), false);
    const scopedReads = axReads.slice(readStart);
    assert.equal(scopedReads.some(r => ['Accessibility.getFullAXTree', 'Accessibility.queryAXTree', 'Accessibility.getRootAXNode'].includes(r.method)), false);
    assert.equal(scopedReads[0].method, 'Accessibility.getPartialAXTree');
    assert.equal(scopedReads.at(-1).method, 'Accessibility.getPartialAXTree');
    const axMetrics = { fullTreeResponseBytes: baselineBytes,
      documentProjectedBytes: projectedReads[0], subtreeProjectedBytes: projectedReads[1],
      subtreeReadCalls: scopedReads.length,
      subtreeWithIdentityChecksBytes: scopedReads.reduce((sum, r) => sum + r.bytes, 0),
      scope: 'Full-tree measurement-only baseline, actual scoped CDP response bytes and projected bridge payloads; no latency/CPU claim' };
    assert.ok(axMetrics.subtreeProjectedBytes < axMetrics.documentProjectedBytes);
    const field = o.nodes.find(n => n.role === 'textbox' && n.name === '搜索词');
    assert.ok(field, 'Chinese AX textbox discovered');
    const fill = await runtime.act('live-fixture', { requestId: 'fill-live', leaseId: lease.id, documentEpoch: o.documentEpoch,
      action: { kind: 'fill', ref: field.id, text: '中文输入 · DSH' } }, signal);
    assert.equal(fill.outcome, 'succeeded');
    assert.equal(await page.locator('#query').inputValue(), '中文输入 · DSH');
    const button = fill.observation.nodes.find(n => n.role === 'button' && n.name === '提交测试');
    assert.ok(button);
    const click = await runtime.act('live-fixture', { requestId: 'click-live', leaseId: lease.id, documentEpoch: o.documentEpoch,
      action: { kind: 'click', ref: button.id, expected: { kind: 'url', url: `${new URL(page.url()).origin}/#submitted` } } }, signal);
    assert.equal(click.outcome, 'succeeded');
    assert.equal(await page.locator('#result').textContent(), '已提交：中文输入 · DSH');
    assert.equal(await page.evaluate(() => window.fixtureClicks.submit), 1);
    assert.ok(click.observation.text.includes('已提交：中文输入 · DSH'));

    const run = (id, observation, action, options = {}) => runtime.act('live-fixture', {
      requestId: id, leaseId: lease.id, documentEpoch: observation.documentEpoch, action, timeoutMs: options.timeoutMs ?? 4000,
    }, options.signal ?? signal);
    const large = await verifyLargeObservation({ page,
      observe: options => runtime.observe('live-fixture', lease.id, signal, options),
      act: (id, action) => run(id, o, action) });
    const queryChecks = await verifySemanticQuery({ page,
      observe: options => runtime.observe('live-fixture', lease.id, signal, options),
      act: (id, action) => run(id, o, action) });
    const empty = await run('empty-fill', click.observation, { kind: 'fill', ref: field.id, text: '' });
    assert.equal(empty.outcome, 'succeeded'); assert.equal(await page.locator('#query').inputValue(), '');

    // Test setup affects only our loopback fixture, not a real website.
    await page.evaluate(() => { document.querySelector('#cover').style.display = 'block'; setTimeout(() => { document.querySelector('#cover').style.display = 'none'; }, 200); });
    const uncovered = await run('covered-fill', empty.observation, { kind: 'fill', ref: field.id, text: '遮罩消失后输入' });
    assert.equal(uncovered.outcome, 'succeeded');

    const delayedButton = uncovered.observation.nodes.find(n => n.role === 'button' && n.name === '延迟反馈');
    const delayed = await run('delayed-feedback', uncovered.observation, { kind: 'click', ref: delayedButton.id, expected: { kind: 'text', text: '延迟保存成功' } });
    assert.equal(delayed.outcome, 'succeeded');
    assert.equal(await page.evaluate(() => window.fixtureClicks.delayed), 1);
    const keyboardChecks = await verifyKeyboard({ page,
      observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action) => run(id, delayed.observation, action) });
    const editableChecks = await verifyEditable({ page, observe: options => runtime.observe('live-fixture', lease.id, signal, options),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const appendChecks = await verifyAppend({ page, observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const stateChecks = await verifyElementState({ page, observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const checkedChecks = await verifyChecked({ page, observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const labelChecks = await verifyCheckLabels({ page, observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const radioChecks = await verifyRadio({ page, observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const wheelChecks = await verifyWheel({ page, observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });
    const scrollChecks = await verifyScroll({ page,
      observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action) => run(id, delayed.observation, action) });
    const hitChecks = await verifyActionability({ page,
      observe: () => runtime.observe('live-fixture', lease.id, signal),
      act: (id, action, options) => run(id, delayed.observation, action, options) });

    await page.evaluate(() => { document.querySelector('#cover').style.display = 'block'; });
    const controller = new AbortController();
    const beforeCancel = inputCommands.length;
    const cancelling = run('cancel-covered', delayed.observation, { kind: 'click', ref: delayedButton.id }, { signal: controller.signal });
    const cancelTimer = setTimeout(() => controller.abort(), 100);
    const cancelled = await cancelling; clearTimeout(cancelTimer);
    assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.dispatch, 'notDispatched');
    assert.equal(inputCommands.length, beforeCancel);
    await page.evaluate(() => { document.querySelector('#cover').style.display = 'none'; });

    const bottom = delayed.observation.nodes.find(n => n.role === 'textbox' && n.name === '页底输入');
    assert.ok(bottom, 'AX discovers offscreen target');
    const scrolled = await run('offscreen-fill', delayed.observation, { kind: 'fill', ref: bottom.id, text: '自动滚动' });
    assert.equal(scrolled.outcome, 'succeeded'); assert.equal(await page.locator('#offscreen').inputValue(), '自动滚动');
    assert.ok(await page.evaluate(() => scrollY > 0));

    const denied = await run('deny-navigation', scrolled.observation, { kind: 'navigate', url: 'https://example.test/' });
    assert.equal(denied.outcome, 'failed'); assert.equal(denied.code, 'POLICY_DENIED'); assert.equal(denied.dispatch, 'notDispatched');
    const url = `${new URL(page.url()).origin}/next`;
    const navigated = await run('navigate-live', scrolled.observation, { kind: 'navigate', url });
    assert.equal(navigated.outcome, 'succeeded'); assert.equal(page.url(), url);
    assert.notEqual(navigated.observation.documentEpoch, o.documentEpoch);
    const stale = await run('old-page-ref', o, { kind: 'fill', ref: field.id, text: 'must not type' });
    assert.equal(stale.outcome, 'failed'); assert.equal(stale.code, 'STALE_TARGET'); assert.equal(await page.locator('#query').inputValue(), '');
    const image = await runtime.capture('live-fixture', lease.id, signal);
    assert.equal(Buffer.from(image.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    await runtime.release('live-fixture', lease.id);
    assert.equal(token, undefined);
    assert.equal(listeners.size, 0);
    return { passed: ['Chinese AX discovery', 'Scoped AX source query, boundaries and measured response bytes', 'Input.insertText', 'Verified fill', 'Verified click', 'Visible reading text',
      'Empty fill with Backspace', 'Temporary overlay wait', 'Delayed text postcondition without click replay',
      'Cancel covered target before input', 'Offscreen target auto-scroll', 'Cross-origin navigation denied',
      'Same-origin document navigation', 'Old-document reference rejected', 'JPEG viewport capture', 'Lease release', ...keyboardChecks, ...editableChecks, ...appendChecks, ...stateChecks, ...checkedChecks, ...labelChecks, ...radioChecks, ...wheelChecks, ...scrollChecks, ...hitChecks, ...large.passed, ...queryChecks],
      observationNodes: o.nodes.length, axMetrics, largePage: large.metrics, screenshotBytes: Buffer.from(image.data, 'base64').length, viewport: image.viewport };
  } finally { await runtime.dispose(); await session.detach(); }
}
