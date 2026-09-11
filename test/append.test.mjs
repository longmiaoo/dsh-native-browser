import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { brokerCapabilities, clientRequirements, acceptWelcome } from '../dist/packages/contracts/src/wire.js';
import { nativeTextFunction } from '../dist/packages/provider-chromium/src/text-input.js';
import { FileActionJournal } from '../dist/packages/broker/src/action-journal.js';

const request = action => ({ requestId: 'append', leaseId: 'lease', documentEpoch: 'doc', action });
test('append has a portable exact-target contract with bounded suffix and ordinary postconditions', () => {
  for (const text of ['', '中文🙂\n', 'x'.repeat(10000)]) {
    const action = { kind: 'append', ref: 'ref', text };
    assert.deepEqual(actionRequest(request(action)).action, action);
  }
  const base = { kind: 'append', ref: 'ref', text: 'suffix' };
  for (const bad of [{ ...base, text: 'x'.repeat(10001) }, { ...base, ref: undefined }, { ...base, text: 4 },
    { ...base, selector: '#target' }, { ...base, position: 'start' }, { ...base, modifiers: ['Control'] }])
    assert.throws(() => actionRequest(request(bad)), { code: 'INVALID_REQUEST' });
  assert.deepEqual(actionRequest(request({ ...base, expected: { kind: 'value', value: 'prefixsuffix' } })).action.expected,
    { kind: 'value', value: 'prefixsuffix' });
});

test('old Broker cannot silently accept a client that requires append', () => {
  assert.ok(clientRequirements.includes('runtime.append.v1'));
  assert.throws(() => acceptWelcome({ version: 1, connectionEpoch: 'new',
    capabilities: brokerCapabilities.filter(c => c !== 'runtime.append.v1') }, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
});

const native = new Function(`return (${nativeTextFunction})`)();
function field() {
  const root = {}, calls = [];
  const element = { isConnected: true, tagName: 'INPUT', type: 'text', value: 'prefix🙂', maxLength: -1,
    getRootNode: () => root, matches: () => false, getAttribute: () => null,
    focus() { root.activeElement = this; },
    setSelectionRange(start, end) { calls.push([start, end]); this.selectionStart = start; this.selectionEnd = end; },
  };
  return { element, root, calls };
}
test('native append moves a collapsed UTF-16 caret without changing or selecting the prefix', () => {
  const f = field(); const state = native.call(f.element, 'end');
  assert.equal(state.value, 'prefix🙂'); assert.equal(state.atEnd, true);
  assert.deepEqual(f.calls, [[8, 8]]); assert.equal(f.element.value, 'prefix🙂');
  f.element.selectionStart = 0; assert.equal(native.call(f.element, 'position').atEnd, false);
  f.root.activeElement = {}; assert.equal(native.call(f.element, 'position').atEnd, false);
});
test('native append rejects protected/unsupported controls before reading their values or changing the caret', () => {
  for (const type of ['email', 'password', 'number', 'file', 'date']) {
    const f = field(); f.element.type = type;
    Object.defineProperty(f.element, 'value', { get() { throw Error('Must not read protected value'); } });
    assert.equal(native.call(f.element, 'end').editable, false); assert.deepEqual(f.calls, []);
  }
  for (const change of [e => { e.readOnly = true; }, e => { e.matches = () => true; },
    e => { e.getAttribute = name => name === 'aria-readonly' ? 'true' : null; }, e => { e.value = 'x'.repeat(10001); }]) {
    const f = field(); change(f.element); assert.equal(native.call(f.element, 'end').editable, false); assert.deepEqual(f.calls, []);
  }
});

test('append durable intent and settlement survive reopen without retaining input content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-append-journal-'));
  let journal;
  try {
    journal = await FileActionJournal.open(dir, 'b'.repeat(64));
    await journal.reserve('append-owner/private-suffix', 'prefix-and-suffix-digest', 'append');
    await journal.settle('append-owner/private-suffix', { outcome: 'unknown', dispatch: 'dispatched' });
    await journal.close(); journal = await FileActionJournal.open(dir, 'b'.repeat(64));
    const recovered = journal.lookup('append-owner/private-suffix', 'prefix-and-suffix-digest');
    assert.equal(recovered.priorOutcome, 'unknown'); assert.equal(recovered.dispatch, 'dispatched');
    assert.equal(await journal.reserve('append-owner/private-suffix', 'prefix-and-suffix-digest', 'append'), false);
    const data = await readFile(path.join(dir, 'action-journal.jsonl'), 'utf8');
    assert.equal(data.includes('private-suffix'), false); assert.equal(data.includes('prefix-and-suffix'), false);
  } finally { await journal?.close(); await rm(dir, { recursive: true, force: true }); }
});
