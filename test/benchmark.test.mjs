import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, summarize, seededOrder, failureCode, runCases } from '../scripts/benchmark/stats.mjs';
import { benchmarkCases } from '../scripts/benchmark/cases.mjs';

test('benchmark quantiles are defined, immutable and never zero-fill missing samples', () => {
  const values = [5, 1, 4, 2, 3];
  assert.deepEqual(distribution(values), { count: 5, min: 1, p50: 3, p95: 5, max: 5 });
  assert.deepEqual(values, [5, 1, 4, 2, 3]);
  assert.equal(distribution([4, 1, 3, 2]).p50, 2.5);
  assert.deepEqual(distribution([]), { count: 0, min: null, p50: null, p95: null, max: null });
  for (const value of [-1, NaN, Infinity]) assert.throws(() => distribution([value]));
});

test('benchmark summaries retain failures, timeouts and unstarted denominators', () => {
  const row = (status, taskMs, failure, calls = []) => ({ status, taskMs, failure, calls });
  const r = summarize([row('passed', 10, null, [{ durationMs: 8, responseBytes: 30 }]),
    row('failed', 6000, 'deadline', [{ durationMs: 5990, responseBytes: 0 }]),
    row('failed', null, 'setup:execution-error'), row('not-run', null, 'interrupted')]);
  assert.equal(r.oraclePassRate, .25); assert.equal(r.failed, 2); assert.equal(r.notRun, 1);
  assert.equal(r.taskMs.count, 2); assert.equal(r.taskMs.p95, 6000);
  assert.equal(r.toolMs.count, 2); assert.equal(r.toolMs.p95, 5990);
  assert.equal(r.failureCategories.deadline, 1);
});

test('benchmark order is a deterministic permutation with validated seed', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(seededOrder(items, 1729), seededOrder(items, 1729));
  assert.notDeepEqual(seededOrder(items, 1729), seededOrder(items, 1730));
  assert.deepEqual([...seededOrder(items, 1)].sort((a, b) => a - b), items);
  for (const seed of [0, -1, 1.5, NaN, Infinity, 0x100000000]) {
    assert.throws(() => seededOrder(items, seed));
    await assert.rejects(runCases({ cases: [{ id: 'one' }], seed }));
  }
});

test('benchmark runner separates warmups and setup, continues on failure, and redacts messages', async () => {
  let calls;
  const cases = ['pass', 'oracle', 'setup'].map(id => ({ id, group: 'test',
    run: async () => { calls.push({ durationMs: 4, responseBytes: 12 }); },
    verify: async () => { if (id === 'oracle') assert.fail('secret page payload'); } }));
  const adapter = { recordInto: value => { calls = value; }, prepare: async task => {
    assert.equal(calls, undefined); if (task.id === 'setup') throw new Error('secret setup payload'); return {};
  } };
  const result = await runCases({ cases, samples: 2, warmups: 1, adapter });
  assert.equal(result.rows.length, 9); assert.equal(result.measured.planned, 6);
  assert.equal(result.warmup.planned, 3); assert.equal(result.measured.passed, 2);
  assert.equal(result.measured.failed, 4); assert.equal(result.measured.taskMs.count, 4);
  assert.equal(result.measured.toolMs.count, 4); assert.equal(result.measured.toolMs.p50, 4);
  assert.equal(result.measured.failureCategories['oracle-mismatch'], 2);
  assert.equal(result.measured.failureCategories['setup:execution-error'], 2);
  assert.equal(result.groups[0].planned, 6); assert.equal(result.groups[0].group, 'test');
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(calls, undefined);
});

test('benchmark cancellation retains every requested row without dispatching later tasks', async () => {
  const controller = new AbortController(); let prepared = 0;
  const cases = [{ id: 'cancel', group: 'test', run: async () => { controller.abort(); throw controller.signal.reason; }, verify: async () => {} }];
  const result = await runCases({ cases, samples: 5, warmups: 0, signal: controller.signal,
    adapter: { prepare: async () => { prepared++; return {}; }, recordInto() {} } });
  assert.equal(prepared, 1); assert.equal(result.rows.length, 5);
  assert.equal(result.measured.failed, 1); assert.equal(result.measured.notRun, 4);
  assert.equal(result.measured.failureCategories.cancelled, 1);
  assert.equal(result.measured.oraclePassRate, 0);
});

test('benchmark catalog contains 20 unique predeclared cases and bounded failure categories', () => {
  assert.equal(benchmarkCases.length, 20); assert.equal(new Set(benchmarkCases.map(c => c.id)).size, 20);
  assert.ok(benchmarkCases.some(c => c.group === 'waiting')); assert.ok(benchmarkCases.some(c => c.group === 'safety'));
  assert.equal(failureCode({ name: 'TimeoutError' }), 'deadline');
  assert.equal(failureCode({ code: 'CONNECTION_LOST' }), 'CONNECTION_LOST');
  assert.equal(failureCode({ code: 'private text', message: 'secret' }), 'execution-error');
});

test('benchmark does not start an action after cancellation during setup', async () => {
  const controller = new AbortController(); let ran = false;
  const result = await runCases({ cases: [{ id: 'one', group: 'test', run: async () => { ran = true; }, verify() {} }],
    samples: 1, warmups: 0, signal: controller.signal,
    adapter: { prepare: async () => { controller.abort(); return {}; }, recordInto() {} } });
  assert.equal(ran, false); assert.equal(result.measured.failed, 1);
  assert.equal(result.rows[0].taskMs, null); assert.equal(result.rows[0].failure, 'setup:cancelled');
});

test('isolated native harness rejects unknown brands before creating profiles or processes',async()=>{
  const {nativeAdapter}=await import('../scripts/benchmark/native-adapter.mjs');
  for(const brand of ['firefox','../chrome','',null])await assert.rejects(nativeAdapter({brand}),/Unsupported isolated browser brand/);
});
