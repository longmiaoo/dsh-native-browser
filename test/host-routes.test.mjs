import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHostRoutes } from '../dist/packages/dsh-adapter/src/host-routes.js';

test('shared routes coexist with API Gateway, validate envelopes and dispose independently', async () => {
  const routes = new Map(), calls = [];
  const dispose = registerHostRoutes({ fetch: { register(route) {
    assert.equal(route.requestBody, 'buffered');
    assert.deepEqual(route.methods, ['POST']);
    routes.set(route.path, route); return () => routes.delete(route.path);
  } }, rpc: { handle() { throw Error('Independent channel must not be mounted'); } } }, async (...args) => {
    calls.push(args); return { ok: true, value: { accepted: true } };
  });
  assert.equal(routes.size, 4);
  const route = routes.get('/api/dsh-native-browser/setup.status');
  const request = (body, contentType = 'application/json') => new Request('http://127.0.0.1' + route.path,
    { method: 'POST', headers: { 'content-type': contentType }, body });
  for (const [body, status] of [['{', 400], ['{}', 400], ['x'.repeat(16385), 413],
    [JSON.stringify({ type: 'client-request', rpcId: '1', method: 'dsh-native-browser/setup.install' }), 400]]) {
    assert.equal((await route.fetch(request(body))).status, status);
  }
  assert.equal((await route.fetch(request('{}', 'text/plain'))).status, 415);
  assert.equal(calls.length, 0);
  const result = await route.fetch(request(JSON.stringify({ type: 'client-request', rpcId: 'test-id',
    method: 'dsh-native-browser/setup.status', payload: {} })));
  assert.deepEqual(await result.json(), { type: 'server-response', rpcId: 'test-id', result: { ok: true, value: { accepted: true } } });
  assert.equal(calls[0][0], 'setup.status');
  dispose(); assert.equal(routes.size, 0); dispose();
});

test('partial route registration is rolled back on conflict', () => {
  let registered = 0, disposed = 0;
  assert.throws(() => registerHostRoutes({ fetch: { register() {
    if (++registered === 3) throw Error('route collision');
    return () => { disposed++; };
  } } }, async () => {}), /route collision/);
  assert.equal(disposed, 2);
});
