import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { geometryFunction, sameGeometry } from '../dist/packages/provider-chromium/src/actionability.js';
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function element(rect = box(0, 0, 100, 40), options = {}) {
  return { isConnected: true, tagName: 'DIV', tabIndex: -1, parentElement: null,
    getBoundingClientRect: () => rect, getClientRects: () => [rect], getRootNode: () => ({}),
    getAttribute: () => null, matches: () => false, ...options };
}
function measure(target, hit, preferred) {
  const fn = vm.runInNewContext(`(${geometryFunction})`, { innerWidth: 800, innerHeight: 600,
    document: { elementFromPoint: hit }, getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1',
      overflowX: 'visible', overflowY: 'visible', ...node.style }) });
  return fn.call(target, preferred);
}

test('partial overlays select an exposed point rather than the covered center', () => {
  const target = element(), overlay = element();
  const result = measure(target, x => x < 30 ? target : overlay);
  assert.equal(result.ok, true); assert.equal(result.x, 15); assert.equal(result.y, 20);
});

test('fragment geometry avoids the empty gap in a multiline bounding rectangle', () => {
  const rects = [box(0, 0, 100, 20), box(0, 80, 60, 20)], target = element(box(0, 0, 100, 100), { getClientRects: () => rects });
  const result = measure(target, (_x, y) => y <= 20 || y >= 80 ? target : null);
  assert.equal(result.ok, true); assert.equal(result.y, 10);
});

test('viewport and overflow clipping select the actual exposed portion', () => {
  const clipped = element(box(-160, 10, 200, 40));
  const viewport = measure(clipped, () => clipped);
  assert.equal(viewport.ok, true); assert.equal(viewport.x, 20); assert.equal(viewport.inViewport, true);
  const parent = element(box(0, 0, 20, 40), { style: { overflowX: 'hidden' } });
  const child = element(box(0, 0, 280, 40), { parentElement: parent });
  assert.equal(measure(child, x => x < 20 ? child : parent).x, 10);
});

test('noninteractive descendants are valid but nested independent controls are not', () => {
  const target = element(), icon = element(undefined, { parentElement: target });
  assert.equal(measure(target, () => icon).ok, true);
  const child = element(undefined, { parentElement: target, matches: selector => selector !== ':disabled' });
  assert.equal(measure(target, () => child).ok, false);
});

test('open shadow roots are descended before deciding hit ownership', () => {
  const host = element(), target = element(undefined, { getRootNode: () => ({ host }) });
  host.shadowRoot = { elementFromPoint: () => target };
  assert.equal(measure(target, () => host).ok, true);
  const other = element(undefined, { matches: selector => selector !== ':disabled' });
  host.shadowRoot.elementFromPoint = () => other;
  assert.equal(measure(target, () => host).ok, false);
});

test('invisible/inert/aria-disabled ancestors and native disabled controls cannot pass', () => {
  for (const parent of [element(undefined, { style: { opacity: '0' } }), element(undefined, { inert: true }),
    element(undefined, { getAttribute: name => name === 'aria-disabled' ? 'true' : null })]) {
    const target = element(undefined, { parentElement: parent }); assert.equal(measure(target, () => target).ok, false);
  }
  const disabled = element(undefined, { matches: selector => selector === ':disabled' });
  assert.equal(measure(disabled, () => disabled).ok, false);
});

test('final point validation does not switch to a different candidate', () => {
  const target = element(), hit = x => x < 30 ? target : null;
  assert.equal(measure(target, hit, { x: 50, y: 20 }).ok, false);
  assert.equal(measure(target, hit, { x: 15, y: 20 }).ok, true);
});

test('candidate search is bounded and geometry comparisons reject invalid numeric evidence', () => {
  let hits = 0, reads = 0;
  const rects = new Proxy({ length: 100000 }, { get: (_value, key) => key === 'length' ? 100000 : (reads++, box(0, 0, 100, 40)) });
  const target = element(undefined, { getClientRects: () => rects });
  assert.equal(measure(target, () => { hits++; return null; }).ok, false);
  assert.equal(reads, 16); assert.equal(hits, 144);
  const a = { x: 1, y: 2, left: 0, top: 0, width: 100, height: 40 };
  assert.equal(sameGeometry(a, { ...a }), true);
  for (const x of [NaN, Infinity, '1', undefined, 4]) assert.equal(sameGeometry(a, { ...a, x }), false);
});
