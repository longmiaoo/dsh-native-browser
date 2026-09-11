import assert from 'node:assert/strict';

/** Owned loopback fixture only. The baseline is measured outside the production observation path. */
export async function verifyLargeObservation({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const fixture = document.createElement('div'); fixture.id = 'large-ax-fixture';
    const region = document.createElement('section'); region.setAttribute('aria-label', '大页面目标区');
    region.style.cssText = 'position:fixed;right:20px;top:20px;background:white;z-index:20;padding:12px';
    const button = document.createElement('button'); button.textContent = '大页面保存'; button.id = 'large-ax-save';
    const status = document.createTextNode('等待大页面保存');
    window.largeAXClicks = [];
    button.addEventListener('click', event => { window.largeAXClicks.push(event.isTrusted); status.textContent = '大页面已保存'; });
    region.append(button, status);
    const bulk = document.createElement('section'); bulk.setAttribute('aria-label', '大页面列表');
    window.largeAXLastClicks = [];
    for (let i = 0; i < 4000; i++) {
      const b = document.createElement('button'); b.textContent = `列表按钮 ${i} · 大规模语义观察`;
      if (i === 3999) b.addEventListener('click', event => { window.largeAXLastClicks.push(event.isTrusted); status.textContent = '大页面末尾已保存'; });
      bulk.append(b);
    }
    fixture.append(region, bulk); document.body.prepend(fixture);
  });
  const baseline = await page.context().newCDPSession(page);
  try {
    await baseline.send('Accessibility.enable');
    const rawBytes = Buffer.byteLength(JSON.stringify(await baseline.send('Accessibility.getFullAXTree')));
    assert.ok(rawBytes > 1024 * 1024, `fixture must exceed native frame limit, got ${rawBytes}`);
    const whole = await observe();
    assert.equal(whole.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(whole)) < 96 * 1024);
    const root = whole.nodes.find(n => n.kind === 'region' && n.name === '大页面目标区'); assert.ok(root);
    const local = await observe({ rootRef: root.id });
    assert.equal(local.truncated, false);
    assert.equal(local.nodes.some(n => n.name.startsWith('列表按钮')), false);
    const button = local.nodes.find(n => n.name === '大页面保存'); assert.ok(button);
    const result = await act('large-ax-save-once', { kind: 'click', ref: button.id, expected: { kind: 'text', text: '大页面已保存' } });
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
    await act('large-ax-save-once', { kind: 'click', ref: button.id, expected: { kind: 'text', text: '大页面已保存' } });
    assert.deepEqual(await page.evaluate(() => window.largeAXClicks), [true]);
    const query = { name: '列表按钮 3999 · 大规模语义观察', role: 'button' };
    assert.equal(whole.nodes.some(n => n.name === query.name), false);
    const found = await observe({ query, cursor: whole.cursor });
    assert.deepEqual(found.scope, { kind: 'query', query });
    assert.equal(found.resyncReason, 'scope-changed');
    assert.equal(found.truncated, false); assert.equal(found.nodes.length, 1);
    const lastAction = { kind: 'click', ref: found.nodes[0].id, expected: { kind: 'text', text: '大页面末尾已保存' } };
    assert.equal((await act('large-ax-last-once', lastAction)).outcome, 'succeeded');
    await act('large-ax-last-once', lastAction);
    assert.deepEqual(await page.evaluate(() => window.largeAXLastClicks), [true]);
    return { passed: [
      'A 4,000-button page whose raw AX exceeds 1 MiB remains observable with explicit truncation',
      'Known-root traversal recovers a complete small region without unrelated controls',
      'Large-page target receives one trusted verified click, including request deduplication',
      'Exact semantic search finds a target beyond discovery bounds and clicks it once with verified feedback',
    ], metrics: { buttons: 4000, rawAXBytes: rawBytes, observationBytes: Buffer.byteLength(JSON.stringify(whole)),
      scope: 'Loopback stress fixture; raw measurement-only baseline versus bounded observation, not browser memory or performance certification' } };
  } finally { await baseline.detach(); await page.evaluate(() => { document.querySelector('#large-ax-fixture')?.remove(); delete window.largeAXClicks; delete window.largeAXLastClicks; }); }
}
