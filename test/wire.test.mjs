import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { errorCodes } from '../dist/packages/contracts/src/index.js';
import { wireSchema, envelopeSchema, helloSchema, welcomeSchema, matchesWireSchema, wireMessage,
  negotiateHello, acceptWelcome, providerCapabilities, brokerCapabilities, clientRequirements } from '../dist/packages/contracts/src/wire.js';

const client = { bootstrap: 1, versions: [1], role: 'client', requiredCapabilities: [...clientRequirements] };
const provider = { bootstrap: 1, versions: [1], role: 'provider', capabilities: [...providerCapabilities],
  instance: { id: 'fixture', family: 'chromium', brand: 'chrome', version: 'fixture', profileLabel: 'isolated' } };
const welcome = { version: 1, connectionEpoch: 'connection', capabilities: [...brokerCapabilities] };
const goodMessages = [
  { type: 'request', id: 'r', method: 'hello', params: client },
  { type: 'request', id: '😀'.repeat(128), method: 'side-effect', params: {} },
  ...[null, false, 0, '', [], {}, { version: 1 }].map(value => ({ type: 'response', id: 'r', ok: true, value })),
  ...errorCodes.map(code => ({ type: 'response', id: 'r', ok: false, code })),
  { type: 'event', event: 'page.changed', value: { leaseId: 'l', sequence: 1 } },
  { type: 'cancel', id: 'r' },
];
const malformed = [null, [], {}, true, 'request',
  { type: 'request', id: '', method: 'hello', params: {} },
  { type: 'request', id: '😀'.repeat(129), method: 'hello', params: {} },
  { type: 'request', id: 'r', method: '1invalid', params: {} },
  { type: 'request', id: 'r', method: 'a'.repeat(129), params: {} },
  { type: 'request', id: 'r', method: 'hello', params: [] },
  { type: 'response', id: 'r', ok: 1, value: null },
  { type: 'response', id: 'r', ok: true, code: 'INTERNAL_ERROR' },
  { type: 'response', id: 'r', ok: false, code: 'FAKE_CODE' },
  { type: 'response', id: 'r', ok: false, code: 'INTERNAL_ERROR', message: 'secret' },
  { type: 'event', event: '', value: null },
];

test('published schema is generated exactly from the portable runtime contract', async () => {
  const text = await readFile(new URL('../protocol/v1.schema.json', import.meta.url), 'utf8');
  assert.equal(text, `${JSON.stringify(wireSchema, null, 2)}\n`);
  const ajv = new Ajv2020({ strict: true, ownProperties: true });
  assert.equal(ajv.validateSchema(wireSchema), true);
  const validate = ajv.compile(wireSchema);
  for (const message of goodMessages) assert.equal(validate(message), true, JSON.stringify(validate.errors));
});

test('envelopes reject malformed fields without coercing, removing or exposing payloads', () => {
  for (const message of goodMessages) assert.equal(wireMessage(message), message);
  for (const message of malformed) assert.throws(() => wireMessage(message), e =>
    e.code === 'PROTOCOL_MISMATCH' && !e.message.includes('secret'));
});

test('shared validator agrees with independent Ajv 2020 on wire and handshake mutations', () => {
  const ajv = new Ajv2020({ strict: true, ownProperties: true });
  const suites = [
    [envelopeSchema, goodMessages, malformed],
    [helloSchema, [client, provider, { ...client, journalKey: 'a'.repeat(64), token: 't' }],
      [{ ...provider, capabilities: [] }, { ...client, versions: [2] }, { ...client, versions: [1, 1] },
        { ...client, versions: [0] }, { ...client, versions: [65536] }, { ...client, versions: [1.5] },
        { ...client, journalKey: 'x'.repeat(64) }, { ...provider, capabilities: Array(65).fill('x') },
        { ...provider, instance: { ...provider.instance, extra: true } }]],
    [welcomeSchema, [welcome], [{ ...welcome, capabilities: ['x', 'x'] }, { ...welcome, version: 2 }]],
  ];
  const replacements = [null, false, 0, 1, 1.5, '', 'unknown', '😀'.repeat(129), [], {}, ['x', 'x']];
  let compared = 0;
  for (const [schema, good, extra] of suites) {
    const validate = ajv.compile(schema);
    const vectors = [...good, ...extra];
    for (const value of good) {
      vectors.push({ ...value, unknown: true });
      for (const key of Object.keys(value)) {
        const missing = { ...value }; delete missing[key]; vectors.push(missing);
        for (const replacement of replacements) vectors.push({ ...value, [key]: replacement });
      }
    }
    for (const value of vectors) {
      const before = JSON.stringify(value);
      assert.equal(matchesWireSchema(schema, value), validate(value), before);
      assert.equal(JSON.stringify(value), before); compared++;
    }
  }
  assert.ok(compared > 1000);
});

test('capability negotiation rejects unsupported requirements, tolerates optional advertisements', () => {
  assert.equal(negotiateHello(client).role, 'client');
  assert.equal(negotiateHello({ ...provider, capabilities: [...providerCapabilities, 'future.optional.v1'] }).role, 'provider');
  for (const value of [{ ...client, versions: [2] }, { ...client, requiredCapabilities: ['future.required.v1'] },
    { ...provider, capabilities: providerCapabilities.slice(1) }, { ...provider, capabilities: [...providerCapabilities, providerCapabilities[0]] }]) {
    assert.throws(() => negotiateHello(value), { code: 'PROTOCOL_MISMATCH' });
  }
  assert.equal(acceptWelcome(welcome, clientRequirements), welcome);
  for (const value of [{ ...welcome, version: 2 }, { ...welcome, capabilities: [] }, { version: 1 }]) {
    assert.throws(() => acceptWelcome(value, clientRequirements), { code: 'PROTOCOL_MISMATCH' });
  }
});
