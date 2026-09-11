import assert from 'node:assert/strict';

export async function verifyActionability({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const zone = document.createElement('div'); zone.id = 'hit-fixture';
    zone.style.cssText = 'position:fixed;right:20px;top:20px;width:320px;z-index:10;background:white';
    zone.innerHTML = `<div style="position:relative;height:60px">
      <button id="hit-partial" style="margin:0;width:300px;height:60px"><span>局部遮挡按钮</span></button>
      <div id="hit-overlay" style="position:absolute;left:100px;top:0;width:100px;height:60px;background:#999">遮挡</div></div>
      <div style="width:280px;line-height:70px"><a id="hit-wrap" href="#hit-wrap" style="font-size:16px">换行链接一二三四五六七八九十一二三四五六七八九十</a></div>
      <div style="width:25px;height:45px;overflow:hidden"><button id="hit-clipped" style="margin:0;width:280px;height:45px">裁剪按钮</button></div>
      <div id="hit-shadow-host"></div>
      <div id="hit-parent" role="button" aria-label="外层控件" style="position:relative;width:300px;height:50px">
        <button id="hit-child" style="position:absolute;inset:0;margin:0;width:100%;height:100%">内层控件</button></div>
      <p id="hit-status" role="status">等待点击</p>`;
    document.body.append(zone);
    const shadow = zone.querySelector('#hit-shadow-host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="hit-shadow" style="width:280px;height:40px"><span>Shadow 按钮</span></button>';
    window.hitEvents = [];
    for (const id of ['hit-partial', 'hit-wrap', 'hit-clipped', 'hit-parent', 'hit-child', 'hit-overlay', 'hit-shadow']) {
      const element = zone.querySelector('#' + id) ?? shadow.querySelector('#' + id);
      element.addEventListener('click', event => {
        event.preventDefault(); window.hitEvents.push({ id, trusted: event.isTrusted, x: event.clientX, y: event.clientY });
        zone.querySelector('#hit-status').textContent = '命中 ' + id;
      });
    }
  });
  try {
    const o = await observe();
    const ref = name => { const node = o.nodes.find(n => n.name === name); assert.ok(node, name); return node.id; };
    for (const [id, name] of [['hit-partial', '局部遮挡按钮'], ['hit-wrap', '换行链接一二三四五六七八九十一二三四五六七八九十'],
      ['hit-clipped', '裁剪按钮'], ['hit-shadow', 'Shadow 按钮']]) {
      if (id !== 'hit-shadow') assert.equal(await page.locator('#' + id).evaluate(element => {
        const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === element || element.contains(hit);
      }), false, `${id} must reproduce a center-only miss`);
      const result = await act(id, { kind: 'click', ref: ref(name), expected: { kind: 'text', text: '命中 ' + id } });
      assert.equal(result.outcome, 'succeeded', `${id}: ${JSON.stringify(result)}`);
    }
    const noParent = await act('hit-nested-refused', { kind: 'click', ref: ref('外层控件') }, { timeoutMs: 180 });
    assert.equal(noParent.dispatch, 'notDispatched'); assert.equal(noParent.code, 'DEADLINE_EXCEEDED');
    const events = await page.evaluate(() => window.hitEvents);
    assert.deepEqual(events.map(e => e.id), ['hit-partial', 'hit-wrap', 'hit-clipped', 'hit-shadow']);
    assert.ok(events.every(e => e.trusted));
    return ['Partial overlay does not block a verified exposed click point', 'Multiline link uses a real fragment rather than its empty bounding-box center',
      'Overflow-clipped button uses only its visible portion', 'Open-shadow button receives real trusted input',
      'Nested independent control is never clicked on behalf of its parent'];
  } finally { await page.locator('#hit-fixture').evaluate(element => element.remove()); }
}
