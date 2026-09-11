import assert from 'node:assert/strict';

/** Local fixture only; reusable through direct CDP and real DSH/native transport. */
export async function verifyElementState({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  await page.evaluate(() => {
    const root = document.createElement('section'); root.id = 'state-fixture';
    root.innerHTML = `<button id="state-trigger">状态触发</button><button id="state-target">状态目标</button>
      <input id="state-input" aria-label="状态输入"><input id="state-check" type="checkbox" aria-label="状态复选">
      <div id="state-aria" role="checkbox" aria-label="状态自定义复选" aria-checked="true" tabindex="0">ARIA</div>
      <fieldset id="state-fieldset" disabled><button id="state-inherited">状态继承禁用</button></fieldset>
      <section id="state-region" aria-label="状态区域">Region</section><div id="state-shadow"></div>
      <input id="state-append" aria-label="状态追加" value="prefix">
      <div id="state-editor" role="textbox" aria-label="状态编辑" contenteditable="true">old</div>
      <section id="state-scroll" aria-label="状态滚动"><div style="height:500px;width:500px">Scroll</div></section>
      <section id="state-wheel" aria-label="状态滚轮">Wheel</section>`;
    for (const e of root.children) e.style.cssText = 'display:block;min-height:24px;margin:4px';
    root.querySelector('#state-shadow').attachShadow({ mode: 'open' }).innerHTML = '<input id="state-shadow-check" type="checkbox" aria-label="状态阴影复选">';
    document.body.prepend(root);
    window.stateFixture = { mode: '', events: [], completed: false, timers: [] };
    root.querySelector('#state-scroll').style.cssText = 'height:60px;width:200px;overflow:auto';
    const delayedEnable = e => {
      const f = window.stateFixture; f.events.push({ type: e.type, trusted: e.isTrusted });
      f.timers.push(setTimeout(() => { document.querySelector('#state-target').disabled = false; }, 90));
    };
    for (const id of ['state-append', 'state-editor']) root.querySelector('#' + id).addEventListener('input', delayedEnable);
    root.querySelector('#state-scroll').addEventListener('scroll', delayedEnable);
    root.querySelector('#state-wheel').addEventListener('wheel', e => { e.preventDefault(); delayedEnable(e); }, { passive: false });
    root.querySelector('#state-trigger').addEventListener('click', e => {
      const f = window.stateFixture, target = document.querySelector('#state-target');
      f.events.push({ type: 'click', trusted: e.isTrusted }); f.completed = false;
      const later = fn => f.timers.push(setTimeout(() => { fn(); f.completed = true; }, 90));
      if (f.mode === 'enabled') later(() => { target.disabled = false; });
      if (f.mode === 'disabled') later(() => { target.disabled = true; });
      if (f.mode === 'hidden') later(() => { target.style.display = 'none'; });
      if (f.mode === 'visible') { target.style.visibility = 'hidden'; later(() => { target.style.visibility = 'visible'; }); }
      if (f.mode === 'attached') { target.remove(); later(() => root.append(target)); }
      if (f.mode === 'detached') later(() => target.remove());
      if (f.mode === 'replacement') later(() => { const clone = target.cloneNode(true); clone.disabled = false; target.replaceWith(clone); });
      if (f.mode === 'checked') later(() => { document.querySelector('#state-check').checked = true; });
      if (f.mode === 'unchecked') later(() => { document.querySelector('#state-aria').setAttribute('aria-checked', 'false'); });
      if (f.mode === 'inherited') later(() => { document.querySelector('#state-fieldset').disabled = false; });
      if (f.mode === 'shadow') later(() => { document.querySelector('#state-shadow').shadowRoot.querySelector('input').checked = true; });
    });
    root.querySelector('#state-input').addEventListener('beforeinput', e => { e.preventDefault(); window.stateFixture.events.push({ type: 'beforeinput', trusted: e.isTrusted }); });
  });
  try {
    const reset = async mode => {
      await page.evaluate(mode => {
        const f = window.stateFixture; for (const t of f.timers) clearTimeout(t); f.timers = []; f.mode = mode;
        let target = document.querySelector('#state-target');
        if (!target) { target = document.createElement('button'); target.id = 'state-target'; target.textContent = '状态目标'; document.querySelector('#state-fixture').append(target); }
        target.style.cssText = 'display:block;min-height:24px;margin:4px'; target.disabled = ['enabled', 'replacement'].includes(mode);
      }, mode);
      return observe();
    };
    const ref = (o, name) => { const matches = o.nodes.filter(n => n.name === name); assert.equal(matches.length, 1, `State ref ${name}`); return matches[0].id; };
    const run = async (mode, desired = mode, name = '状态目标') => {
      const o = await reset(mode), before = await page.evaluate(() => window.stateFixture.events.length);
      const action = { kind: 'click', ref: ref(o, '状态触发'), expected: { kind: 'state', ref: ref(o, name), state: desired } };
      const result = await act(`state-${mode}`, action, { timeoutMs: 1600 });
      assert.equal(result.outcome, 'succeeded', JSON.stringify({ mode, result })); assert.equal(result.postcondition, 'passed');
      assert.equal(await page.evaluate(() => window.stateFixture.completed), true);
      assert.equal(await page.evaluate(() => window.stateFixture.events.length), before + 1);
      assert.deepEqual(await act(`state-${mode}`, action, { timeoutMs: 1600 }), result);
      assert.equal(await page.evaluate(() => window.stateFixture.events.length), before + 1);
      return { o, result };
    };
    await run('enabled'); assert.equal(await page.locator('#state-target').isEnabled(), true);
    await run('disabled'); assert.equal(await page.locator('#state-target').isDisabled(), true);
    await run('hidden'); assert.equal(await page.locator('#state-target').isVisible(), false);
    await run('visible'); assert.equal(await page.locator('#state-target').isVisible(), true);
    await run('attached'); assert.equal(await page.locator('#state-target').count(), 1);
    await run('detached'); assert.equal(await page.locator('#state-target').count(), 0);
    await run('checked', 'checked', '状态复选'); assert.equal(await page.locator('#state-check').isChecked(), true);
    await run('unchecked', 'unchecked', '状态自定义复选'); assert.equal(await page.locator('#state-aria').getAttribute('aria-checked'), 'false');
    await run('inherited', 'enabled', '状态继承禁用'); assert.equal(await page.locator('#state-inherited').isEnabled(), true);
    await run('shadow', 'checked', '状态阴影复选'); assert.equal(await page.locator('#state-shadow-check').isChecked(), true);
    // An enabled lookalike is not the disabled original retained before the click.
    const o = await reset('replacement'), oldRef = ref(o, '状态目标');
    const replacementAction = { kind: 'click', ref: ref(o, '状态触发'), expected: { kind: 'state', ref: oldRef, state: 'enabled' } };
    const replaced = await act('state-replacement', replacementAction, { timeoutMs: 500 });
    assert.equal(replaced.outcome, 'unknown'); assert.equal(replaced.code, 'DEADLINE_EXCEEDED');
    assert.equal(await page.locator('#state-target').isEnabled(), true);
    assert.notEqual(ref(await observe(), '状态目标'), oldRef);
    const afterReplacement = await page.evaluate(() => window.stateFixture.events.length);
    assert.deepEqual(await act('state-replacement', replacementAction, { timeoutMs: 500 }), replaced);
    assert.equal(await page.evaluate(() => window.stateFixture.events.length), afterReplacement);
    // The predicate itself is valid, but no action may start using an already-stale expected ref.
    const stale = await act('state-stale-expectation', replacementAction, { timeoutMs: 500 });
    assert.equal(stale.code, 'STALE_TARGET'); assert.equal(stale.dispatch, 'notDispatched');
    assert.equal(await page.evaluate(() => window.stateFixture.events.length), afterReplacement);
    const latest = await reset('none');
    const unsupported = await act('state-unsupported', { kind: 'click', ref: ref(latest, '状态触发'),
      expected: { kind: 'state', ref: ref(latest, '状态区域'), state: 'checked' } });
    assert.equal(unsupported.code, 'UNSUPPORTED_CAPABILITY'); assert.equal(unsupported.dispatch, 'notDispatched');
    assert.equal(await page.evaluate(() => window.stateFixture.events.length), afterReplacement);
    const fillAction = { kind: 'fill', ref: ref(latest, '状态输入'), text: '不得误报',
      expected: { kind: 'state', ref: ref(latest, '状态目标'), state: 'enabled' } };
    const prevented = await act('state-prevented-fill', fillAction, { timeoutMs: 500 });
    assert.equal(prevented.outcome, 'unknown'); assert.equal(prevented.code, 'DEADLINE_EXCEEDED');
    assert.equal(await page.locator('#state-input').inputValue(), '');
    const afterInput = await page.evaluate(() => window.stateFixture.events.length);
    assert.deepEqual(await act('state-prevented-fill', fillAction, { timeoutMs: 500 }), prevented);
    assert.equal(await page.evaluate(() => window.stateFixture.events.length), afterInput);
    // Verify state-binding propagation through the action-specific result paths.
    for (const [id, kind, name] of [['append', 'append', '状态追加'], ['editor', 'fill', '状态编辑'],
      ['scroll', 'scroll', '状态滚动'], ['wheel', 'wheel', '状态滚轮']]) {
      const snapshot = await reset('enabled');
      const action = { kind, ref: ref(snapshot, name), ...(kind === 'append' || kind === 'fill' ? { text: '新文本' } : { deltaX: 0, deltaY: 120 }),
        expected: { kind: 'state', ref: ref(snapshot, '状态目标'), state: 'enabled' } };
      const result = await act(`state-path-${id}`, action, { timeoutMs: 1600 });
      assert.equal(result.outcome, 'succeeded', JSON.stringify({ id, result }));
      assert.equal(await page.locator('#state-target').isEnabled(), true);
      if (id === 'append') assert.equal(await page.locator('#state-append').inputValue(), 'prefix新文本');
      if (id === 'editor') assert.equal(await page.locator('#state-editor').innerText(), '新文本');
      if (id === 'scroll') assert.equal(await page.locator('#state-scroll').evaluate(e => e.scrollTop), 120);
    }
    const checkSnapshot = await reset('none'), checkAction = { kind: 'check', ref: ref(checkSnapshot, '状态复选'), checked: false,
      expected: { kind: 'state', ref: ref(checkSnapshot, '状态目标'), state: 'enabled' } };
    assert.equal((await act('state-path-check', checkAction)).outcome, 'succeeded');
    assert.equal(await page.locator('#state-check').isChecked(), false);
    const noop = await act('state-path-check-noop', checkAction); assert.equal(noop.outcome, 'succeeded'); assert.equal(noop.dispatch, 'notDispatched');
    assert.ok((await page.evaluate(() => window.stateFixture.events)).every(e => e.trusted));
    return [
      'State postconditions wait for delayed native enabled/disabled states after one trusted, deduplicated click',
      'State visibility and original-node attachment/detachment are verified after delayed page changes',
      'State checked/unchecked reads native, custom ARIA and open-shadow controls without toggling the verification target',
      'Inherited native fieldset disabling is included in state verification',
      'Same-name replacement cannot satisfy a retained original enabled-state predicate or replay its click',
      'Already-stale and unsupported state refs fail before input rather than widening or guessing the target',
      'Prevented native fill cannot be hidden by an already-true unrelated state expectation',
      'Append, contenteditable fill and checked/no-op paths preserve their own verified result alongside an independent state condition',
      'DOM scroll and trusted wheel can wait for an independent target state without replaying movement',
    ];
  } finally {
    await page.evaluate(() => { for (const t of window.stateFixture?.timers ?? []) clearTimeout(t); document.querySelector('#state-fixture')?.remove(); delete window.stateFixture; });
  }
}
