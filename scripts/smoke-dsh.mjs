import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as plugin from '../index.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { FakeProvider } from '../test/helpers/fake-provider.mjs';

const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/smoke-dsh.mjs /absolute/path/to/installed/@deepseek-ai/dsh');
const hostRequire = createRequire(path.join(path.resolve(root), 'package.json'));
const load = name => import(hostRequire.resolve(name));
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
const { Session, SessionId } = await load('@deepseek-ai/dsh-session');
const { LocalAttachmentStore } = await load('@deepseek-ai/dsh-attachment-local');
const attachmentRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-attachment-local'));
const { default: sharp } = await import(attachmentRequire.resolve('sharp'));
const directory = await mkdtemp(path.join(tmpdir(), 'dsh-host-smoke-'));
const broker = await startBroker({ directory, allowedOrigins: ['https://example.test'] });
const provider = new FakeProvider(); broker.runtime.register(provider);
const ctx = new Context();
try {
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LocalAttachmentStore, { dshHome: path.join(directory, 'fixture-host') });
  await ctx.plugin(plugin, { runtimeDirectory: directory });
  const session = Session.create(SessionId('browser-smoke'));
  session.append('turn/start', { turn: 1 });
  let number = 0;
  const call = (name, args) => ctx.tools.execute({ name, callId: `smoke-${++number}`, arguments: args,
    agent: { session }, signal: AbortSignal.timeout(3000) });
  const names = ctx.tools.schemas().map(tool => tool.name);
  assert.equal(names.length, 6);
  const list = await call('browser_list', {});
  assert.equal(list.isError, false);
  const denied = await call('browser_claim', { instanceId: 'fake-1', tab: 'tab-1' });
  assert.equal(denied.isError, true, 'missing approval channel must deny');
  assert.equal(provider.grants.size, 0);
  ctx.provide('approval', { request: async () => 'allowed-once' });
  const granted = await call('browser_claim', { instanceId: 'fake-1', tab: 'tab-1' });
  assert.equal(granted.isError, false, JSON.stringify(granted.content));
  const lease = granted.value;
  const observed = await call('browser_observe', { leaseId: lease.id });
  assert.equal(observed.isError, false);
  const acted = await call('browser_act', { requestId: 'dsh-action', leaseId: lease.id, documentEpoch: 'doc-1',
    action: { kind: 'fill', ref: 'node-1', text: 'DSH integration' } });
  assert.equal(acted.isError, false); assert.equal(acted.value.outcome, 'succeeded');
  // A deterministic 1x1 PNG exercises the actual Host admission/storage/render path.
  const pixels = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#126c55' } }).png().toBuffer();
  provider.capture = async () => ({ tab: lease.tab, documentEpoch: 'doc-1', capturedAt: Date.now(), mimeType: 'image/png',
    data: pixels.toString('base64'),
    viewport: { width: 1, height: 1, pageX: 0, pageY: 0 } });
  const screenshot = await call('browser_screenshot', { leaseId: lease.id });
  assert.equal(screenshot.isError, false, JSON.stringify(screenshot.content));
  assert.ok(screenshot.content.some(block => block.type === 'image' && block.attachment));
  const stored = await ctx.attachments.readImage(screenshot.value.attachment);
  assert.ok(stored.data.byteLength > 0);
  assert.equal(screenshot.value.screenshot.sha256, createHash('sha256').update(stored.data).digest('hex'));
  assert.equal(screenshot.value.screenshot.attachmentId, screenshot.value.attachment.attachmentId);
  assert.equal(screenshot.value.screenshot.leaseId, lease.id);
  assert.deepEqual(screenshot.value.screenshot.imageSize, { width: screenshot.value.attachment.width, height: screenshot.value.attachment.height });
  const handedOff = await call('browser_handoff', { leaseId: lease.id });
  assert.equal(handedOff.isError, false); assert.equal(provider.grants.size, 0);
  const host = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  console.log(JSON.stringify({ hostVersion: host.version, tools: names,
    passed: ['real ToolRuntime schema registration', 'missing approval denies', 'approved claim', 'observe', 'act', 'Host image admission and result image block', 'Canonical image hash, size and lease-bound screenshot reference', 'handoff'],
    scope: 'Actual installed DSH ToolRuntime with fake browser; no user profile or model call' }, null, 2));
} finally { await ctx.fiber.dispose(); await broker.close(); await rm(directory, { recursive: true }); }
