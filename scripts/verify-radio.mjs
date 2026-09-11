import assert from 'node:assert/strict';

/** Real native controls; setup and fault injection affect only our loopback fixture. */
export async function verifyRadio({page,observe,act}) {
  assert.equal(new URL(page.url()).hostname,'127.0.0.1');
  await page.evaluate(()=>{
    const root=document.createElement('section'); root.id='radio-fixture';
    root.style.cssText='position:fixed;top:60px;left:280px;width:500px;padding:16px;background:white;z-index:99999';
    root.innerHTML=`<form id="radio-form-a">
      <label><input id="radio-a" type="radio" name="plan" value="a" checked>单选甲</label>
      <label><input id="radio-b" type="radio" name="plan" value="b">单选乙</label>
      <input id="radio-label" type="radio" name="plan" value="label" aria-label="透明单选" style="opacity:0">
      <label id="radio-label-surface" for="radio-label">可见单选标签</label>
      <label><input id="radio-prevent" type="radio" name="plan" value="prevent">阻止单选</label>
      </form>
      <form id="radio-form-b"><label><input id="radio-other-form" type="radio" name="plan" checked>其他表单</label></form>
      <fieldset disabled><input id="radio-disabled" type="radio" aria-label="禁用单选" style="opacity:0"></fieldset>
      <label id="radio-disabled-label" for="radio-disabled">禁用单选外部标签</label>
      <button id="radio-custom" role="radio" aria-checked="false">自定义单选</button>
      <label><input id="radio-unnamed-a" type="radio" checked>无名单选甲</label>
      <label><input id="radio-unnamed-b" type="radio">无名单选乙</label>
      <input id="radio-mutate" type="radio" name="stable" value="stable" aria-label="变更组单选">
      <input id="radio-post" type="radio" name="post" aria-label="点击后变更组">`;
    for(const input of root.querySelectorAll('input')) {input.style.width='24px';input.style.height='24px';}
    for(const label of root.querySelectorAll('label')) label.style.cssText='display:inline-block;padding:8px';
    document.body.append(root);window.radioEvents=[];
    for(const type of ['click','input','change']) root.addEventListener(type,e=>window.radioEvents.push({type,id:e.target.id,trusted:e.isTrusted}));
    document.getElementById('radio-prevent').addEventListener('click',e=>e.preventDefault());
    document.getElementById('radio-post').addEventListener('click',e=>{e.target.name='changed-after-click';});
  });
  try {
    let o=await observe();
    const node=name=>{const n=o.nodes.find(n=>n.role==='radio'&&n.name===name);assert.ok(n,`Missing radio ${name}`);return n;};
    const choose=name=>({kind:'check',ref:node(name).id,checked:true});
    assert.equal(node('单选甲').checked,true); assert.equal(node('单选乙').checked,false);
    const action=choose('单选乙'), first=await act('radio-select',action);
    assert.equal(first.outcome,'succeeded');
    assert.equal(await page.locator('#radio-a').isChecked(),false); assert.equal(await page.locator('#radio-b').isChecked(),true);
    assert.equal(await page.locator('#radio-other-form').isChecked(),true);
    assert.deepEqual(await act('radio-select',action),first);
    const noop=await act('radio-noop',action); assert.equal(noop.outcome,'succeeded'); assert.equal(noop.dispatch,'notDispatched');
    let events=await page.evaluate(()=>window.radioEvents);
    assert.deepEqual(events.filter(e=>e.id==='radio-b').map(e=>e.type),['click','input','change']);
    for(const name of ['单选甲','单选乙']) {
      const denied=await act(`radio-uncheck-${name}`,{...choose(name),checked:false});
      assert.equal(denied.code,'UNSUPPORTED_CAPABILITY'); assert.equal(denied.dispatch,'notDispatched');
    }
    assert.deepEqual(await page.evaluate(()=>window.radioEvents),events);
    assert.equal((await act('radio-label',choose('透明单选'))).outcome,'succeeded');
    assert.equal(await page.locator('#radio-label').isChecked(),true); assert.equal(await page.locator('#radio-b').isChecked(),false);
    assert.equal((await act('radio-unnamed',choose('无名单选乙'))).outcome,'succeeded');
    assert.equal(await page.locator('#radio-unnamed-a').isChecked(),true); assert.equal(await page.locator('#radio-unnamed-b').isChecked(),true);
    const prevented=await act('radio-prevent',choose('阻止单选'),{timeoutMs:650});
    assert.equal(prevented.outcome,'unknown');assert.equal(prevented.code,'DEADLINE_EXCEEDED');
    assert.equal(await page.locator('#radio-label').isChecked(),true);assert.equal(await page.locator('#radio-prevent').isChecked(),false);
    events=await page.evaluate(()=>window.radioEvents);
    assert.equal(events.filter(e=>e.type==='click'&&e.id==='radio-prevent').length,1);
    const custom=await act('radio-custom',choose('自定义单选'));
    assert.equal(custom.code,'UNSUPPORTED_CAPABILITY');assert.equal(custom.dispatch,'notDispatched');
    const disabled=await act('radio-disabled',choose('禁用单选'),{timeoutMs:450});
    assert.equal(disabled.code,'DEADLINE_EXCEEDED');assert.equal(disabled.dispatch,'notDispatched');
    assert.deepEqual(await page.evaluate(()=>window.radioEvents),events);
    // Deterministic page-side race during geometry, after action binding capture.
    // AX name and backend node stay identical; the changed group/value must not.
    for(const field of ['name','form','value']) {
      await page.locator('#radio-mutate').evaluate((input,field)=>{
        const rects=input.getClientRects.bind(input);
        input.getClientRects=()=>{
          if(field==='form') input.setAttribute('form','radio-form-b'); else input[field]='changed';
          delete input.getClientRects; return rects();
        };
      },field);
      const stale=await act(`radio-mutate-${field}`,choose('变更组单选'));
      assert.equal(stale.code,'STALE_TARGET');assert.equal(stale.dispatch,'notDispatched');
      assert.equal(await page.locator('#radio-mutate').isChecked(),false);
    }
    assert.deepEqual(await page.evaluate(()=>window.radioEvents),events);
    const post=await act('radio-post',choose('点击后变更组'));
    assert.equal(post.outcome,'unknown');assert.equal(post.code,'STALE_TARGET');assert.equal(post.dispatch,'dispatched');
    assert.equal(await page.locator('#radio-post').isChecked(),true);
    const old=choose('单选甲');await page.locator('#radio-a').evaluate(e=>e.replaceWith(e.cloneNode(true)));
    assert.equal((await act('radio-replaced',old)).code,'STALE_TARGET');
    assert.ok((await page.evaluate(()=>window.radioEvents)).every(e=>e.trusted));
    o=await observe(); assert.notEqual(node('单选甲').id,old.ref);
    return [
      'Native radio selection produces trusted click/input/change, group exclusivity and cross-form isolation',
      'Radio selection deduplicates and no-ops without another click; false is refused even when already false',
      'Transparent radio uses its exact associated label and verifies the native selected state',
      'Nameless native radios remain independent rather than being grouped by an inferred selector',
      'Prevented radio activation stays unknown without retries and preserves the previous selection',
      'Unsupported custom radio and disabled native radio receive no input, including external labels',
      'Radio name/form/value changes with stable AX identity abort before input; replaced refs stay stale',
      'A radio group changed by a click handler yields unknown rather than verified success',
    ];
  } finally {await page.evaluate(()=>{document.getElementById('radio-fixture')?.remove();delete window.radioEvents;});}
}
