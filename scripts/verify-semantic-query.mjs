import assert from 'node:assert/strict';
import { applyObservationUpdate } from 'dsh-native-browser/observations';

export async function verifySemanticQuery({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const fixture = document.createElement('div'); fixture.id = 'query-fixture';
    fixture.style.cssText = 'position:fixed;right:20px;top:20px;background:white;z-index:20;padding:12px';
    window.queryClicks = [];
    for (const side of ['左', '右']) {
      const region = document.createElement('section'); region.setAttribute('aria-label', `查询${side}区`);
      const button = document.createElement('button'); button.textContent = '同名保存'; button.id = `query-${side}`;
      const status = document.createTextNode(`等待${side}区`);
      button.addEventListener('click', event => { window.queryClicks.push({ side, trusted: event.isTrusted }); status.textContent = `查询${side}区已保存`; });
      region.append(button, status); fixture.append(region);
    }
    const literal = document.createElement('button'); literal.textContent = 'Query A.*';
    const other = document.createElement('button'); other.textContent = 'Query Abc';
    const frame = document.createElement('iframe'); frame.srcdoc = '<button>同名保存</button><button>仅框架按钮</button>';
    frame.id = 'query-frame'; fixture.append(literal, other, frame); document.body.prepend(fixture);
  });
  try {
    await page.frameLocator('#query-frame').getByRole('button', { name: '仅框架按钮', exact: true }).waitFor();
    const query = { name: '同名保存', role: 'button' };
    const duplicates = await observe({ query });
    assert.equal(duplicates.nodes.length, 2); assert.equal(duplicates.truncated, false);
    assert.equal(new Set(duplicates.nodes.map(n => n.id)).size, 2);
    assert.deepEqual(await page.evaluate(() => window.queryClicks), []);
    const region = await observe({ query: { name: '查询右区', role: 'region' }, cursor: duplicates.cursor });
    assert.equal(region.nodes.length, 1); assert.equal(region.resyncReason, 'scope-changed');
    const rootRef = region.nodes[0].id;
    const local = await observe({ query, rootRef, cursor: duplicates.cursor });
    assert.equal(local.nodes.length, 1); assert.equal(local.resyncReason, 'scope-changed');
    const update = await observe({ query, rootRef, cursor: local.cursor });
    const current = applyObservationUpdate(local, update);
    assert.deepEqual(current.nodes, local.nodes);
    const result = await act('query-right-save', { kind: 'click', ref: current.nodes[0].id, expected: { kind: 'text', text: '查询右区已保存' } });
    assert.equal(result.outcome, 'succeeded');
    assert.deepEqual(await page.evaluate(() => window.queryClicks), [{ side: '右', trusted: true }]);
    const literal = await observe({ query: { name: 'Query A.*', role: 'button' } });
    assert.equal(literal.nodes.length, 1); assert.equal(literal.nodes[0].name, 'Query A.*');
    for (const name of ['Query A', 'query a.*', '仅框架按钮']) {
      const empty = await observe({ query: { name, role: 'button' } });
      assert.equal(empty.nodes.length, 0); assert.equal(empty.truncated, false);
    }
    await page.locator('#query-右').evaluate(element => element.replaceWith(element.cloneNode(true)));
    const stale = await act('query-old-ref', { kind: 'click', ref: current.nodes[0].id });
    assert.equal(stale.outcome, 'failed'); assert.equal(stale.code, 'STALE_TARGET');
    const replacement = await observe({ query, rootRef });
    assert.equal(replacement.nodes.length, 1); assert.notEqual(replacement.nodes[0].id, current.nodes[0].id);
    assert.equal((await page.evaluate(() => window.queryClicks)).length, 1);
    return [
      'Duplicate semantic names return distinct candidates without automatically choosing or clicking',
      'Known-region query disambiguates the target and preserves exact query cursor scope',
      'Accessible-name search is literal/case-sensitive and does not enter an iframe',
      'A replacement matching the same query never inherits the old action reference',
    ];
  } finally { await page.evaluate(() => { document.querySelector('#query-fixture')?.remove(); delete window.queryClicks; }); }
}
