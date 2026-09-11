import assert from 'node:assert/strict';

/** Actual browser input through the caller's production action path. Only fixture
 * setup and explicit page-race injection use Playwright evaluation. */
export async function verifyEditable({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const root = document.createElement('section'); root.id = 'editable-fixture';
    root.style.cssText = 'position:fixed;top:20px;left:300px;width:500px;padding:12px;background:white;z-index:999999';
    root.innerHTML = `<div id="editor-rich" role="textbox" aria-label="富文本编辑" contenteditable="true"><b>旧的</b><i>内容</i></div>
      <div id="editor-plain" role="textbox" aria-label="纯文本编辑" contenteditable="plaintext-only">旧内容</div>
      <div id="editor-protected" role="textbox" aria-label="受保护编辑" contenteditable="true">旧内容<span contenteditable="false">不可删除</span></div>
      <div id="editor-readonly" role="textbox" aria-label="只读编辑" contenteditable="true" aria-readonly="true">不可编辑</div>
      <div id="editor-prevent" role="textbox" aria-label="阻止编辑" contenteditable="true">保留</div>
      <div id="editor-race" role="textbox" aria-label="选区变更编辑" contenteditable="true">保留选区</div>
      <div id="editor-generic" aria-label="无角色编辑" contenteditable="true" style="min-height:32px;white-space:pre-wrap">旧内容</div>
      <input id="editor-other" aria-label="其他输入" value="不应改变"><div id="editor-shadow-host"></div>`;
    for (const editor of root.querySelectorAll('[role=textbox]')) editor.style.cssText = 'min-height:32px;border:1px solid black;white-space:pre-wrap;margin:5px';
    document.body.append(root); window.editorEvents = [];
    root.querySelector('#editor-shadow-host').attachShadow({ mode: 'open' }).innerHTML =
      '<div id="editor-shadow" role="textbox" aria-label="阴影编辑" contenteditable="true" style="min-height:32px;border:1px solid black;white-space:pre-wrap">旧内容</div>';
    for (const type of ['beforeinput', 'input', 'keydown', 'keyup']) root.addEventListener(type, e => window.editorEvents.push({
      type, id: e.target.id, trusted: e.isTrusted, inputType: e.inputType, data: e.data,
    }));
    document.getElementById('editor-prevent').addEventListener('beforeinput', e => e.preventDefault());
  });
  try {
    let o = await observe();
    const node = name => { const n = o.nodes.find(n => (n.role === 'textbox' || n.editable === true) && n.name === name); assert.ok(n, `Missing editor ${name}`); return n; };
    const fill = (name, text) => ({ kind: 'fill', ref: node(name).id, text });
    const events = () => page.evaluate(() => window.editorEvents);
    const replacement = '中文输入 🙂\n第二行';
    const richAction = fill('富文本编辑', replacement), rich = await act('editor-rich', richAction);
    assert.equal(rich.outcome, 'succeeded', JSON.stringify(rich));
    assert.equal(await page.locator('#editor-rich').innerText(), replacement);
    const richEvents = await events();
    assert.ok(richEvents.some(e => e.id === 'editor-rich' && e.type === 'input'));
    assert.ok(richEvents.every(e => e.trusted));
    assert.deepEqual(await act('editor-rich', richAction), rich);
    assert.deepEqual(await events(), richEvents, 'Deduplication must not edit twice');
    const plain = fill('纯文本编辑', '纯文本\n第二行🙂');
    assert.equal((await act('editor-plain', { ...plain, expected: { kind: 'value', value: plain.text } })).outcome, 'succeeded');
    assert.equal(await page.locator('#editor-plain').innerText(), plain.text);
    for (const [name, id] of [['纯文本编辑', 'editor-plain'], ['富文本编辑', 'editor-rich']])
      for (const [i, text] of ['\n', '尾部换行\n', '\n\n', 'A\n\nB', '  前后空格  '].entries()) {
      const result = await act(`editor-whitespace-${id}-${i}`, fill(name, text), { timeoutMs: 800 });
      assert.equal(result.outcome, 'succeeded', JSON.stringify({ text, result }));
      // Independent browser copy-text oracle, not the production DOM serializer.
      const copied = await page.locator(`#${id}`).evaluate(element => {
        const selection = getSelection(), saved = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        const range = document.createRange(); range.selectNodeContents(element);
        selection.removeAllRanges(); selection.addRange(range); const text = selection.toString();
        selection.removeAllRanges(); if (saved) selection.addRange(saved); return text;
      });
      assert.equal(copied, text);
    }
    const shadow = await act('editor-shadow', fill('阴影编辑', '影子编辑🙂\n第二行'));
    assert.equal(shadow.outcome, 'succeeded', JSON.stringify(shadow));
    assert.equal(await page.locator('#editor-shadow').innerText(), '影子编辑🙂\n第二行');
    assert.equal(node('无角色编辑').role, 'generic');
    const generic = fill('无角色编辑', '无需额外ARIA角色');
    assert.equal((await act('editor-generic', generic)).outcome, 'succeeded');
    assert.equal(await page.locator('#editor-generic').innerText(), generic.text);
    const found = await observe({ query: { name: '无角色编辑', role: 'generic' } });
    assert.equal(found.nodes.find(n => n.editable)?.id, generic.ref);
    assert.equal((await act('editor-generic-left', { kind: 'press', ref: generic.ref, key: 'ArrowLeft' })).outcome, 'unknown');
    assert.equal((await act('editor-empty', fill('富文本编辑', ''))).outcome, 'succeeded');
    assert.equal(await page.locator('#editor-rich').textContent(), '');
    assert.ok((await events()).some(e => e.id === 'editor-rich' && e.type === 'input' && e.inputType.startsWith('delete')));
    const beforeRefusals = await events();
    for (const name of ['受保护编辑', '只读编辑']) {
      const denied = await act(`editor-refuse-${name}`, fill(name, '必须拒绝'));
      assert.equal(denied.code, 'UNSUPPORTED_CAPABILITY'); assert.equal(denied.dispatch, 'notDispatched');
    }
    assert.deepEqual(await events(), beforeRefusals);
    assert.equal(await page.locator('#editor-protected').innerText(), '旧内容不可删除');
    // Bounded inspection refuses oversized and deeply populated hosts before focus.
    for (const [i, html] of ['<span></span>'.repeat(4097), 'x'.repeat(100001)].entries()) {
      await page.locator('#editor-protected').evaluate((e, html) => { e.innerHTML = html; }, html);
      const bounded = await act(`editor-bound-${i}`, fill('受保护编辑', '不应替换'));
      assert.equal(bounded.code, 'UNSUPPORTED_CAPABILITY'); assert.equal(bounded.dispatch, 'notDispatched');
    }
    await page.locator('#editor-protected').evaluate(e => { e.innerHTML = '旧内容<span contenteditable="false">不可删除</span>'; });
    assert.deepEqual(await events(), beforeRefusals);
    const preventedAction = fill('阻止编辑', '不应重试');
    const prevented = await act('editor-prevent', preventedAction, { timeoutMs: 600 });
    assert.equal(prevented.outcome, 'unknown'); assert.equal(prevented.code, 'DEADLINE_EXCEEDED');
    assert.equal(await page.locator('#editor-prevent').innerText(), '保留');
    assert.deepEqual(await act('editor-prevent', preventedAction, { timeoutMs: 600 }), prevented);
    assert.equal((await events()).filter(e => e.id === 'editor-prevent' && e.type === 'beforeinput').length, 1);

    // A real focus listener steals focus before the selection/insertion stage.
    await page.locator('#editor-race').evaluate(element => {
      document.getElementById('editor-other').focus();
      element.addEventListener('focus', () => document.getElementById('editor-other').focus(), { once: true });
    });
    const lostFocus = await act('editor-focus-stolen', fill('选区变更编辑', '禁止误输入'));
    assert.equal(lostFocus.outcome, 'unknown'); assert.equal(lostFocus.code, 'NOT_ACTIONABLE');
    assert.equal(await page.locator('#editor-other').inputValue(), '不应改变');
    // Page-side selectionchange collapses the full selection without moving focus.
    await page.evaluate(() => {
      const editor = document.getElementById('editor-race');
      window.editorSelectionGuard = () => {
        const selection = document.getSelection();
        if (document.activeElement === editor && selection?.rangeCount && !selection.isCollapsed)
          selection.collapse(editor, 0);
      };
      document.addEventListener('selectionchange', window.editorSelectionGuard);
    });
    const beforeSelection = await events();
    const lostSelection = await act('editor-selection-stolen', fill('选区变更编辑', '禁止部分替换'));
    assert.equal(lostSelection.code, 'NOT_ACTIONABLE'); assert.equal(lostSelection.outcome, 'unknown');
    assert.equal(await page.locator('#editor-race').innerText(), '保留选区');
    assert.deepEqual(await events(), beforeSelection);
    await page.evaluate(() => document.removeEventListener('selectionchange', window.editorSelectionGuard));
    const staleAction = fill('纯文本编辑', '不应写入替身');
    await page.locator('#editor-plain').evaluate(e => e.replaceWith(e.cloneNode(true)));
    assert.equal((await act('editor-replaced', staleAction)).code, 'STALE_TARGET');
    o = await observe(); assert.notEqual(node('纯文本编辑').id, staleAction.ref);
    assert.ok((await events()).every(e => e.trusted));
    return [
      'Rich contenteditable replacement inserts Chinese, emoji and multiline text with trusted browser input and no replay',
      'Plaintext-only editing host verifies exact full value including line breaks',
      'Editor verification preserves leading/trailing spaces and newlines; bounded inspection refuses oversized hosts',
      'An open-shadow editing host uses its own focus and full-content selection without targeting the shadow host',
      'Generic contenteditable hosts without ARIA textbox roles remain discoverable/searchable and accept verified fill and page keys',
      'Contenteditable clearing uses trusted deletion and verifies empty rendered content',
      'Read-only and protected-subtree editors receive no input and retain their content',
      'Prevented beforeinput stays unknown without another insertion or replay',
      'Stolen focus and collapsed selection block editor input without modifying another field',
      'Replaced editing hosts cannot inherit an observed ref',
    ];
  } finally {
    await page.evaluate(() => {
      document.removeEventListener('selectionchange', window.editorSelectionGuard);
      document.getElementById('editable-fixture')?.remove(); delete window.editorSelectionGuard; delete window.editorEvents;
    });
  }
}
