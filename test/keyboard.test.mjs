import assert from 'node:assert/strict';
import test from 'node:test';
import { browserKeys } from '../dist/packages/contracts/src/index.js';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { keyEvent, allowedKeyEvent } from '../dist/packages/provider-chromium/src/keyboard.js';

const request = action => ({ requestId: 'key', leaseId: 'lease', documentEpoch: 'doc', action });
test('all supported page keys encode canonical down/up pairs with only optional Shift', () => {
  for (const key of browserKeys) for (const shift of [false, true]) for (const type of ['keyDown', 'keyUp']) {
    const event = keyEvent(key, shift, type);
    assert.equal(allowedKeyEvent(event), true);
    assert.equal(event.modifiers, shift ? 8 : 0);
    assert.equal(event.code, key);
    if (type === 'keyUp') assert.equal(event.text, undefined);
  }
});

test('key event gate rejects extra commands, arbitrary text, system modifiers and mismatched codes', () => {
  const event = keyEvent('Enter', false, 'keyDown');
  for (const patch of [{ modifiers: 2 }, { modifiers: 4 }, { modifiers: 1 }, { modifiers: 10 },
    { key: 'L' }, { code: 'KeyL' }, { windowsVirtualKeyCode: 76 }, { text: 'arbitrary input' },
    { commands: ['selectAll'] }, { autoRepeat: true }, { isSystemKey: true }, { type: 'char' }]) {
    assert.equal(allowedKeyEvent({ ...event, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(allowedKeyEvent({}), false);
  assert.throws(() => keyEvent('__proto__', false, 'keyDown'), e => e.code === 'INVALID_REQUEST');
});

test('public press request parsing accepts only the bounded key contract', () => {
  for (const key of browserKeys) {
    assert.deepEqual(actionRequest(request({ kind: 'press', ref: 'r', key })).action, { kind: 'press', ref: 'r', key, shift: false });
  }
  for (const patch of [{ key: 'Meta+L' }, { key: '' }, { key: 'a' }, { key: '__proto__' },
    { shift: 'true' }, { modifiers: ['Control'] }, { ctrl: true }, { repeat: 10 }, { text: 'arbitrary' }]) {
    assert.throws(() => actionRequest(request({ kind: 'press', ref: 'r', key: 'Enter', ...patch })), e => e.code === 'INVALID_REQUEST');
  }
});
