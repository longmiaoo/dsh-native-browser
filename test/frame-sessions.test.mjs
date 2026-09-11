import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameSessions, frameSessionLimits } from '../dist/packages/provider-chromium/src/frame-sessions.js';
const signal = () => new AbortController().signal;
const tree = (id, parentId, children = []) => ({ frame: { id, ...(parentId ? { parentId } : {}), loaderId: 'loader-' + id,
  url: 'https://example.test/private?secret=never-return', securityOrigin: 'https://example.test', name: 'private-frame-name' }, childFrames: children });
function fixture() {
  const trees = new Map([['', tree('a', undefined, [tree('same', 'a'), tree('b', 'a')])],
    ['b-session', tree('b', 'a', [tree('c', 'b')])], ['c-session', tree('c', 'b')]]);
  const calls = []; let fatal = 0, override;
  const graph = new FrameSessions(async (session, method, params, signal) => {
    calls.push({ session, method, params });
    const result = await override?.(session, method, params, signal);
    return result ?? (method === 'Page.getFrameTree' ? { frameTree: trees.get(session) } : {});
  }, () => fatal++);
  const attach = (parent, id) => graph.event(parent, 'Target.attachedToTarget', { sessionId: id, targetInfo: { type: 'iframe', targetId: 'not-a-frame-id' } });
  const context = (session, frame, id = 1, uniqueId = 'unique-' + frame) => graph.event(session, 'Runtime.executionContextCreated',
    { context: { id, uniqueId, auxData: { isDefault: true, frameId: frame }, name: 'secret-context', origin: 'secret' } });
  return { graph, trees, calls, attach, context, get fatal() { return fatal; }, set override(value) { override = value; } };
}
test('recursive flat sessions distinguish same-process contexts without guessing targetId or exposing content', async () => {
  const f = fixture();
  f.override = (session, method) => { if (method === 'Runtime.enable' && session === 'c-session') f.context(session, 'c');
    if (method === 'Target.setAutoAttach') {
    if (session === '') f.attach('', 'b-session');
    if (session === 'b-session') f.attach(session, 'c-session');
  } };
  await f.graph.start(signal());
  f.context('', 'a'); f.context('', 'same', 2); f.context('b-session', 'b'); f.context('c-session', 'c');
  const result = await f.graph.snapshot(signal());
  assert.equal(result.truncated, false); assert.equal(result.frames.length, 4);
  assert.deepEqual(result.frames.map(f => [f.frameId, f.parentId, f.sessionId]),
    [['a', undefined, ''], ['same', 'a', ''], ['b', 'a', 'b-session'], ['c', 'b', 'c-session']]);
  assert.deepEqual(f.calls.filter(c => c.method === 'Target.setAutoAttach').map(c => c.session), ['', 'b-session', 'c-session']);
  for (const call of f.calls.filter(c => c.method === 'Target.setAutoAttach')) {
    assert.equal(call.params.flatten, true); assert.equal(call.params.waitForDebuggerOnStart, false);
    assert.deepEqual(call.params.filter, [{ type: 'iframe', exclude: false }, { exclude: true }]);
  }
  assert.doesNotMatch(JSON.stringify(result), /private|secret|targetId|url|name/);
  assert.ok(f.calls.every(c => ['Runtime.enable', 'Page.enable', 'Target.setAutoAttach', 'Page.getFrameTree'].includes(c.method)));
  f.graph.dispose();
});
test('detach removes descendants; late parent events cannot recreate an orphan', async () => {
  const f = fixture(); f.attach('', 'b-session'); f.attach('b-session', 'c-session');
  await f.graph.snapshot(signal());
  f.graph.event('', 'Target.detachedFromTarget', { sessionId: 'c-session' }); assert.equal(f.graph.sessionCount, 3);
  f.graph.event('', 'Target.detachedFromTarget', { sessionId: 'b-session' });
  f.attach('b-session', 'orphan'); assert.equal(f.graph.sessionCount, 1);
  assert.ok((await f.graph.snapshot(signal())).frames.every(frame => frame.sessionId === undefined));
  f.graph.dispose();
});
test('failed parent initialization removes already-attached descendants', async () => {
  const f = fixture(); f.override = (session, method) => {
    if (session === 'b-session' && method === 'Target.setAutoAttach') { f.attach(session, 'c-session'); throw Error('failed setup'); }
  };
  f.attach('', 'b-session'); const result = await f.graph.snapshot(signal());
  assert.equal(f.graph.sessionCount, 1); assert.equal(result.truncated, true); f.graph.dispose();
});
test('late unique-context destruction cannot erase a numeric-ID successor; isolated worlds are ignored', async () => {
  const f = fixture(); f.context('', 'a', 1, 'old'); f.context('', 'a', 1, 'new');
  f.graph.event('', 'Runtime.executionContextDestroyed', { executionContextId: 1, executionContextUniqueId: 'old' });
  f.graph.event('', 'Runtime.executionContextCreated', { context: { id: 33, auxData: { isDefault: false, frameId: 'same' } } });
  let result = await f.graph.snapshot(signal()); assert.equal(result.frames[0].context.uniqueId, 'new'); assert.equal(result.frames[1].context, undefined);
  f.graph.event('', 'Runtime.executionContextsCleared', {}); result = await f.graph.snapshot(signal());
  assert.ok(result.frames.every(frame => frame.context === undefined)); f.graph.dispose();
});
test('topology changes mid-read, loader disagreement and malformed trees fail closed', async () => {
  for (const mode of ['change', 'loader', 'cycle', 'parent']) {
    const f = fixture();
    if (mode === 'change') f.override = (_session, method) => { if (method === 'Page.getFrameTree') f.graph.event('', 'Page.frameNavigated', {}); };
    if (mode === 'loader') { f.attach('', 'b-session'); f.trees.get('b-session').frame.loaderId = 'different'; }
    if (mode === 'cycle') f.trees.get('').childFrames.push(tree('a', 'a'));
    if (mode === 'parent') f.trees.get('').childFrames[0].frame.parentId = 'other';
    await assert.rejects(f.graph.snapshot(signal()), { code: 'STALE_TARGET' }); f.graph.dispose();
  }
});
test('opaque security origin does not inherit an HTTP URL or parent authority; oversized graphs truncate', async () => {
  const f = fixture(); f.trees.get('').childFrames[0].frame.securityOrigin = '://';
  assert.equal((await f.graph.snapshot(signal())).frames[1].origin, undefined);
  f.trees.set('', tree('a', undefined, Array.from({ length: 400 }, (_, i) => tree('f' + i, 'a'))));
  const result = await f.graph.snapshot(signal()); assert.equal(result.truncated, true); assert.equal(result.frames.length, frameSessionLimits.frames);
  f.graph.dispose();
});
test('unknown and non-iframe attachment events are ignored; session/context budgets trigger fatal closure', async () => {
  for (const mode of ['session', 'context']) {
    const f = fixture(); f.attach('missing', 'orphan'); f.graph.event('', 'Target.attachedToTarget', { sessionId: 'worker', targetInfo: { type: 'worker' } });
    assert.equal(f.graph.sessionCount, 1);
    if (mode === 'session') for (let i = 0; i < frameSessionLimits.sessions; i++) f.attach('', 's' + i);
    else for (let i = 0; i <= frameSessionLimits.contexts; i++) f.context('', 'f' + i, i + 1);
    assert.equal(f.fatal, 1); await assert.rejects(f.graph.snapshot(signal()), { code: 'STALE_TARGET' }); f.graph.dispose();
  }
});
test('caller cancellation and Stop release a snapshot waiting on child initialization', async () => {
  for (const mode of ['caller', 'stop']) {
    const f = fixture(); let finish;
    f.override = (session, method) => session === 'b-session' && method === 'Page.enable' ? new Promise(resolve => { finish = resolve; }) : undefined;
    f.attach('', 'b-session'); const controller = new AbortController(), pending = f.graph.snapshot(controller.signal);
    if (mode === 'caller') controller.abort(); else f.graph.dispose();
    await assert.rejects(pending); finish({}); f.graph.dispose();
  }
});
