import test from 'node:test';
import assert from 'node:assert/strict';
import { elementStates } from '../dist/packages/contracts/src/index.js';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { brokerCapabilities, clientRequirements, acceptWelcome } from '../dist/packages/contracts/src/wire.js';
import { elementStateFunction } from '../dist/packages/provider-chromium/src/element-state.js';

const request = expected => ({ requestId: 'state', leaseId: 'lease', documentEpoch: 'doc', action: { kind: 'click', ref: 'button', expected } });
test('portable state expectations require one exact known ref and a supported condition', () => {
  for (const state of elementStates) {
    const expected = { kind: 'state', ref: 'target', state };
    assert.deepEqual(actionRequest(request(expected)).action.expected, expected);
  }
  for (const expected of [{ kind: 'state', state: 'hidden' }, { kind: 'state', ref: '', state: 'hidden' },
    { kind: 'state', ref: 'x'.repeat(129), state: 'hidden' }, { kind: 'state', ref: 'target', state: 'arbitrary' },
    { kind: 'state', ref: 'target', state: 'hidden', selector: '#other' }, { kind: 'state', ref: 'target', state: 'hidden', objectId: 'forged' }])
    assert.throws(() => actionRequest(request(expected)), { code: 'INVALID_REQUEST' });
  const nav = request({ kind: 'state', ref: 'target', state: 'hidden' }); nav.action = { ...nav.action, kind: 'navigate', url: 'https://example.test/' };
  assert.throws(() => actionRequest(nav), { code: 'INVALID_REQUEST' });
});

test('state expectation support is required from the Broker, not silently ignored', () => {
  assert.ok(clientRequirements.includes('runtime.element-state.v1'));
  assert.throws(() => acceptWelcome({ version: 1, connectionEpoch: 'epoch',
    capabilities: brokerCapabilities.filter(c => c !== 'runtime.element-state.v1') }, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
});

function fixture() {
  const document = {}, style = { visibility: 'visible', opacity: '0' }, box = { width: 100, height: 30, x: -10000 };
  const element = { isConnected: true, ownerDocument: document, tagName: 'INPUT', type: 'checkbox', checked: false,
    getBoundingClientRect: () => box, getAttribute: () => null, matches: () => false, getRootNode: () => ({}) };
  const read = new Function('document', 'getComputedStyle', `return (${elementStateFunction});`)(document, () => style);
  return { element, style, box, read: state => read.call(element, state) };
}
test('state visibility is independent of opacity, viewport and hit testing; detached is exact node state', () => {
  const f = fixture();
  assert.equal(f.read('visible').matched, true); assert.equal(f.read('hidden').matched, false);
  f.style.visibility = 'hidden'; assert.equal(f.read('hidden').matched, true);
  f.style.visibility = 'visible'; f.box.width = 0; assert.equal(f.read('visible').matched, false);
  f.element.isConnected = false;
  for (const state of ['detached', 'hidden']) assert.equal(f.read(state).matched, true);
  for (const state of ['attached', 'visible', 'enabled', 'disabled', 'checked', 'unchecked']) assert.equal(f.read(state).matched, false);
  f.element.ownerDocument = {}; assert.equal(f.read('detached').sameDocument, false); assert.equal(f.read('detached').matched, false);
});
test('state disabled predicates respect native disabled, composed ancestry, inert and bounded work', () => {
  const f = fixture(); assert.equal(f.read('enabled').matched, true);
  f.element.matches = () => true; assert.equal(f.read('disabled').matched, true);
  f.element.matches = () => false;
  f.element.parentElement = { inert: true, getAttribute: () => null, getRootNode: () => ({}) };
  assert.equal(f.read('disabled').matched, true);
  f.element.parentElement = undefined; f.element.getAttribute = name => name === 'aria-disabled' ? 'true' : null;
  assert.equal(f.read('enabled').matched, false);
  f.element.getAttribute = () => null; f.element.parentElement = f.element;
  assert.equal(f.read('enabled').supported, false);
  f.element.parentElement = undefined; f.element.tagName = 'SECTION'; assert.equal(f.read('enabled').supported, false);
});
test('state checked predicates never coerce mixed, missing ARIA or detached into unchecked', () => {
  const f = fixture(); assert.equal(f.read('unchecked').matched, true);
  f.element.indeterminate = true;
  assert.equal(f.read('unchecked').matched, false); assert.equal(f.read('checked').matched, false);
  f.element.tagName = 'DIV';
  for (const value of ['true', 'false', 'mixed', null]) {
    f.element.getAttribute = name => name === 'role' ? 'checkbox' : name === 'aria-checked' ? value : null;
    assert.equal(f.read('checked').matched, value === 'true'); assert.equal(f.read('unchecked').matched, value === 'false');
    assert.equal(f.read('checked').supported, value !== null);
  }
});
