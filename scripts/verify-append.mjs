import assert from 'node:assert/strict';

export async function verifyAppend({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const root = document.createElement('section'); root.id = 'append-fixture';
    root.style.cssText = 'position:fixed;top:30px;left:300px;width:500px;padding:16px;background:white;z-index:999999';
    root.innerHTML = `<input id="append-input" aria-label="追加输入" value="已有前缀">
      <textarea id="append-area" aria-label="追加多行">第一行\n第二行</textarea>
      <div id="append-rich" role="textbox" aria-label="追加富文本" contenteditable="true"><b>保留格式</b></div>
      <div id="append-plain" aria-label="追加纯文本" contenteditable="plaintext-only">已有内容</div>
      <input id="append-limit" aria-label="长度受限" maxlength="3" value="ab">
      <input id="append-email" aria-label="不支持选区" type="email" value="test@example.test">
      <div id="append-protected" role="textbox" aria-label="追加保护编辑" contenteditable="true"><span contenteditable="false">不可改</span></div>
      <input id="append-race" aria-label="追加竞态" value="原始内容">
      <div id="append-shadow-host"></div>`;
    for (const element of root.children) element.style.cssText = 'display:block;min-height:28px;margin:4px;border:1px solid black;white-space:pre-wrap';
    root.querySelector('#append-shadow-host').attachShadow({mode:'open'}).innerHTML =
      '<div id="append-shadow" role="textbox" aria-label="追加阴影" contenteditable="true">阴影前缀</div>';
    document.body.append(root); window.appendEvents = []; window.appendBoldRef = document.querySelector('#append-rich b');
    root.addEventListener('beforeinput', e => window.appendEvents.push({type:e.type,id:e.target.id,data:e.data,trusted:e.isTrusted}));
    root.addEventListener('input', e => window.appendEvents.push({type:e.type,id:e.target.id,data:e.data,trusted:e.isTrusted}));
  });
  try {
    let o = await observe();
    const node = name => {const n=o.nodes.find(n=>n.name===name);assert.ok(n,`Missing append field ${name}`);return n;};
    const append = (name, text) => ({kind:'append',ref:node(name).id,text});
    const events = () => page.evaluate(()=>window.appendEvents);
    await page.locator('#append-input').evaluate(e=>{e.focus();e.setSelectionRange(0,2);});
    const action=append('追加输入',' + 中文🙂'), first=await act('append-input',action);
    assert.equal(first.outcome,'succeeded',JSON.stringify(first));
    assert.equal(await page.locator('#append-input').inputValue(),'已有前缀 + 中文🙂');
    const sent=await events();assert.deepEqual(sent.map(e=>[e.type,e.data,e.trusted]),[['beforeinput',action.text,true],['input',action.text,true]]);
    assert.deepEqual(await act('append-input',action),first);assert.deepEqual(await events(),sent);
    const noop=await act('append-noop',append('追加输入',''));assert.equal(noop.outcome,'succeeded');assert.equal(noop.dispatch,'notDispatched');assert.deepEqual(await events(),sent);
    const area=await act('append-area',append('追加多行','\n第三行'));assert.equal(area.outcome,'succeeded');
    assert.equal(await page.locator('#append-area').inputValue(),'第一行\n第二行\n第三行');
    assert.equal((await act('append-rich',append('追加富文本','，追加🙂'))).outcome,'succeeded');
    assert.equal(await page.locator('#append-rich').innerText(),'保留格式，追加🙂');
    assert.equal(await page.evaluate(()=>document.querySelector('#append-rich b')===window.appendBoldRef),true);
    assert.equal((await act('append-shadow',append('追加阴影',' + end'))).outcome,'succeeded');
    assert.equal(await page.locator('#append-shadow').innerText(),'阴影前缀 + end');
    for(const [i, prefix] of ['前缀\n','\n\n','','A\n\nB'].entries()) {
      assert.equal((await act(`append-prepare-${i}`,{kind:'fill',ref:node('追加纯文本').id,text:prefix})).outcome,'succeeded');
      const result=await act(`append-plain-${i}`,append('追加纯文本','追加'),{timeoutMs:1200});
      assert.equal(result.outcome,'succeeded',JSON.stringify({prefix,result}));
    }
    const refusedBefore=await events();
    for(const [name,text,code] of [['长度受限','too long','NOT_ACTIONABLE'],['不支持选区','suffix','UNSUPPORTED_CAPABILITY'],['追加保护编辑','suffix','UNSUPPORTED_CAPABILITY'],['追加输入','\nline','UNSUPPORTED_CAPABILITY']]) {
      const denied=await act(`append-refuse-${name}`,append(name,text));assert.equal(denied.code,code);assert.equal(denied.dispatch,'notDispatched');
    }
    assert.deepEqual(await events(),refusedBefore);
    assert.equal(await page.locator('#append-limit').inputValue(),'ab');
    // Real page focus handlers can update a controlled value without replacing its identity.
    await page.locator('#append-race').evaluate(e=>{document.querySelector('#append-input').focus();e.addEventListener('focus',()=>{e.value='页面刚刚更新';},{once:true});});
    const changed=await act('append-value-race',append('追加竞态','不能覆盖'));
    assert.equal(changed.code,'STALE_TARGET');assert.equal(changed.outcome,'unknown');
    assert.equal(await page.locator('#append-race').inputValue(),'页面刚刚更新');
    assert.deepEqual(await events(),refusedBefore);
    // Collapse to the WRONG end after the selection operation, keeping the same focus.
    await page.locator('#append-race').evaluate(e=>{
      const original=e.setSelectionRange.bind(e);
      e.setSelectionRange=(...args)=>{original(...args);original(0,0);delete e.setSelectionRange;};
    });
    const caret=await act('append-caret-race',append('追加竞态','不能插前面'));
    assert.equal(caret.code,'NOT_ACTIONABLE');assert.equal(caret.outcome,'unknown');
    assert.deepEqual(await events(),refusedBefore);
    await page.locator('#append-race').evaluate(e=>e.addEventListener('beforeinput',e=>e.preventDefault(),{once:true}));
    const preventedAction=append('追加竞态','阻止追加');
    const prevented=await act('append-prevented',preventedAction,{timeoutMs:650});
    assert.equal(prevented.outcome,'unknown');assert.equal(prevented.code,'DEADLINE_EXCEEDED');
    assert.deepEqual(await act('append-prevented',preventedAction,{timeoutMs:650}),prevented);
    assert.equal((await events()).filter(e=>e.id==='append-race').length,1);
    const stale=append('追加多行','不应写入替身');await page.locator('#append-area').evaluate(e=>e.replaceWith(e.cloneNode(true)));
    assert.equal((await act('append-stale',stale)).code,'STALE_TARGET');
    o=await observe();assert.notEqual(node('追加多行').id,stale.ref);
    assert.ok((await events()).every(e=>e.trusted));
    return [
      'Append moves to the native end caret, sends only the suffix as trusted input, deduplicates and no-ops on empty suffix',
      'Textarea, formatted contenteditable, generic plaintext-only and open-shadow hosts preserve the existing prefix while appending',
      'Editor append handles empty content, trailing newlines and consecutive blank lines without refilling the prefix',
      'Maxlength, unsupported native selection types, protected editors and single-line newlines fail without input',
      'Changed text during focus and a moved end caret block append without overwriting current page content',
      'Cancelled beforeinput and replaced fields do not receive repeated or rebound append input',
    ];
  } finally {await page.evaluate(()=>{document.getElementById('append-fixture')?.remove();delete window.appendEvents;delete window.appendBoldRef;});}
}
