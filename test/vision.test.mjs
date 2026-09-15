import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ScreenshotRegistry } from '../dist/packages/vision-adapter/src/screenshots.js';
import { boxToViewport } from '../dist/packages/vision-adapter/src/geometry.js';
import { parseRouterGrounding } from '../dist/packages/vision-adapter/src/grounding.js';

function fixture(options) {
  let now = 10000;
  const registry = new ScreenshotRegistry(options, () => now);
  const bytes = Buffer.from('canonical Host bytes, not original browser JPEG');
  const image = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, width: 800, height: 600, bytes };
  const shot = { tab: 'tab', documentEpoch: 'doc', capturedAt: now, mimeType: 'image/jpeg', data: Buffer.from('different original bytes').toString('base64'),
    viewport: { width: 1200, height: 900, pageX: 0, pageY: 2000 },
    redaction: { policy: 'cross-origin-frames', frames: 0, regions: 0 } };
  const add = (owner = 'turn-a', lease = 'lease-a') => registry.register(owner, lease, shot, image);
  return { registry, image, shot, add, advance: delta => { now += delta; } };
}

test('canonical Host bytes determine screenshot hash and dimensions', () => {
  const f = fixture(), ref = f.add();
  assert.equal(ref.sha256, createHash('sha256').update(f.image.bytes).digest('hex'));
  assert.notEqual(ref.sha256, createHash('sha256').update(Buffer.from(f.shot.data, 'base64')).digest('hex'));
  assert.equal(ref.attachmentId, f.image.attachmentId);
  assert.deepEqual(ref.redaction, { policy: 'cross-origin-frames', frames: 0, regions: 0 });
  assert.deepEqual(ref.imageToViewport, [1.5, 0, 0, 1.5, 0, 0]);
});

test('screenshot identity never grants another turn access, even for identical content', () => {
  const f = fixture(), a = f.add(), b = f.add('turn-b');
  assert.equal(a.sha256, b.sha256); assert.notEqual(a.id, b.id);
  assert.throws(() => f.registry.get('turn-b', a.id), e => e.code === 'STALE_TARGET');
  assert.throws(() => f.registry.get('turn-a', a.attachmentId), e => e.code === 'STALE_TARGET');
  assert.throws(() => f.registry.get('turn-a', a.id.slice(0, 8)), e => e.code === 'STALE_TARGET');
});

test('stored screenshot metadata is not mutable by the caller', () => {
  const f = fixture(), ref = f.add(); ref.viewport.pageY = 99; ref.imageSize.width = 1; ref.imageToViewport[0] = 99; ref.redaction.frames = 99;
  f.shot.viewport.width = 9000; f.image.width = 2;
  const stored = f.registry.get('turn-a', ref.id);
  assert.equal(stored.viewport.width, 1200); assert.equal(stored.viewport.pageY, 2000);
  assert.equal(stored.imageSize.width, 800); assert.equal(stored.imageToViewport[0], 1.5);
  assert.equal(stored.redaction.frames, 0);
});

test('TTL, capacity, lease handoff and turn end revoke only the intended references', () => {
  const f = fixture({ maxEntries: 2, ttlMs: 100 });
  const a = f.add(), b = f.add('turn-b'), c = f.add('turn-a', 'lease-c');
  assert.throws(() => f.registry.get('turn-a', a.id), e => e.code === 'STALE_TARGET');
  f.registry.revokeLease('turn-b', 'lease-c'); assert.equal(f.registry.get('turn-a', c.id).leaseId, 'lease-c');
  f.registry.revokeLease('turn-a', 'lease-c'); assert.throws(() => f.registry.get('turn-a', c.id));
  f.registry.revokeOwner('turn-a'); assert.equal(f.registry.get('turn-b', b.id).id, b.id);
  f.advance(100); assert.throws(() => f.registry.get('turn-b', b.id), e => e.code === 'STALE_TARGET');
});

test('registry rejects forged content identity and invalid source metadata', () => {
  const f = fixture();
  assert.throws(() => f.registry.register('turn-a', 'lease', f.shot, { ...f.image, attachmentId: `sha256:${'0'.repeat(64)}` }), e => e.code === 'INVALID_REQUEST');
  assert.throws(() => f.registry.register('turn-a', 'lease', f.shot, { ...f.image, width: 0 }), e => e.code === 'INVALID_REQUEST');
  assert.throws(() => f.registry.register('turn-a', 'lease', { ...f.shot, capturedAt: 999999 }, f.image));
  assert.throws(() => f.registry.register('turn-a', 'lease', { ...f.shot, redaction: undefined }, f.image));
  assert.throws(() => f.registry.register('turn-a', 'lease', { ...f.shot,
    redaction: { policy: 'cross-origin-frames', frames: 0, regions: 1 } }, f.image));
  assert.throws(() => new ScreenshotRegistry({ maxEntries: 0, ttlMs: 100 }));
});

test('public Router result maps once from Host canonical pixels, without a second letterbox/scroll correction', () => {
  const f = fixture(), ref = f.add();
  const candidate = parseRouterGrounding(f.registry, 'turn-a', ref.id, 'Submit button', JSON.stringify({ x1: 100, y1: 200, x2: 300, y2: 400, width: 800, height: 600 }));
  assert.deepEqual(candidate.viewportBox, { x1: 150, y1: 300, x2: 450, y2: 600 });
  assert.deepEqual(candidate.viewportPoint, { x: 300, y: 450 });
  assert.equal(candidate.screenshotSha256, ref.sha256); assert.equal('confidence' in candidate, false);
  assert.equal(candidate.leaseId, 'lease-a'); assert.equal(candidate.documentEpoch, 'doc');
});

test('unavailable backend, wrong image size/space, malformed JSON and impossible boxes fail explicitly', () => {
  const f = fixture(), ref = f.add();
  const parse = raw => parseRouterGrounding(f.registry, 'turn-a', ref.id, 'Button', raw);
  assert.throws(() => parse('{"ok":false,"code":"RATE_LIMIT"}'), e => e.code === 'VISION_UNAVAILABLE');
  const base = { x1: 10, y1: 10, x2: 50, y2: 50, width: 800, height: 600 };
  for (const change of [{ width: 1000 }, { coordinateSpace: 'normalized-1000' }]) {
    assert.throws(() => parse(JSON.stringify({ ...base, ...change })), e => e.code === 'STALE_TARGET');
  }
  for (const change of [{ x1: -1 }, { x2: 900 }, { x1: 60 }, { y2: null }, { x1: '10' }, { y1: 50 }]) {
    assert.throws(() => parse(JSON.stringify({ ...base, ...change })), e => e.code === 'INVALID_REQUEST');
  }
  for (const raw of ['', '```json {} ```', '[]', 'null', '{}', 'x'.repeat(70000)]) assert.throws(() => parse(raw));
  f.registry.revokeOwner('turn-a'); assert.throws(() => parse(JSON.stringify(base)), e => e.code === 'STALE_TARGET');
});

// 30 deterministic raster/CSS fixtures: DPR, zoom, Host downscaling and scroll
// affect the capture metadata; only the recorded image-to-viewport map is used.
for (const dpr of [1, 1.25, 1.5, 2, 3]) for (const zoom of [0.8, 1, 1.25]) for (const scroll of [0, 1800]) {
  test(`image/CSS geometry: DPR=${dpr}, zoom=${zoom}, scroll=${scroll}`, () => {
    const viewport = { width: 1200 / zoom, height: 800 / zoom, pageX: 0, pageY: scroll };
    const hostScale = Math.min(1, 1000 / (viewport.width * dpr));
    const image = { width: Math.round(viewport.width * dpr * hostScale), height: Math.round(viewport.height * dpr * hostScale) };
    const transform = [viewport.width / image.width, 0, 0, viewport.height / image.height, 0, 0];
    const mapped = boxToViewport({ x1: image.width * 0.2, y1: image.height * 0.3, x2: image.width * 0.6, y2: image.height * 0.5 }, image, viewport, transform);
    assert.ok(Math.abs(mapped.point.x - viewport.width * 0.4) < 1e-8);
    assert.ok(Math.abs(mapped.point.y - viewport.height * 0.4) < 1e-8);
  });
}

test('affine conversion handles crop offsets and rotation by mapping all four corners', () => {
  const image = { width: 100, height: 200 }, viewport = { width: 500, height: 400 };
  const mapped = boxToViewport({ x1: 10, y1: 50, x2: 30, y2: 90 }, image, viewport, [0, 1, -1, 0, 300, 20]);
  assert.deepEqual(mapped.box, { x1: 210, y1: 30, x2: 250, y2: 50 });
  assert.deepEqual(mapped.point, { x: 230, y: 40 });
});

test('singular, nonfinite and out-of-viewport transforms cannot produce an action point', () => {
  const image = { width: 100, height: 100 }, box = { x1: 0, y1: 0, x2: 10, y2: 10 };
  for (const matrix of [[0, 0, 0, 0, 0, 0], [Infinity, 0, 0, 1, 0, 0], [1, 0, 0, 1, -1, 0], [1, 0, 0, 1, 100, 0]]) {
    assert.throws(() => boxToViewport(box, image, image, matrix), e => e.code === 'INVALID_REQUEST');
  }
});
