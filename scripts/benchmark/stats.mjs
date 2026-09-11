/** No implicit success filtering, timeout deletion, zero-fill or pooled case medians. */
export function distribution(values) {
  if (values.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid duration');
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, min: sorted[0], p50: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95: sorted[Math.ceil(.95 * n) - 1], max: sorted[n - 1] };
}
export function summarize(rows) {
  const count = status => rows.filter(r => r.status === status).length;
  const categories = {};
  for (const row of rows) if (row.failure) categories[row.failure] = (categories[row.failure] ?? 0) + 1;
  return { planned: rows.length, passed: count('passed'), failed: count('failed'), notRun: count('not-run'),
    oraclePassRate: rows.length ? count('passed') / rows.length : null, failureCategories: categories,
    taskMs: distribution(rows.filter(r => r.taskMs !== null).map(r => r.taskMs)),
    // Empty/setup-failed tasks have no measured tool interval, NOT a zero-latency tool.
    toolMs: distribution(rows.filter(r => r.calls.length).map(r => r.calls.reduce((n, c) => n + c.durationMs, 0))),
    responseBytes: distribution(rows.filter(r => r.calls.length).map(r => r.calls.reduce((n, c) => n + c.responseBytes, 0))) };
}
export function seededOrder(items, seed) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error('Invalid seed');
  let state = seed >>> 0;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const j = (state >>> 0) % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Save only typed outcome metadata; errors/assertions may contain page data. */
export function failureCode(error) {
  if (error?.code === 'ERR_ASSERTION') return 'oracle-mismatch';
  if (error?.name === 'TimeoutError' || error?.code === 'DEADLINE_EXCEEDED') return 'deadline';
  if (error?.name === 'AbortError' || error?.code === 'CANCELLED') return 'cancelled';
  if (['CONNECTION_LOST', 'LEASE_REVOKED', 'POLICY_DENIED', 'STALE_TARGET', 'QUEUE_FULL'].includes(error?.code)) return error.code;
  return 'execution-error';
}

/** Every requested sample gets a row, including setup failure and unstarted work.
 * Adapter setup is outside task latency; run + independent oracle are inside it. */
export async function runCases({ cases, samples = 5, warmups = 1, seed = 1729, adapter, signal, progress = () => {} }) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 50 || !Number.isInteger(warmups) || warmups < 0 || warmups > 5
    || !Number.isInteger(seed) || seed < 1 || seed > 0xffffffff
    || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Invalid benchmark configuration');
  const rows = [];
  for (let round = 0; round < samples + warmups; round++) {
    const phase = round < warmups ? 'warmup' : 'measured';
    for (const [order, task] of seededOrder(cases, (seed + round) >>> 0 || 1).entries()) {
      const row = { taskId: task.id, group: task.group, phase, round, order, status: 'not-run', failure: null,
        setupMs: null, taskMs: null, calls: [] };
      rows.push(row);
      if (signal?.aborted) { row.failure = 'interrupted'; continue; }
      let started;
      try {
        const setupAt = performance.now();
        const context = await adapter.prepare(task, `${phase}-${round}-${order}`, signal);
        row.setupMs = performance.now() - setupAt;
        signal?.throwIfAborted();
        // Only the task's tool calls are recorded; bootstrap/claim/known-ref setup are excluded.
        adapter.recordInto(row.calls);
        started = performance.now();
        const result = await task.run(context);
        await task.verify(context, result);
        row.status = 'passed';
      } catch (error) {
        row.status = 'failed'; row.failure = started === undefined ? `setup:${failureCode(error)}` : failureCode(error);
      } finally {
        if (started !== undefined) row.taskMs = performance.now() - started;
        adapter.recordInto(undefined);
      }
      progress({ taskId: row.taskId, phase, round, status: row.status });
    }
  }
  return { rows, measured: summarize(rows.filter(r => r.phase === 'measured')),
    warmup: summarize(rows.filter(r => r.phase === 'warmup')),
    groups: [...new Set(cases.map(c => c.group))].map(group => ({ group,
      ...summarize(rows.filter(r => r.phase === 'measured' && r.group === group)) })),
    tasks: cases.map(c => ({ id: c.id, group: c.group, description: c.description,
      ...summarize(rows.filter(r => r.phase === 'measured' && r.taskId === c.id)) })) };
}
