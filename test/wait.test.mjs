import assert from 'node:assert/strict';
import test from 'node:test';
import { actionDeadline, ChangeClock, waitUntil } from '../dist/packages/provider-chromium/src/wait.js';

test('event during predicate closes the lost-wakeup race', async () => {
  const clock = new ChangeClock(); let count = 0;
  const result = await waitUntil(async () => { if (++count === 1) { clock.pulse(); return undefined; } return 'ready'; },
    { signal: AbortSignal.timeout(200), clock, fallbackMs: 1000 });
  assert.equal(result, 'ready'); assert.equal(count, 2);
});

test('event wakes multiple readers and cancellation cleans up independently', async () => {
  const clock = new ChangeClock(), controller = new AbortController();
  const cancelled = clock.wait(0, controller.signal, 1000);
  const first = clock.wait(0, AbortSignal.timeout(200), 1000);
  const second = clock.wait(0, AbortSignal.timeout(200), 1000);
  controller.abort(); clock.pulse();
  await assert.rejects(cancelled, e => e.code === 'CANCELLED');
  await Promise.all([first, second]);
  assert.equal(clock.revision, 1);
});

test('one deadline is shared by all predicate retries', async () => {
  const deadline = actionDeadline(new AbortController().signal, 35);
  let checks = 0;
  try {
    await assert.rejects(waitUntil(async () => { checks++; return undefined; },
      { signal: deadline.signal, clock: new ChangeClock(), fallbackMs: 5 }), e => e.code === 'DEADLINE_EXCEEDED');
    assert.ok(checks > 1);
  } finally { deadline.dispose(); }
});

test('already cancelled callers never run a predicate', async () => {
  let called = false;
  await assert.rejects(waitUntil(async () => { called = true; return true; },
    { signal: AbortSignal.abort(), clock: new ChangeClock() }), e => e.code === 'CANCELLED');
  assert.equal(called, false);
});
