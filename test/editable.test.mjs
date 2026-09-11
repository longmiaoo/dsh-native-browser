import assert from 'node:assert/strict';
import test from 'node:test';
import { editableText } from '../dist/packages/provider-chromium/src/editable.js';
import { brokerCapabilities, clientRequirements, providerCapabilities, negotiateHello, acceptWelcome } from '../dist/packages/contracts/src/wire.js';
import { readAXTree } from '../dist/packages/provider-chromium/src/ax-reader.js';
import { findAXNodes } from '../dist/packages/provider-chromium/src/ax-query.js';

const text = value => ({ nodeType: 3, nodeValue: value });
const element = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes, lastChild: childNodes.at(-1) });
const br = () => element('BR'), line = (...nodes) => element('DIV', ...nodes);

test('logical editor text distinguishes caret placeholders from content and keeps whitespace', () => {
  const fixtures = [
    [element('DIV'), ''], [line(br()), ''], [line(br(), line(br())), '\n'],
    [line(text('\n'), br()), '\n'], [line(line(br()), line(br()), line(br())), '\n\n'],
    [line(text('A'), br(), line(br())), 'A\n'],
    [line(line(text('A')), line(br())), 'A\n'],
    [line(line(text('A')), line(br()), line(text('B'))), 'A\n\nB'],
    [line(text('中文🙂'), line(text('  text  '))), '中文🙂\n  text  '],
    [line(element('B', text('rich')), element('I', text(' text'))), 'rich text'],
    [line(text('A'), { nodeType: 8 }, line(text('B'))), 'A\nB'],
  ];
  for (const [root, expected] of fixtures) assert.equal(editableText(root), expected);
});

test('editor text bounds depth, node count and value size; unsupported structures are not flattened', () => {
  assert.equal(editableText(line(text('a'.repeat(10000)))), 'a'.repeat(10000));
  assert.equal(editableText(line(text('a'.repeat(10001)))), null);
  assert.equal(editableText(line(...Array.from({ length: 4097 }, () => text('')))), null);
  let nested = text('a'); for (let i = 0; i < 66; i++) nested = element('SPAN', nested);
  assert.equal(editableText(line(nested)), null);
  for (const tag of ['IMG', 'TABLE', 'INPUT', 'SCRIPT']) assert.equal(editableText(line(element(tag))), null);
});

test('editor fill requires a capable Broker without changing the underlying extension CDP commands', () => {
  assert.ok(clientRequirements.includes('runtime.contenteditable-fill.v1'));
  assert.throws(() => acceptWelcome({ version: 1, connectionEpoch: 'new',
    capabilities: brokerCapabilities.filter(c => c !== 'runtime.contenteditable-fill.v1') }, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
  assert.throws(() => negotiateHello({ bootstrap: 1, versions: [1], role: 'provider',
    capabilities: providerCapabilities.filter(c => c !== 'ax.editable-state.v1'),
    instance: { id: 'p', family: 'chromium', brand: 'chrome', version: 'test', profileLabel: 'test' } }), { code: 'PROTOCOL_MISMATCH' });
});

test('bounded AX read and exact search retain only valid editor metadata, never AX values', async () => {
  const properties = [{ name: 'focusable', value: { value: true } }, { name: 'editable', value: { value: 'richtext' } }];
  const node = { nodeId: '1', backendDOMNodeId: 1, frameId: 'frame', role: { value: 'generic' }, name: { value: 'Editor' },
    properties: [...properties, { name: 'editable', value: { value: 'untrusted-token' } }, { name: 'focusable', value: { value: 'true' } }],
    value: { value: 'private editor value' } };
  const signal = new AbortController().signal;
  const read = await readAXTree({ frameId: 'frame' }, async () => ({ node }), signal);
  const found = await findAXNodes({ frameId: 'frame', backendNodeId: 1, query: { name: 'Editor', role: 'generic' } }, async () => ({ nodes: [node] }), signal);
  for (const result of [read, found]) {
    assert.deepEqual(result.nodes[0].properties, properties);
    assert.equal(JSON.stringify(result).includes('private editor value'), false);
  }
});
