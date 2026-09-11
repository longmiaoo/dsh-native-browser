import assert from 'node:assert/strict';

export async function verifyCheckLabels({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const root=document.createElement('section'); root.id='check-label-fixture';
    root.style.cssText='position:fixed;top:80px;left:300px;width:460px;padding:20px;background:white;z-index:99999';
    root.innerHTML=`<input id="label-explicit" aria-label="透明复选框" type="checkbox" style="opacity:0;width:24px;height:24px">
      <label id="label-surface" for="label-explicit" style="display:block;padding:12px">可见标签 <button id="label-nested">独立按钮</button></label>
      <label id="label-wrapper" style="display:block;padding:12px"><input id="label-wrapped" type="checkbox" style="opacity:0;width:24px;height:24px">包裹式复选框</label>
      <fieldset disabled><input id="label-disabled" aria-label="禁用复选框" type="checkbox" style="opacity:0;width:24px;height:24px"></fieldset>
      <label id="label-disabled-surface" for="label-disabled" style="display:block;padding:12px">外部标签</label>
      <div aria-disabled="true"><input id="label-aria-disabled" aria-label="语义禁用复选框" type="checkbox" style="opacity:0;width:24px;height:24px"></div>
      <label id="label-aria-surface" for="label-aria-disabled" style="display:block;padding:12px">语义外部标签</label>
      <div id="label-scroll" style="height:70px;overflow:auto"><div style="height:260px"></div>
        <label id="label-offscreen-surface" style="display:block;padding:12px"><input id="label-offscreen" type="checkbox" style="opacity:0;width:24px;height:24px">滚动复选框</label>
        <div style="height:160px"></div><input id="label-input-fallback" aria-label="滚动原始输入" type="checkbox" style="width:24px;height:24px">
        <label for="label-input-fallback" style="display:none">隐藏标签</label></div>`;
    document.body.append(root); window.checkLabelEvents=[];
    root.addEventListener('click',e=>window.checkLabelEvents.push({id:e.target.id,trusted:e.isTrusted}));
  });
  try {
    const o=await observe();
    const ref=name=>{const n=o.nodes.find(n=>n.role==='checkbox'&&n.name===name);assert.ok(n,`Missing ${name}`);return n.id;};
    const action={kind:'check',ref:ref('透明复选框'),checked:true};
    const first=await act('label-explicit-on',action); assert.equal(first.outcome,'succeeded');
    assert.equal(await page.locator('#label-explicit').isChecked(),true);
    assert.deepEqual(await act('label-explicit-on',action),first);
    const noop=await act('label-explicit-noop',action); assert.equal(noop.outcome,'succeeded'); assert.equal(noop.dispatch,'notDispatched');
    let events=await page.evaluate(()=>window.checkLabelEvents);
    assert.equal(events.filter(e=>e.id==='label-surface').length,1);
    assert.equal(events.filter(e=>e.id==='label-explicit').length,1);
    assert.equal(events.filter(e=>e.id==='label-nested').length,0);
    assert.equal((await act('label-explicit-off',{...action,checked:false})).outcome,'succeeded');
    assert.equal(await page.locator('#label-explicit').isChecked(),false);
    assert.equal((await act('label-wrapped-on',{kind:'check',ref:ref('包裹式复选框'),checked:true})).outcome,'succeeded');
    assert.equal(await page.locator('#label-wrapped').isChecked(),true);
    events=await page.evaluate(()=>window.checkLabelEvents);
    for (const name of ['禁用复选框','语义禁用复选框']) {
      const denied=await act(`label-disabled-${name}`,{kind:'check',ref:ref(name),checked:true},{timeoutMs:500});
      assert.equal(denied.code,'DEADLINE_EXCEEDED'); assert.equal(denied.dispatch,'notDispatched');
    }
    assert.deepEqual(await page.evaluate(()=>window.checkLabelEvents),events);
    assert.equal((await act('label-offscreen-on',{kind:'check',ref:ref('滚动复选框'),checked:true})).outcome,'succeeded');
    assert.equal(await page.locator('#label-offscreen').isChecked(),true);
    assert.ok(await page.locator('#label-scroll').evaluate(e=>e.scrollTop>0));
    assert.equal((await act('label-hidden-fallback',{kind:'check',ref:ref('滚动原始输入'),checked:true})).outcome,'succeeded');
    assert.equal(await page.locator('#label-input-fallback').isChecked(),true);
    assert.ok((await page.evaluate(()=>window.checkLabelEvents)).every(e=>e.trusted));
    // Trigger a reassociation during label geometry, while the input's explicit
    // aria-label preserves its AX name. A matching AX name alone is insufficient.
    await page.locator('#label-surface').evaluate(label=>{
      const rects=label.getClientRects.bind(label);
      label.getClientRects=()=>{label.htmlFor='label-wrapped';return rects();};
    });
    const before=await page.evaluate(()=>window.checkLabelEvents);
    const stale=await act('label-reassociated',action);
    assert.equal(stale.code,'STALE_TARGET'); assert.equal(stale.dispatch,'notDispatched');
    assert.deepEqual(await page.evaluate(()=>window.checkLabelEvents),before);
    return ['Transparent native input uses its explicit label with trusted activation, no-op and deduplication',
      'Wrapped checkbox label toggles the input without clicking nested independent controls',
      'External labels do not bypass native fieldset or aria-disabled input ancestry',
      'Offscreen associated label scrolls into view before verified checkbox input',
      'Hidden label does not displace a usable offscreen native input',
      'Label reassociation with unchanged input AX identity aborts before mouse dispatch'];
  } finally {await page.evaluate(()=>{document.getElementById('check-label-fixture')?.remove();delete window.checkLabelEvents;});}
}
