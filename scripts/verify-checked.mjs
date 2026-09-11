import assert from 'node:assert/strict';

export async function verifyChecked({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const root = document.createElement('section'); root.id = 'checked-fixture';
    root.style.cssText = 'position:fixed;top:100px;left:300px;width:460px;padding:20px;background:white;z-index:99999';
    root.innerHTML = '<label style="display:block;padding:10px"><input id="fixture-check" type="checkbox" style="width:24px;height:24px">状态复选框</label><button id="fixture-switch" role="switch" aria-checked="false">状态开关</button><label style="display:block;padding:10px"><input id="fixture-prevent" type="checkbox" style="width:24px;height:24px">阻止切换</label>';
    document.body.append(root); window.checkedEvents = [];
    root.addEventListener('click', e => window.checkedEvents.push({id:e.target.id,trusted:e.isTrusted}));
    document.getElementById('fixture-switch').addEventListener('click', e => setTimeout(() => e.target.setAttribute('aria-checked', e.target.getAttribute('aria-checked') === 'true' ? 'false' : 'true'), 100));
    document.getElementById('fixture-prevent').addEventListener('click', e => e.preventDefault());
  });
  try {
    const o = await observe();
    const check = o.nodes.find(n=>n.name==='状态复选框'&&n.role==='checkbox');
    const toggle = o.nodes.find(n=>n.name==='状态开关'&&n.role==='switch');
    const prevented = o.nodes.find(n=>n.name==='阻止切换'); assert.ok(check); assert.ok(toggle); assert.ok(prevented);
    assert.equal(check.checked,false); assert.equal(toggle.checked,false);
    const action = {kind:'check',ref:check.id,checked:true};
    const first = await act('checked-on',action); assert.equal(first.outcome,'succeeded');
    assert.equal(await page.locator('#fixture-check').isChecked(),true);
    assert.deepEqual(await act('checked-on',action),first);
    const noop = await act('checked-noop',action);
    assert.equal(noop.outcome,'succeeded'); assert.equal(noop.dispatch,'notDispatched');
    assert.equal((await page.evaluate(()=>window.checkedEvents)).length,1);
    assert.equal((await act('checked-off',{...action,checked:false})).outcome,'succeeded');
    assert.equal(await page.locator('#fixture-check').isChecked(),false);
    assert.equal((await act('checked-switch',{kind:'check',ref:toggle.id,checked:true})).outcome,'succeeded');
    assert.equal(await page.locator('#fixture-switch').getAttribute('aria-checked'),'true');
    const refused = await act('checked-refused',{kind:'check',ref:prevented.id,checked:true},{timeoutMs:700});
    assert.equal(refused.outcome,'unknown'); assert.equal(refused.code,'DEADLINE_EXCEEDED');
    const events = await page.evaluate(()=>window.checkedEvents);
    assert.equal(events.filter(e=>e.id==='fixture-prevent').length,1); assert.ok(events.every(e=>e.trusted));
    await page.locator('#fixture-check').evaluate(e=>e.replaceWith(e.cloneNode(true)));
    const stale = await act('checked-replaced',action); assert.equal(stale.code,'STALE_TARGET');
    assert.equal((await page.evaluate(()=>window.checkedEvents)).length,events.length);
    return ['Check sets native checkbox state with trusted input and deduplicates the request',
      'Already-desired checked state succeeds without another click',
      'Check clears a checkbox and waits for a delayed custom switch state',
      'Prevented checkbox toggle remains unknown without repeated clicks',
      'A replaced checkbox never inherits its old checked-action reference'];
  } finally { await page.evaluate(()=>{document.getElementById('checked-fixture')?.remove();delete window.checkedEvents;}); }
}
