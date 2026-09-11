import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const task = (id, group, description, run, verify, prepare) => ({ id, group, description, run, verify, prepare });
const succeeded = result => { assert.equal(result.outcome, 'succeeded'); assert.equal(result.postcondition, 'passed'); };
const trusted = async (h, id, type) => {
  const events = await h.page.evaluate(({ id, type }) => bench.events.filter(e => e.id === id && e.type === type), { id, type });
  assert.ok(events.length); assert.ok(events.every(e => e.trusted));
};
const fieldOracle = (id, expected) => async (h, result) => { succeeded(result); assert.equal(await h.page.locator('#' + id).inputValue(), expected); await trusted(h, id, 'input'); };

/** Predeclared L1 executor tasks, not model or real-site tasks. Labels are fixture
 * constants; refs are always acquired through the production observation path. */
export const benchmarkCases = [
  task('observe-full', 'observe', 'Warm whole-document AX observation', h => h.observe(), async (h, r) => {
    assert.equal(r.format, 'full'); assert.ok(r.nodes.some(n => n.name === 'Benchmark input')); assert.equal(r.truncated, false);
  }),
  task('observe-delta', 'observe', 'Unchanged exact-base delta', h => h.observe({ cursor: h.snapshot.cursor }), async (h, r) => {
    assert.equal(r.format, 'delta'); assert.equal(r.baseCursor, h.snapshot.cursor); assert.deepEqual(r.nodes, { upsert: [], remove: [] }); assert.equal(r.text, undefined);
  }),
  task('observe-text-delta', 'observe', 'One changed text fragment', h => h.observe({ cursor: h.snapshot.cursor }), async (h, r) => {
    assert.equal(r.format, 'delta'); assert.ok(r.text.insert.includes('Changed reading content'));
  }, h => h.page.locator('#reading').evaluate(e => { e.textContent = 'Changed reading content'; })),
  task('observe-subtree', 'observe', 'Explicit known form subtree', h => h.observe({ rootRef: h.ref('Benchmark form') }), async (h, r) => {
    assert.equal(r.scope.kind, 'subtree'); assert.ok(r.nodes.some(n => n.name === 'Benchmark input')); assert.equal(r.nodes.some(n => n.name === 'Radio B'), false);
  }),
  task('query-exact', 'observe', 'Exact source-filtered target discovery', h => h.observe({ query: { name: 'Delayed feedback', role: 'button' } }), async (h, r) => {
    assert.equal(r.nodes.length, 1); assert.equal(r.nodes[0].name, 'Delayed feedback');
  }),
  task('query-ambiguous', 'safety', 'Duplicate names remain separate candidates', h => h.observe({ query: { name: 'Duplicate', role: 'button' } }), async (h, r) => {
    assert.equal(r.nodes.length, 2); assert.notEqual(r.nodes[0].id, r.nodes[1].id); assert.deepEqual(await h.page.evaluate(() => [bench.counts.a, bench.counts.b]), [0, 0]);
  }),
  task('fill-native', 'action', 'Chinese native input with final value verification', h => h.act({ kind: 'fill', ref: h.ref('Benchmark input'), text: '基线输入🙂' }), fieldOracle('input', '基线输入🙂')),
  task('append-textarea', 'action', 'Append without refilling existing textarea content', h => h.act({ kind: 'append', ref: h.ref('Benchmark textarea'), text: '\n追加' }), fieldOracle('area', 'Original\n追加')),
  task('check-native', 'action', 'Set native checkbox state', h => h.act({ kind: 'check', ref: h.ref('Checkbox'), checked: true }), async (h, r) => {
    succeeded(r); assert.equal(await h.page.locator('#check').isChecked(), true); await trusted(h, 'check', 'input');
  }),
  task('radio-native', 'action', 'Choose another native radio', h => h.act({ kind: 'check', ref: h.ref('Radio B'), checked: true }), async (h, r) => {
    succeeded(r); assert.equal(await h.page.locator('#radio-b').isChecked(), true); await trusted(h, 'radio-b', 'input');
  }),
  task('fill-editor', 'action', 'Multiline contenteditable replacement', h => h.act({ kind: 'fill', ref: h.ref('Rich editor'), text: '编辑器\n第二行' }), async (h, r) => {
    succeeded(r); assert.equal(await h.page.locator('#editor').innerText(), '编辑器\n第二行'); await trusted(h, 'editor', 'input');
  }),
  task('fill-shadow', 'action', 'Open-shadow native input', h => h.act({ kind: 'fill', ref: h.ref('Shadow input'), text: 'shadow' }), fieldOracle('shadow-input', 'shadow')),
  task('keyboard-submit', 'action', 'Trusted Enter and verified form completion', h => h.act({ kind: 'press', ref: h.ref('Benchmark input'), key: 'Enter', expected: { kind: 'text', text: 'Form submitted' } }), async (h, r) => {
    succeeded(r); assert.equal(await h.page.evaluate(() => bench.counts.submit), 1); await trusted(h, 'input', 'keydown');
  }),
  task('delayed-click', 'waiting', 'Click with 80ms delayed page feedback', h => h.act({ kind: 'click', ref: h.ref('Delayed feedback'), expected: { kind: 'text', text: 'Delayed saved' } }), async (h, r) => {
    succeeded(r); assert.equal(await h.page.evaluate(() => bench.counts.delayed), 1); await trusted(h, 'delayed', 'click');
  }),
  task('overlay-click', 'waiting', 'Wait for a temporary 120ms modal overlay', async h => {
    await h.page.evaluate(() => { document.querySelector('#cover').style.display = 'block'; setTimeout(() => document.querySelector('#cover').style.display = 'none', 120); });
    return h.act({ kind: 'click', ref: h.overlayRef, expected: { kind: 'text', text: 'Clicked a' } });
  }, async (h, r) => { succeeded(r); assert.deepEqual(await h.page.evaluate(() => [bench.counts.a, bench.counts.b]), [1, 0]); await trusted(h, 'a', 'click'); }, async h => {
    const result = await h.observe({ rootRef: h.ref('Group A'), query: { name: 'Duplicate', role: 'button' } });
    assert.equal(result.nodes.length, 1); h.overlayRef = result.nodes[0].id;
  }),
  task('scroll-region', 'action', 'Known overflow container and verified loaded text', h => h.act({ kind: 'scroll', ref: h.ref('Scroll region'), deltaX: 0, deltaY: 180, expected: { kind: 'text', text: 'Scrolled' } }), async (h, r) => {
    succeeded(r); assert.equal(r.scroll.moved, true); assert.equal(await h.page.locator('#pane').evaluate(e => e.scrollTop), 180);
  }),
  task('wheel-handler', 'action', 'One trusted wheel sample to a custom handler', h => h.act({ kind: 'wheel', ref: h.ref('Wheel region'), deltaX: 0, deltaY: 90, expected: { kind: 'text', text: 'Wheel received' } }), async (h, r) => {
    succeeded(r); assert.equal(await h.page.evaluate(() => bench.counts.wheel), 1); await trusted(h, 'canvas', 'wheel');
  }),
  task('stale-rejection', 'safety', 'Same-name replacement receives no input', h => h.act({ kind: 'fill', ref: h.ref('Benchmark input'), text: 'must not type' }), async (h, r) => {
    assert.equal(r.code, 'STALE_TARGET'); assert.equal(r.dispatch, 'notDispatched'); assert.equal(await h.page.locator('#input').inputValue(), '');
    assert.equal(await h.page.evaluate(() => bench.events.filter(e => e.type === 'input').length), 0);
  }, h => h.page.locator('#input').evaluate(e => e.replaceWith(e.cloneNode(true)))),
  task('origin-rejection', 'safety', 'Cross-origin navigation is refused before dispatch', h => h.act({ kind: 'navigate', url: 'https://blocked.invalid/' }), async (h, r) => {
    assert.equal(r.code, 'POLICY_DENIED'); assert.equal(r.dispatch, 'notDispatched'); assert.equal(new URL(h.page.url()).hostname, '127.0.0.1');
  }),
  task('capture-host', 'capture', 'Canonical DSH screenshot attachment and byte hash', h => h.capture(), async (h, r) => {
    const image = await h.readImage(r.attachment); assert.equal(createHash('sha256').update(image.data).digest('hex'), r.screenshot.sha256);
    assert.ok(r.attachment.width > 0 && r.attachment.height > 0); assert.equal(r.screenshot.leaseId, h.lease.id);
  }),
];
