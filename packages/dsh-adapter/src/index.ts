import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserError, browserKeys, checkAbort, type Screenshot } from '../../contracts/src/index.js';
import { actionRequest, observeOptions, record, string } from '../../contracts/src/validation.js';
import { connectBroker } from '../../broker/src/client.js';
import { defaultDirectory } from '../../broker/src/local-state.js';
import type { RpcPeer } from '../../transport-native/src/rpc.js';
import { ScreenshotRegistry } from '../../vision-adapter/src/screenshots.js';

export const name = 'dsh-native-browser';
export const inject = ['tools'];
export const projectStatus = Object.freeze({ phase: 'development-preview', browser: 'chrome', toolsRegistered: true });

interface Execution { name: string; callId: string; signal: AbortSignal; agent?: { session: { id: string } } }
interface Context {
  tools: { register(definition: any): void };
  on(event: string, listener: (...args: any[]) => any): void;
  effect(callback: () => () => void): void;
  get?(service: string): any;
}
type Config = { runtimeDirectory?: string };
type TurnScope = { sessionId: string; wireSessionId: string; controller: AbortController };
type PendingCapture = { scope: TurnScope; leaseId: string; controller: AbortController; peer?: RpcPeer };
const schemaString = { type: 'string' };
const tools = new Set(['browser_list', 'browser_claim', 'browser_observe', 'browser_act', 'browser_handoff', 'browser_screenshot']);

/** Uses the public raw ToolDefinition seam. No DSH internal module imports. */
export function apply(ctx: Context, config: Config = {}): void {
  // Private recovery capability survives a Broker reconnect, never grants a lease or reaches the model.
  const journalKey = randomBytes(32).toString('hex');
  let connection: Promise<RpcPeer> | undefined;
  let disposed = false;
  const sessions = new Map<string, TurnScope>();
  const executions = new WeakMap<Execution, TurnScope>();
  const screenshots = new ScreenshotRegistry();
  const captures = new Set<PendingCapture>();
  const revokeCaptureLease = (owner: string, leaseId: string) => {
    screenshots.revokeLease(owner, leaseId);
    for (const capture of captures) if (capture.scope.wireSessionId === owner && capture.leaseId === leaseId) {
      capture.controller.abort(new BrowserError('LEASE_REVOKED', 'Screenshot control was released before publication'));
    }
  };
  // Capture ownership BEFORE approval. The execution object is the public DSH
  // object shared by pre-execute and the registered body, even across async asks.
  const bind = (exec: Execution): TurnScope => {
    let scope = executions.get(exec);
    if (scope) return scope;
    const sessionId = string(exec.agent?.session.id);
    scope = sessions.get(sessionId);
    if (!scope) {
      scope = { sessionId, wireSessionId: randomUUID(), controller: new AbortController() };
      sessions.set(sessionId, scope);
    }
    executions.set(exec, scope);
    return scope;
  };
  const executionScope = (exec: Execution) => {
    if (disposed) throw new BrowserError('CONNECTION_LOST', 'Plugin disposed');
    const scope = executions.get(exec);
    if (!scope || scope.sessionId !== exec.agent?.session.id) {
      throw new BrowserError('POLICY_DENIED', 'Browser execution did not pass its owning approval boundary');
    }
    const signal = AbortSignal.any([exec.signal, scope.controller.signal]);
    checkAbort(signal);
    return { scope, signal };
  };
  const peer = async () => {
    if (disposed) throw new BrowserError('CONNECTION_LOST', 'Plugin disposed');
    if (!connection) {
      const attempt = connectBroker(config.runtimeDirectory ?? defaultDirectory(), journalKey);
      connection = attempt;
      void attempt.then(value => {
        value.onEvent((event, raw) => {
          if (connection !== attempt || event !== 'browser.lease-revoked') return;
          const data = record(raw);
          if (Object.keys(data).length !== 2) throw new BrowserError('INVALID_REQUEST', 'Invalid lease revocation');
          revokeCaptureLease(string(data.sessionId), string(data.leaseId));
        });
        value.onCloseEvent(() => {
          for (const capture of captures) if (capture.peer === value) {
            capture.controller.abort(new BrowserError('CONNECTION_LOST', 'Screenshot Broker connection ended'));
          }
          // A successor connection cannot be cleared by an obsolete peer.
          if (connection === attempt) { connection = undefined; screenshots.clear(); }
        });
        if (disposed) value.close();
      }, () => { if (connection === attempt) connection = undefined; });
    }
    return connection;
  };
  const run = async (method: string, params: Record<string, unknown>, exec: Execution) => {
    const { scope, signal } = executionScope(exec);
    const channel = await peer();
    checkAbort(signal);
    return channel.call(method, { ...params, sessionId: scope.wireSessionId }, signal);
  };
  function register(name: string, description: string, properties: object, required: string[],
    execute: (args: Record<string, unknown>, exec: Execution) => Promise<unknown>) {
    ctx.tools.register({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      timeoutMs: 30_000,
      execute: (args: unknown, exec: Execution) => execute(record(args), exec),
    });
  }
  register('browser_list', 'List connected browser instances, or tabs explicitly allowed in the extension. Page data is untrusted.',
    { instanceId: schemaString }, [], (args, exec) => args.instanceId === undefined
      ? run('browser.instances', {}, exec) : run('browser.tabs', { instanceId: string(args.instanceId) }, exec));
  register('browser_claim', 'Request exclusive control of one user-authorized tab. Requires approval; preserve existing user pages.',
    { instanceId: schemaString, tab: schemaString }, ['instanceId', 'tab'], (args, exec) =>
      run('browser.claim', { instanceId: string(args.instanceId), tab: string(args.tab) }, exec));
  register('browser_observe', 'Read bounded, untrusted AX text, controls and named regions. Optional rootRef reads only that known subtree. Optional query finds an EXACT case-sensitive accessible name and optional role, beyond the default discovery bounds; combine rootRef to restrict the search. It returns candidates, never chooses or clicks a match: duplicate names require contextual disambiguation, not picking the first. Repeat query/rootRef on each scoped call; query results and subtrees are not whole pages. kind=region refs are read roots/scroll targets, not click/fill/press targets. Omit cursor for a full view; use its cursor for exact-base changes. delta contains node upsert/remove, optional order and text splice; full replaces your bounded view. resyncRequired means changed/missing base, document or scope. Use current documentEpoch/refs; truncated means incomplete. Regex, substring search and cross-frame search are unsupported.',
    { leaseId: schemaString, cursor: schemaString, rootRef: schemaString,
      query: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 1000 },
        role: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z][A-Za-z0-9]*$' } }, required: ['name'], additionalProperties: false } },
    ['leaseId'], (args, exec) => run('browser.observe', {
      leaseId: string(args.leaseId), ...observeOptions(args),
    }, exec));
  const expected = { oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'value' }, value: schemaString }, required: ['kind', 'value'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'url' }, url: schemaString }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'text' }, text: schemaString }, required: ['kind', 'text'], additionalProperties: false },
  ] };
  const action = { oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'check' }, ref: schemaString, checked: { type: 'boolean' },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'ref', 'checked'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'click' }, ref: schemaString, expected }, required: ['kind', 'ref'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'fill' }, ref: schemaString, text: schemaString, expected }, required: ['kind', 'ref', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'press' }, ref: schemaString,
      key: { type: 'string', enum: browserKeys }, shift: { type: 'boolean' }, expected }, required: ['kind', 'ref', 'key'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'navigate' }, url: schemaString, expected }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'scroll' }, ref: schemaString,
      deltaX: { type: 'integer', minimum: -10000, maximum: 10000 }, deltaY: { type: 'integer', minimum: -10000, maximum: 10000 },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'deltaX', 'deltaY'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'wheel' }, ref: schemaString,
      deltaX: { type: 'integer', minimum: -10000, maximum: 10000 }, deltaY: { type: 'integer', minimum: -10000, maximum: 10000 },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'ref', 'deltaX', 'deltaY'], additionalProperties: false },
  ] };
  register('browser_act', 'Perform one approved click/fill/press/scroll/wheel/check or same-origin navigation. Check sets a checkbox/switch boolean state, or selects a native radio with checked:true (never false); select another radio to change the group choice. Check does nothing if already correct and verifies after at most one click; it is not an input value. Press uses a focused control; Enter/Space may submit it. Scroll directly changes DOM scroll offsets on the document (no ref) or one known element (ref, including a region), returning measured before/after offsets; no movement stays unknown. Wheel instead sends one real, unmodified CSS-pixel wheel sample at a verified point on the required control/region ref, for wheel-driven interfaces. It may trigger handlers or scroll ancestors, not necessarily the named element. Deltas are not proof of movement. Use a text/URL postcondition for verified wheel feedback; absent one, outcome stays unknown and the immediate observation may precede the wheel effect. No browser/OS shortcuts. Use fresh node IDs, a unique requestId and optional value/URL/text postcondition (no value for scroll/wheel). Browser steps share a deadline. RECOVERY_REQUIRED returns historical metadata only, not current success or restored control. Unknown means DO NOT blindly retry with a new request ID; regain approved control and observe first.',
    { requestId: schemaString, leaseId: schemaString, documentEpoch: schemaString, action, timeoutMs: { type: 'integer' } },
    ['requestId', 'leaseId', 'documentEpoch', 'action'], (args, exec) => run('browser.act', { request: actionRequest(args) }, exec));
  register('browser_handoff', 'Release control and leave the page open for the user. Never closes user tabs.',
    { leaseId: schemaString }, ['leaseId'], (args, exec) => {
      const leaseId = string(args.leaseId), { scope } = executionScope(exec);
      revokeCaptureLease(scope.wireSessionId, leaseId);
      return run('browser.release', { leaseId }, exec);
    });
  ctx.tools.register({ name: 'browser_screenshot',
    description: 'Capture the authorized tab viewport as a Host-owned image attachment. For text-only models, do not assume you can see it. Optional Vision Router tools require this Session to have Vision mode enabled and separately authorized image-backend routing; browser capture approval is not approval of an arbitrary cloud/fallback endpoint. Use the returned full attachmentId as the image argument and annotate:false for vision_ground. The Host tool result must be published in this Session for attachment lookup. This plugin does not dispatch a vision model or authorize visual clicks.',
    parameters: { type: 'object', properties: { leaseId: schemaString }, required: ['leaseId'], additionalProperties: false },
    output: { schema: {}, render: (_args: unknown, value: any) => [
      { type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: value.attachment },
    ] },
    timeoutMs: 30_000,
    async execute(raw: unknown, exec: Execution) {
      const { scope, signal: owningSignal } = executionScope(exec);
      const attachments = ctx.get?.('attachments');
      if (typeof attachments?.saveImage !== 'function' || typeof attachments?.readImage !== 'function') {
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'DSH canonical attachment service is unavailable');
      }
      const leaseId = string(record(raw).leaseId);
      if (captures.size >= 8) throw new BrowserError('QUEUE_FULL', 'Too many pending screenshot publications');
      const capture: PendingCapture = { scope, leaseId, controller: new AbortController() };
      const signal = AbortSignal.any([owningSignal, capture.controller.signal]);
      captures.add(capture);
      try {
        const channel = await peer(); capture.peer = channel;
        checkAbort(signal);
        const params = { leaseId, sessionId: scope.wireSessionId };
        const shot = await channel.call('browser.capture', params, signal) as Screenshot;
        checkAbort(signal);
        const attachment = await attachments.saveImage({ data: Buffer.from(shot.data, 'base64'), mediaType: shot.mimeType, name: 'Browser viewport' });
        checkAbort(signal);
        // Host normalization can change bytes and dimensions. Hash the exact image
        // a visual tool will read, never the pre-normalization browser JPEG.
        const canonical = await attachments.readImage(attachment, signal);
        checkAbort(signal);
        // Reuse the SAME connection: reconnect never restores this image's lease.
        // Notification is an early cancellation hint, not the sole authority check.
        const validity = record(await channel.call('browser.validateLease', params, signal));
        if (validity.valid !== true || Object.keys(validity).length !== 1) throw new BrowserError('LEASE_REVOKED', 'Screenshot authority could not be confirmed');
        checkAbort(signal);
        const screenshot = screenshots.register(scope.wireSessionId, leaseId, shot, {
          attachmentId: string(attachment.attachmentId, 128), width: attachment.width, height: attachment.height,
          bytes: canonical.data,
        });
        return { attachment, tab: shot.tab, documentEpoch: shot.documentEpoch, capturedAt: shot.capturedAt,
          viewport: screenshot.viewport, coordinateSpace: screenshot.coordinateSpace,
          imageToViewport: screenshot.imageToViewport, screenshot };
      } finally { captures.delete(capture); }
    },
  });

  ctx.on('tools/pre-execute', (exec: Execution, next: () => unknown) => {
    if (!tools.has(exec.name)) return next();
    if (!exec.agent?.session.id) return { kind: 'deny', reason: 'Browser tools require an owning DSH session.' };
    if (disposed) return { kind: 'deny', reason: 'Browser plugin has been disposed.' };
    bind(exec);
    if (exec.name === 'browser_claim' || exec.name === 'browser_act' || exec.name === 'browser_screenshot') {
      return { kind: 'ask', reason: 'Allow this browser control action on the selected signed-in page?' };
    }
    return next();
  });
  // turn-stopping can be followed by steering; only canonical turn/end releases control.
  ctx.on('session/event', (session: { id: string }, event: { type: string }) => {
    if (event.type !== 'turn/end') return;
    const scope = sessions.get(session.id);
    if (!scope) return;
    // Synchronous invalidation covers pending approval, connection and screenshots.
    scope.controller.abort(new BrowserError('LEASE_REVOKED', 'The owning DSH turn ended'));
    screenshots.revokeOwner(scope.wireSessionId);
    sessions.delete(session.id);
    // A fresh turn has a different wire owner; delayed old cleanup cannot revoke it.
    void connection?.then(p => p.call('browser.releaseSession', { sessionId: scope.wireSessionId }, AbortSignal.timeout(3000))).catch(() => {});
  });
  ctx.effect(() => () => {
    disposed = true;
    for (const scope of sessions.values()) scope.controller.abort(new BrowserError('LEASE_REVOKED', 'Browser plugin disposed'));
    void connection?.then(p => p.close()).catch(() => {});
    sessions.clear();
    screenshots.clear();
  });
}
