import assert from 'node:assert/strict';

// Fixed loopback fixture only. All actions go through the caller's production runtime.
export async function verifyScroll({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  const observation = await observe();
  const ref = name => {
    const node = observation.nodes.find(n => n.kind === 'region' && n.name === name);
    assert.ok(node, `Missing scroll region: ${name}`); return node.id;
  };
  const outer = ref('滚动容器'), inner = ref('内层滚动容器'), rtl = ref('RTL滚动容器');
  const positions = () => page.evaluate(() => {
    const xy = element => [element.scrollLeft, element.scrollTop];
    return { document: xy(document.scrollingElement), outer: xy(document.getElementById('scroll-pane')),
      inner: xy(document.getElementById('nested-scroll-pane')), rtl: xy(document.getElementById('rtl-scroll-pane')) };
  });
  const initial = await positions(); assert.deepEqual(initial.document, [0, 0]);
  const down = { kind: 'scroll', deltaX: 0, deltaY: 320 };
  const moved = await act('scroll-document-down', down);
  assert.equal(moved.outcome, 'succeeded'); assert.equal(moved.scroll.before.y, 0); assert.equal(moved.scroll.after.y, 320);
  assert.deepEqual(await act('scroll-document-down', down), moved);
  assert.deepEqual((await positions()).document, [0, 320], 'A duplicate cannot move twice');
  assert.equal((await act('scroll-document-up', { ...down, deltaY: -320 })).outcome, 'succeeded');
  assert.deepEqual((await positions()).document, initial.document);

  const pane = await act('scroll-outer', { kind: 'scroll', ref: outer, deltaX: 120, deltaY: 200,
    expected: { kind: 'text', text: '已加载滚动内容' } });
  assert.equal(pane.outcome, 'succeeded'); assert.deepEqual(pane.scroll.target, { kind: 'element', ref: outer });
  assert.deepEqual([pane.scroll.after.x, pane.scroll.after.y], [120, 200]);
  assert.deepEqual(await positions(), { ...initial, outer: [120, 200] });
  const nested = await act('scroll-inner', { kind: 'scroll', ref: inner, deltaX: 90, deltaY: 80 });
  assert.equal(nested.outcome, 'succeeded');
  assert.deepEqual(await positions(), { ...initial, outer: [120, 200], inner: [90, 80] }, 'No implicit ancestor scrolling');

  const reversed = await act('scroll-rtl', { kind: 'scroll', ref: rtl, deltaX: -100, deltaY: 0 });
  assert.equal(reversed.outcome, 'succeeded'); assert.equal(reversed.scroll.after.x, -100);
  assert.deepEqual((await positions()).rtl, [-100, 0]);
  assert.equal((await act('scroll-boundary', { kind: 'scroll', ref: outer, deltaX: 0, deltaY: 10000 })).outcome, 'succeeded');
  const boundary = await act('scroll-no-movement', { kind: 'scroll', ref: outer, deltaX: 0, deltaY: 80 });
  assert.equal(boundary.outcome, 'unknown'); assert.equal(boundary.scroll.moved, false);
  assert.deepEqual(boundary.scroll.before, boundary.scroll.after);

  // Replace only our fixture container; its old ref must not follow the same-name replacement.
  await page.locator('#scroll-pane').evaluate(element => {
    const replacement = element.cloneNode(false);
    while (element.firstChild) replacement.append(element.firstChild);
    element.replaceWith(replacement);
  });
  const beforeStale = await positions();
  const stale = await act('scroll-replaced-region', { kind: 'scroll', ref: outer, deltaX: 0, deltaY: 80 });
  assert.equal(stale.code, 'STALE_TARGET'); assert.equal(stale.dispatch, 'notDispatched');
  assert.deepEqual(await positions(), beforeStale);
  return ['Document scrolling returns actual offsets and deduplicates physical movement',
    'Named container scrolling verifies loaded text without moving the document',
    'Nested scrolling changes only the exact target, including offscreen descendants',
    'RTL scrolling preserves negative horizontal offsets',
    'Clamped boundary returns unchanged evidence and unknown rather than false success',
    'Replaced scroll container rejects its old reference before dispatch'];
}
