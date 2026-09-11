import assert from 'node:assert/strict';
import { once } from 'node:events';
import { endianness } from 'node:os';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { encodeFrame, FrameDecoder } from '../dist/packages/transport-native/src/framing.js';
import { RpcPeer } from '../dist/packages/transport-native/src/rpc.js';
import { BrowserError } from '../dist/packages/contracts/src/index.js';

test('native framing handles Chinese UTF-8, fragmented headers and coalesced frames', () => {
  const results = [];
  const decoder = new FrameDecoder(x => results.push(x));
  const bytes = Buffer.concat([encodeFrame({ text: '搜索框' }), encodeFrame({ next: true })]);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.finish();
  assert.deepEqual(results, [{ text: '搜索框' }, { next: true }]);
});

test('frame decoder rejects oversized allocation, zero length, malformed UTF-8 and partial EOF', () => {
  const oversized = Buffer.alloc(4);
  if (endianness() === 'LE') oversized.writeUInt32LE(0xffffffff); else oversized.writeUInt32BE(0xffffffff);
  assert.throws(() => new FrameDecoder(() => {}).push(oversized));
  assert.throws(() => new FrameDecoder(() => {}).push(Buffer.alloc(4)));
  const bytes = encodeFrame('x'); bytes[5] = 0xff;
  assert.throws(() => new FrameDecoder(() => {}).push(bytes));
  const partial = new FrameDecoder(() => {}); partial.push(Buffer.from([3]));
  assert.throws(() => partial.finish());
  assert.throws(() => encodeFrame('long', 2));
});

function pair(t) {
  const a = new PassThrough(), b = new PassThrough();
  const client = new RpcPeer(a, b), server = new RpcPeer(b, a);
  t.after(() => { client.close(); server.close(); });
  return { client, server };
}

test('malformed envelopes close RPC, reject pending calls and never reach the handler', async () => {
  for (const message of [{ type: 'request', id: 'r', method: 'work', params: [], secret: 'private' },
    { type: 'response', id: 'late', ok: false, code: 'FAKE' }, { type: 'event', event: 'page.changed' }]) {
    const input = new PassThrough(), output = new PassThrough(), peer = new RpcPeer(input, output);
    let dispatched = 0; peer.handle(async () => { dispatched++; });
    const pending = peer.call('wait', {});
    input.write(encodeFrame(message));
    await assert.rejects(pending, e => e.code === 'CONNECTION_LOST' && !e.message.includes('private'));
    assert.equal(dispatched, 0); assert.equal(input.destroyed, true);
  }
});

test('RPC void replies use explicit null and completed transport IDs cannot execute twice', async t => {
  const { client, server } = pair(t); server.handle(async () => undefined);
  assert.equal(await client.call('void', {}), null);
  const input = new PassThrough(), output = new PassThrough(), peer = new RpcPeer(input, output);
  t.after(() => peer.close()); let dispatched = 0;
  peer.handle(async () => { dispatched++; });
  const request = encodeFrame({ type: 'request', id: 'same', method: 'work', params: {} });
  input.write(request); await new Promise(resolve => setImmediate(resolve)); input.write(request);
  assert.equal(dispatched, 1); assert.equal(input.destroyed, true);
});

test('RPC correlates concurrent replies returned out of order', async t => {
  const { client, server } = pair(t);
  server.handle(async (method, params) => {
    await new Promise(resolve => setTimeout(resolve, params.delay));
    return { method, n: params.n };
  });
  const [a, b] = await Promise.all([client.call('work', { n: 1, delay: 10 }), client.call('work', { n: 2, delay: 1 })]);
  assert.deepEqual(a, { method: 'work', n: 1 }); assert.equal(b.n, 2);
});

test('RPC propagates cancellation to owned server work', async t => {
  const { client, server } = pair(t);
  let signal;
  server.handle(async (_method, _params, s) => { signal = s; await once(s, 'abort'); throw s.reason; });
  const controller = new AbortController();
  const pending = client.call('wait', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, e => e.code === 'CANCELLED');
  assert.equal(signal.aborted, true);
});

test('RPC preserves the local typed deadline/lease/Stop cause instead of misreporting user cancellation', async t => {
  for (const code of ['DEADLINE_EXCEEDED', 'LEASE_REVOKED', 'USER_STOPPED']) {
    const { client, server } = pair(t); let remote;
    server.handle(async (_method, _params, signal) => { remote = signal; await once(signal, 'abort'); throw signal.reason; });
    const controller = new AbortController(), pending = client.call('wait', {}, controller.signal);
    controller.abort(new BrowserError(code, 'typed cause'));
    await assert.rejects(pending, e => e.code === code);
    assert.equal(remote.aborted, true);
  }
});

test('disconnect settles pending calls as unknown transport failure without replay', async t => {
  const { client, server } = pair(t);
  server.handle(async (_method, _params, signal) => { await once(signal, 'abort'); throw signal.reason; });
  const pending = client.call('side-effect', {});
  server.close();
  await assert.rejects(pending, e => e.code === 'CONNECTION_LOST');
});

test('RPC malformed partial EOF closes cleanly without uncaught exceptions', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const peer = new RpcPeer(input, output);
  const pending = peer.call('wait', {});
  input.end(Buffer.from([1, 2]));
  await assert.rejects(pending, e => e.code === 'CONNECTION_LOST');
});
