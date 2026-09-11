import assert from 'node:assert/strict';

// Only use on our loopback fixture. Browser actions are supplied by the caller:
// direct provider/runtime for the Chrome smoke, real DSH/native calls for native.
export async function verifyKeyboard({ page, observe, act }) {
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  const observation = await observe();
  const field = observation.nodes.find(n => n.role === 'textbox' && n.name === '搜索词');
  const button = observation.nodes.find(n => n.role === 'button' && n.name === '提交测试');
  assert.ok(field); assert.ok(button);
  const value = await page.locator('#query').inputValue(); assert.ok(value.length > 1);
  const events = () => page.evaluate(() => window.fixtureKeys);
  const firstEvent = (await events()).length;
  const enter = { kind: 'press', ref: field.id, key: 'Enter', expected: { kind: 'text', text: `键盘已提交：${value}` } };
  const submitted = await act('keyboard-enter', enter);
  assert.equal(submitted.outcome, 'succeeded');
  const sent = (await events()).slice(firstEvent);
  assert.deepEqual(sent.map(e => [e.type, e.key, e.target, e.trusted]), [['keydown', 'Enter', 'query', true], ['keyup', 'Enter', 'query', true]]);
  assert.deepEqual(await act('keyboard-enter', enter), submitted);
  assert.equal((await events()).length, firstEvent + 2, 'Deduplication must not submit twice');

  // Known fixture caret position; this is test setup, not an exposed browser capability.
  await page.locator('#query').evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
  assert.equal((await act('keyboard-left', { kind: 'press', ref: field.id, key: 'ArrowLeft' })).outcome, 'unknown');
  assert.equal(await page.locator('#query').evaluate(element => element.selectionStart), value.length - 1);
  await act('keyboard-right', { kind: 'press', ref: field.id, key: 'ArrowRight' });
  assert.equal(await page.locator('#query').evaluate(element => element.selectionStart), value.length);

  assert.equal((await act('keyboard-tab', { kind: 'press', ref: field.id, key: 'Tab' })).outcome, 'unknown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'submit');
  assert.equal((await act('keyboard-shift-tab', { kind: 'press', ref: button.id, key: 'Tab', shift: true })).outcome, 'unknown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'query');
  const tabEvents = (await events()).filter(e => e.key === 'Tab');
  assert.deepEqual(tabEvents.map(e => e.shift), [false, false, true, true]);
  assert.ok(tabEvents.every(e => e.trusted && !e.ctrl && !e.alt && !e.meta));

  const clicks = await page.evaluate(() => window.fixtureClicks.submit);
  const activated = await act('keyboard-space', { kind: 'press', ref: button.id, key: 'Space', expected: { kind: 'text', text: `已提交：${value}` } });
  assert.equal(activated.outcome, 'succeeded');
  assert.equal(await page.evaluate(() => window.fixtureClicks.submit), clicks + 1);
  const focusStealer = () => page.locator('#query').evaluate(element => {
    document.getElementById('submit').focus();
    element.addEventListener('focus', () => document.getElementById('submit').focus(), { once: true });
  });
  await focusStealer();
  const keyCount = (await events()).length;
  const lost = await act('keyboard-focus-stolen', { kind: 'press', ref: field.id, key: 'Enter' });
  assert.equal(lost.code, 'NOT_ACTIONABLE'); assert.equal(lost.outcome, 'unknown', 'Focus itself can invoke page handlers');
  assert.equal((await events()).length, keyCount);
  await focusStealer();
  const noFill = await act('fill-focus-stolen', { kind: 'fill', ref: field.id, text: 'must not type' });
  assert.equal(noFill.code, 'NOT_ACTIONABLE'); assert.equal(noFill.outcome, 'unknown');
  assert.equal(await page.locator('#query').inputValue(), value);
  assert.equal(await page.evaluate(() => window.fixtureClicks.submit), clicks + 1);
  return ['Trusted Enter submits the fixture form once, including request deduplication',
    'Arrow keys move the real caret without synthesizing arbitrary text', 'Tab and Shift+Tab move focus without system modifiers',
    'Space activates a focused button once with a verified text result',
    'Focus stolen by the page prevents key delivery', 'Focus stolen by the page also prevents text insertion'];
}
