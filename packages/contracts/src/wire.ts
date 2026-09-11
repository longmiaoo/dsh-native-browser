import { BrowserError, errorCodes, type ErrorCode } from './index.js';

export const wireVersion = 1;
export const providerCapabilities = ['lease.fencing.v1', 'ax.read.v1', 'ax.find.v1', 'input.named-keys.v1', 'scroll.dom.v1', 'ax.checked-state.v1', 'input.wheel.v1', 'input.radio.v1'] as const;
export const brokerCapabilities = ['runtime.v1', 'observe.query.v1', 'journal.recovery.v1', 'provider.ax-read.v1', 'provider.ax-find.v1', 'runtime.check.v1', 'runtime.wheel.v1', 'runtime.radio.v1', 'runtime.capture-publication.v1'] as const;
export const clientRequirements = ['runtime.v1', 'observe.query.v1', 'journal.recovery.v1', 'runtime.check.v1', 'runtime.wheel.v1', 'runtime.radio.v1', 'runtime.capture-publication.v1'] as const;
export const providerRequirements = ['runtime.v1', 'provider.ax-read.v1', 'provider.ax-find.v1'] as const;
export type WireMessage =
  | { type: 'request'; id: string; method: string; params: Record<string, unknown> }
  | { type: 'response'; id: string; ok: true; value: unknown }
  | { type: 'response'; id: string; ok: false; code: ErrorCode }
  | { type: 'event'; event: string; value: unknown }
  | { type: 'cancel'; id: string };
type Schema = { type?: string; const?: unknown; enum?: readonly unknown[]; properties?: Record<string, Schema>;
  required?: readonly string[]; additionalProperties?: boolean; minLength?: number; maxLength?: number;
  pattern?: string; minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
  uniqueItems?: boolean; items?: Schema; oneOf?: readonly Schema[] };
const id: Schema = { type: 'string', minLength: 1, maxLength: 128 };
const name: Schema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z][A-Za-z0-9_.:-]*$' };
const text: Schema = { type: 'string', minLength: 1, maxLength: 256 };
const list: Schema = { type: 'array', maxItems: 64, uniqueItems: true, items: name };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const helloCommon = { bootstrap: { const: 1 }, versions: { type: 'array', minItems: 1, maxItems: 8,
  uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 65535 } }, token: text,
  requiredCapabilities: list } satisfies Record<string, Schema>;
export const helloSchema: Schema = { oneOf: [
  object({ ...helloCommon, role: { const: 'client' }, journalKey: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['bootstrap', 'versions', 'role']),
  object({ ...helloCommon, role: { const: 'provider' }, capabilities: list,
    instance: object({ id, family: { const: 'chromium' }, brand: text, version: text, profileLabel: text }) },
    ['bootstrap', 'versions', 'role', 'capabilities', 'instance']),
] };
export const welcomeSchema: Schema = object({ version: { type: 'integer', minimum: 1, maximum: 65535 },
  connectionEpoch: id, capabilities: list });
export const envelopeSchema: Schema = { oneOf: [
  object({ type: { const: 'request' }, id, method: name, params: { type: 'object' } }),
  object({ type: { const: 'response' }, id, ok: { const: true }, value: {} }),
  object({ type: { const: 'response' }, id, ok: { const: false }, code: { enum: errorCodes } }),
  object({ type: { const: 'event' }, event: name, value: {} }),
  object({ type: { const: 'cancel' }, id }),
] };
export const wireSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/longmiaoo/dsh-native-browser/blob/main/protocol/v1.schema.json',
  title: 'DSH Native Browser development wire protocol v1',
  description: 'Generated from packages/contracts/src/wire.ts. Envelope validation is not method-payload authorization.',
  ...envelopeSchema, $defs: { hello: helloSchema, welcome: welcomeSchema } };

/** Deliberately small schema vocabulary, shared by Node and MV3. The schema definitions above are
 * also published as JSON Schema; independent validator tests check conformance. No $ref execution. */
export function matchesWireSchema(schema: Schema, value: unknown): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return false;
  if (schema.oneOf) return schema.oneOf.filter(s => matchesWireSchema(s, value)).length === 1;
  if ('const' in schema && schema.const !== value || schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    // JSON Schema lengths count Unicode code points, unlike UTF-16 String.length.
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || Number(value) < (schema.minimum ?? -Infinity) || Number(value) > (schema.maximum ?? Infinity)) return false;
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)
      || schema.uniqueItems && new Set(value).size !== value.length || schema.items && value.some(v => !matchesWireSchema(schema.items!, v))) return false;
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    if (schema.required?.some(key => !Object.hasOwn(v, key)) || schema.additionalProperties === false && Object.keys(v).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, s]) => Object.hasOwn(v, key) && !matchesWireSchema(s, v[key]))) return false;
  }
  return true;
}
export function wireMessage(value: unknown): WireMessage {
  if (!matchesWireSchema(envelopeSchema, value)) throw new BrowserError('PROTOCOL_MISMATCH', 'Malformed wire envelope');
  return value as WireMessage;
}
export function negotiateHello(value: unknown) {
  if (!matchesWireSchema(helloSchema, value)) throw new BrowserError('PROTOCOL_MISMATCH', 'Malformed or unsupported handshake');
  const hello = value as { bootstrap: 1; versions: number[]; role: 'client' | 'provider'; capabilities?: string[];
    requiredCapabilities?: string[]; instance?: unknown; token?: string; journalKey?: string };
  if (!hello.versions.includes(wireVersion) || (hello.requiredCapabilities ?? []).some(c => !(brokerCapabilities as readonly string[]).includes(c))
    || hello.role === 'provider' && providerCapabilities.some(c => !hello.capabilities?.includes(c))) {
    throw new BrowserError('PROTOCOL_MISMATCH', 'No compatible protocol or required capability');
  }
  return hello;
}
export function acceptWelcome(value: unknown, required: readonly string[]) {
  if (!matchesWireSchema(welcomeSchema, value)) throw new BrowserError('PROTOCOL_MISMATCH', 'Malformed Broker welcome');
  const welcome = value as { version: number; connectionEpoch: string; capabilities: string[] };
  if (welcome.version !== wireVersion || required.some(c => !welcome.capabilities.includes(c))) throw new BrowserError('PROTOCOL_MISMATCH', 'Broker lacks required version or capability');
  return welcome;
}
