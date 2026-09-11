import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as plugin from '../../index.js';
import { startIsolatedBroker } from '../isolated-broker.mjs';
import { installHost } from '../../dist/packages/installer/src/install.js';
import { errorCodes } from '../../dist/packages/contracts/src/index.js';

export async function nativeAdapter({ hostRoot, executablePath, html, signal, configureApproval, brand = 'chrome' }) {
  if (!['chrome', 'edge'].includes(brand)) throw new Error('Unsupported isolated browser brand');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-native-benchmark-'));
  let ctx, browser, broker, server, lease, calls, callId = 0, actionId = 0;
  const close = async () => {
    const failed = [];
    for (const [name, work] of [['dsh', () => ctx?.fiber.dispose()], ['browser', () => browser?.close()],
      ['broker', () => broker?.close()], ['fixture-server', () => server && new Promise(resolve => server.close(resolve))]]) {
      try { await work(); } catch { failed.push(name); }
    }
    // Never remove a running isolated profile if its close operation failed.
    if (!failed.includes('browser')) await rm(directory, { recursive: true, force: true }).catch(() => failed.push('temporary-files'));
    return { complete: failed.length === 0, failed };
  };
  try {
    const hostRequire = createRequire(path.join(path.resolve(hostRoot), 'package.json'));
    const load = name => import(hostRequire.resolve(name));
    const { Context } = await load('@deepseek-ai/cordis');
    const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
    const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
    const { Session, SessionId } = await load('@deepseek-ai/dsh-session');
    const { LocalAttachmentStore } = await load('@deepseek-ai/dsh-attachment-local');
    server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    broker = await startIsolatedBroker({ directory, allowedOrigins: [origin] });
    const extensionPath = path.resolve(import.meta.dirname, '../../dist/extension', brand), profile = path.join(directory, 'profile');
    browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
      viewport: { width: 1280, height: 900 }, args: ['--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    browser.setDefaultTimeout(6000); browser.setDefaultNavigationTimeout(6000);
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    await installHost({ directory, extensionId, brand, cliPath: path.resolve(import.meta.dirname, '../../bin/dsh-native-browser.mjs'),
      manifestDir: path.join(profile, 'NativeMessagingHosts') });
    const page = browser.pages()[0]; await page.goto(origin);
    const cdp = await browser.browser().newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const target = targetInfos.find(t => t.url === page.url()); assert.ok(target);
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId }); await cdp.detach();
    const popup = await browser.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`); await page.bringToFront();
    const popupCommand = command => popup.evaluate(command => chrome.runtime.sendMessage({ command }), command);
    await popupCommand('allow');
    const deadline = performance.now() + 6000;
    while ((await popupCommand('status')).status !== 'Connected') {
      signal?.throwIfAborted(); if (performance.now() > deadline) throw new Error('Native handshake deadline');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
    await ctx.plugin(LocalAttachmentStore, { dshHome: path.join(directory, 'attachments') });
    await ctx.plugin(plugin, { runtimeDirectory: directory });
    const session = Session.create(SessionId('executor-benchmark')); session.append('turn/start', { turn: 1 });
    // Benchmarks default to deterministic approval. Integration tests may mount
    // the real public ApprovalService with controlled answerers instead.
    if (configureApproval) await configureApproval({ ctx, session, load });
    else ctx.provide('approval', { request: async () => 'allowed-once' });
    const call = async (name, args) => {
      const started = performance.now(); let result;
      try {
        result = await ctx.tools.execute({ name, callId: `benchmark-${++callId}`, arguments: args, agent: { session },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) });
        if (result.isError) {
          // Do not copy Host error messages or page content into the report.
          throw Object.assign(new Error('Host tool failed'), { code: 'HOST_TOOL_ERROR' });
        }
        return result.value;
      } finally {
        if (calls) {
          const value = result?.value;
          calls.push({ tool: name, durationMs: performance.now() - started,
            responseBytes: result ? Buffer.byteLength(JSON.stringify(result)) : 0,
            outcome: ['succeeded', 'failed', 'cancelled', 'unknown'].includes(value?.outcome) ? value.outcome : result?.isError ? 'tool-error' : result ? 'returned' : 'threw',
            code: errorCodes.includes(value?.code) ? value.code : null,
            dispatch: ['notDispatched', 'dispatched', 'observed'].includes(value?.dispatch) ? value.dispatch : null });
        }
      }
    };
    const instances = await call('browser_list', {}); assert.equal(instances.length, 1);
    const instance = instances[0], tabs = await call('browser_list', { instanceId: instance.id }); assert.equal(tabs.length, 1);
    const tab = tabs[0]; assert.equal(new URL(tab.url).origin, origin);
    return { close, page, worker, instance, tool: call, recordInto: value => { calls = value; },
      stop: () => popupCommand('stop'),
      allow: async () => { await page.bringToFront(); return popupCommand('allow'); },
      crashAndRestartBroker: async () => {
        const killed = await broker.kill();
        assert.equal(killed.signal, 'SIGKILL');
        broker = await startIsolatedBroker({ directory, allowedOrigins: [origin] });
        return { signal: killed.signal, recoveredSocket: broker.recoveredSocket };
      },
      browserVersion: browser.browser().version(), dshVersion: JSON.parse(await readFile(path.join(hostRoot, 'package.json'), 'utf8')).version,
      async prepare(task, trialId) {
        if (lease) { await call('browser_handoff', { leaseId: lease.id }); lease = undefined; }
        await page.goto(origin); await page.bringToFront();
        lease = await call('browser_claim', { instanceId: instance.id, tab: tab.id });
        const snapshot = await call('browser_observe', { leaseId: lease.id });
        const context = { page, lease, snapshot,
          ref(name) { const found = snapshot.nodes.filter(n => n.name === name); assert.equal(found.length, 1, 'Expected one known fixture target'); return found[0].id; },
          observe: options => call('browser_observe', { leaseId: lease.id, ...options }),
          act: action => call('browser_act', { requestId: `${trialId}-${++actionId}`, leaseId: lease.id,
            documentEpoch: snapshot.documentEpoch, action, timeoutMs: 3000 }),
          capture: () => call('browser_screenshot', { leaseId: lease.id }),
          readImage: attachment => ctx.attachments.readImage(attachment, signal),
        };
        await task.prepare?.(context); return context;
      },
    };
  } catch (error) { await close(); throw error; }
}
