import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture() {
  let definition, current = 'chat-a';
  const listListeners = new Set(), eventListeners = new Map(), documentListeners = new Map(), disposers = [], calls = [];
  const window = { __ModuleLoader__: { load(value) { definition = value; } } };
  const document = {
    visibilityState: 'visible',
    addEventListener(name, listener) { documentListeners.set(name, listener); },
    removeEventListener(name, listener) { if (documentListeners.get(name) === listener) documentListeners.delete(name); },
  };
  vm.runInNewContext(source, { window, document, crypto: webcrypto, AbortController, AbortSignal, Date, Promise, Object, Number, Symbol });
  const plugin = definition.factory();
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ current }), subscribe: listener => { listListeners.add(listener); return () => listListeners.delete(listener); } } },
    connection: { rpc: { call: async (channel, endpoint, payload, signal) => { calls.push({ channel, endpoint, payload: structuredClone(payload), signal }); return { ok: true, value: {} }; } } },
    on(name, listener) { eventListeners.set(name, listener); return () => eventListeners.delete(name); },
    effect(callback) { disposers.push(callback()); },
  };
  plugin.apply(ctx);
  return { plugin, calls, document,
    select(value) { current = value; for (const listener of listListeners) listener(); },
    reset() { eventListeners.get('connection/reset')?.(); },
    visible() { documentListeners.get('visibilitychange')?.(); },
    dispose() { for (const dispose of disposers) dispose(); },
  };
}

test('client reports canonical current-session changes over authenticated Connection RPC only', async () => {
  const f = fixture(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].channel, '/dsh-native-browser'); assert.equal(f.calls[0].endpoint, 'foreground');
  assert.equal(f.calls[0].payload.sessionId, 'chat-a');
  assert.match(f.calls[0].payload.clientId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(f.calls[0].payload).sort(), ['clientId', 'issuedAt', 'revision', 'sessionId']);
  f.select('chat-b'); await flush(); assert.equal(f.calls.at(-1).payload.sessionId, 'chat-b');
  const count = f.calls.length; f.select('chat-b'); await flush(); assert.equal(f.calls.length, count);
  assert.equal(f.calls[1].payload.revision, f.calls[0].payload.revision + 1);
});

test('hidden pages cannot steal foreground; visibility and reconnect reassert the latest selection', async () => {
  const f = fixture(); await flush();
  f.document.visibilityState = 'hidden'; f.select('chat-hidden'); await flush(); assert.equal(f.calls.length, 1);
  f.document.visibilityState = 'visible'; f.visible(); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].payload.sessionId, 'chat-hidden');
  f.reset(); await flush(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2].payload.sessionId, 'chat-hidden');
  f.dispose(); assert.equal(f.calls[2].signal.aborted, true);
  f.select('chat-after-dispose'); f.reset(); await flush(); assert.equal(f.calls.length, 3);
});
