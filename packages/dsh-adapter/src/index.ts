import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BrowserError, browserKeys, elementStates, checkAbort, originOf, type BatchRequest, type Screenshot } from '../../contracts/src/index.js';
import { actionRequest, batchRequest, observeOptions, pageReadOptions, record, string } from '../../contracts/src/validation.js';
import { connectBroker } from '../../broker/src/client.js';
import { defaultDirectory } from '../../broker/src/local-state.js';
import type { RpcPeer } from '../../transport-native/src/rpc.js';
import { ScreenshotRegistry } from '../../vision-adapter/src/screenshots.js';

export const name = 'dsh-native-browser';
export const inject = ['tools', 'connection'];
export const projectStatus = Object.freeze({ phase: 'development-preview', browser: 'chrome', toolsRegistered: true });

interface Execution { name: string; callId: string; signal: AbortSignal; agent?: { session: { id: string } } }
interface Context {
  tools: { register(definition: any): void };
  on(event: string, listener: (...args: any[]) => any): void;
  effect(callback: () => () => void | Promise<void>): void;
  get?(service: string): any;
}
type ApprovalMode = 'per-action' | 'per-lease' | 'trusted' | 'personal';
type Config = { runtimeDirectory?: string; approvalMode?: ApprovalMode; trustedOrigins?: string[] };
type TurnScope = { sessionId: string; wireSessionId: string; controller: AbortController };
type PendingCapture = { scope: TurnScope; leaseId: string; controller: AbortController; peer?: RpcPeer };
type BatchApproval = { scope: TurnScope; request: BatchRequest; exec: Execution; peer: RpcPeer; signal: AbortSignal; next: number };
const schemaString = { type: 'string' };
const tools = new Set(['browser_list', 'browser_claim', 'browser_observe', 'browser_read_page', 'browser_frames', 'browser_act', 'browser_batch', 'browser_handoff', 'browser_screenshot']);

/** Uses the public raw ToolDefinition seam. No DSH internal module imports. */
export function apply(ctx: Context, config: Config = {}): void {
  const approvalMode = config.approvalMode ?? 'per-action';
  if (!['per-action', 'per-lease', 'trusted', 'personal'].includes(approvalMode)) {
    throw new BrowserError('INVALID_REQUEST', 'approvalMode must be per-action, per-lease, trusted or personal');
  }
  if (config.trustedOrigins !== undefined && (!Array.isArray(config.trustedOrigins) || config.trustedOrigins.length > 64)) {
    throw new BrowserError('INVALID_REQUEST', 'trustedOrigins must be an array of at most 64 exact origins');
  }
  const trustedOrigins = new Set((config.trustedOrigins ?? []).map(value => originOf(string(value, 8192))));
  if (approvalMode === 'trusted' && trustedOrigins.size === 0) {
    throw new BrowserError('INVALID_REQUEST', 'trusted approval mode requires at least one exact trustedOrigins entry');
  }
  if (approvalMode === 'personal' && trustedOrigins.size !== 0) {
    throw new BrowserError('INVALID_REQUEST', 'personal approval mode uses explicit tab consent, not trustedOrigins');
  }
  // Private recovery capability survives a Broker reconnect, never grants a lease or reaches the model.
  const journalKey = randomBytes(32).toString('hex');
  let connection: Promise<RpcPeer> | undefined;
  let disposed = false;
  const sessions = new Map<string, TurnScope>();
  const executions = new WeakMap<Execution, TurnScope>();
  const screenshots = new ScreenshotRegistry();
  const captures = new Set<PendingCapture>();
  const batchApprovals = new Map<string, BatchApproval>();
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
        value.handle(async (method, raw, remoteSignal) => {
          if (method !== 'browser.approveBatchStep') throw new BrowserError('POLICY_DENIED', 'Unexpected Broker request');
          const p = record(raw), pending = batchApprovals.get(string(p.approvalId, 128));
          if (Object.keys(p).some(key => !['approvalId', 'index'].includes(key)) || !pending || pending.peer !== value
            || connection !== attempt || !Number.isInteger(p.index) || p.index !== pending.next || pending.next >= pending.request.steps.length)
            throw new BrowserError('POLICY_DENIED', 'No matching active batch approval');
          const signal = AbortSignal.any([pending.signal, remoteSignal, pending.scope.controller.signal]);
          checkAbort(signal);
          const index = pending.next++; // A lost/duplicate approval request cannot consume another grant.
          if (approvalMode !== 'per-action') return { allowed: true };
          const approval = ctx.get?.('approval');
          if (typeof approval?.request !== 'function') return { allowed: false };
          const step = pending.request.steps[index]!;
          const digest = createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 16);
          // The existing Host callId exposes immutable full batch arguments. Avoid
          // duplicating input text/page data into the approval reason's audit log.
          const decision = await approval.request({ agent: pending.exec.agent, toolName: 'browser_batch', callId: pending.exec.callId,
            reason: `Approve only step ${index + 1}/${pending.request.steps.length}: ${step.action.kind}. Review that exact step in this call's batch arguments (digest ${digest}). Later steps require separate approval; completed effects cannot be rolled back.`, signal });
          checkAbort(signal);
          if (decision === 'cancelled') throw new BrowserError('CANCELLED', 'Batch step approval was cancelled');
          return { allowed: decision === 'allowed-once' };
        });
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
  const publicLease = (raw: unknown) => {
    const lease = record(raw), leaseId = string(lease.id);
    if (typeof lease.expiresAt !== 'number' || !Number.isFinite(lease.expiresAt)) {
      throw new BrowserError('INTERNAL_ERROR', 'Broker returned an invalid lease expiry');
    }
    // The provider token and wire-session owner are internal capabilities. Besides
    // reducing exposure, a single explicit leaseId prevents models from confusing
    // the provider token with the public ID expected by every subsequent tool.
    const scope = lease.scope === undefined ? 'origin' : lease.scope;
    if (scope !== 'origin' && scope !== 'tab') throw new BrowserError('INTERNAL_ERROR', 'Broker returned an invalid lease scope');
    return { leaseId, id: leaseId, tab: string(lease.tab), instanceId: string(lease.instanceId),
      origin: string(lease.origin), scope, expiresAt: lease.expiresAt };
  };
  const claim = async (args: Record<string, unknown>, exec: Execution) => {
    const instanceId = string(args.instanceId), tab = string(args.tab);
    if (approvalMode === 'trusted') {
      const listed = await run('browser.tabs', { instanceId }, exec);
      if (!Array.isArray(listed) || listed.length > 10_000) throw new BrowserError('INTERNAL_ERROR', 'Broker returned an invalid tab list');
      const candidate = listed.find(raw => {
        try { const value = record(raw); return string(value.id) === tab && string(value.instanceId) === instanceId; }
        catch { return false; }
      });
      if (!candidate || !trustedOrigins.has(originOf(string(record(candidate).url, 8192)))) {
        throw new BrowserError('POLICY_DENIED', 'Trusted mode only controls tabs on an exact configured trusted origin');
      }
    }
    const raw = await run('browser.claim', { instanceId, tab }, exec);
    const lease = publicLease(raw);
    if (approvalMode === 'personal' && lease.scope !== 'tab') {
      await run('browser.release', { leaseId: lease.leaseId }, exec).catch(() => {});
      throw new BrowserError('POLICY_DENIED', 'Personal approval mode requires a Broker started with --access-mode=personal');
    }
    if (approvalMode === 'trusted' && !trustedOrigins.has(originOf(lease.origin))) {
      // Close a tab that changed origins between inventory and grant before the
      // capability can be returned to the model.
      await run('browser.release', { leaseId: lease.leaseId }, exec).catch(() => {});
      throw new BrowserError('POLICY_DENIED', 'Claimed tab left the configured trusted origin');
    }
    return lease;
  };
  const releaseScope = (sessionId: string, message: string) => {
    const scope = sessions.get(sessionId);
    if (!scope) return false;
    // Abort synchronously before the asynchronous Broker release. Any command
    // already dispatched remains non-replayable; commands still waiting at an
    // approval, socket, queue or provider fence cannot cross this boundary.
    scope.controller.abort(new BrowserError('LEASE_REVOKED', message));
    screenshots.revokeOwner(scope.wireSessionId);
    sessions.delete(sessionId);
    void connection?.then(p => p.call('browser.releaseSession', { sessionId: scope.wireSessionId }, AbortSignal.timeout(3000))).catch(() => {});
    return true;
  };
  const releaseBackgroundScopes = (foregroundSessionId: string | null) => {
    let released = 0;
    for (const sessionId of [...sessions.keys()]) {
      if (sessionId !== foregroundSessionId && releaseScope(sessionId, 'Browser control moved to another foreground DSH conversation')) released++;
    }
    return released;
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
  register('browser_claim', 'Request exclusive control of one user-authorized tab under the configured approval policy; preserve existing user pages. scope=origin is exact-site authority; scope=tab is returned only by the explicit personal Broker and follows that same allowed tab across HTTP(S) root navigations. Use the returned leaseId (not any other field) as leaseId for every later browser tool. Internal capability tokens are never exposed.',
    { instanceId: schemaString, tab: schemaString }, ['instanceId', 'tab'], claim);
  register('browser_observe', 'Read bounded, untrusted AX text, controls and named regions. Optional rootRef reads only that known subtree. Optional query finds an EXACT case-sensitive accessible name and optional role, beyond the default discovery bounds; combine rootRef to restrict the search. It returns candidates, never chooses or clicks a match: duplicate names require contextual disambiguation, not picking the first. Repeat query/rootRef on each scoped call; query results and subtrees are not whole pages. A generic node marked editable:true is an observed editing host, not an invented textbox role; use its exact ref for fill/append/press. kind=region refs are read roots/scroll targets, not click/fill/append/press targets. Omit cursor for a full view; use its cursor for exact-base changes. delta contains node upsert/remove, optional order and text splice; full replaces your bounded view. resyncRequired means changed/missing base, document or scope. Use current documentEpoch/refs; truncated means incomplete. Optional frame:{frameId,documentEpoch} explicitly reads one current child from browser_frames. The target and ALL ancestors must share the leased origin; foreign/opaque frames are denied. Repeat frame on each cursor call; changed epochs require fresh discovery. Frame views have separate node identities and delta scopes; use their refs/epochs only with explicit browser_act frame for supported child clicks; use browser_read_page with the same explicit frame for live windows. Combine frame with query for exact-name/optional-role lookup only in that child document, including controls omitted from its default view. Query deltas are scoped to both frame and filters. Repeat frame and query with the cursor. Combine frame with a rootRef observed in that child for a local subtree or contextual query. Repeat frame/rootRef/query with cursors. A removed, replaced or wrong-document root fails; it never widens to the whole frame. Regex, substring and cross-frame search remain unsupported.',
    { leaseId: schemaString, cursor: schemaString, rootRef: schemaString,
      frame: { type: 'object', properties: { frameId: { type: 'string', minLength: 1, maxLength: 128 },
        documentEpoch: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['frameId', 'documentEpoch'], additionalProperties: false },
      query: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 1000 },
        role: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z][A-Za-z0-9]*$' } }, required: ['name'], additionalProperties: false } },
    ['leaseId'], (args, exec) => run('browser.observe', {
      leaseId: string(args.leaseId), ...observeOptions(args),
    }, exec));
  register('browser_read_page', 'Read the next bounded live AX window of the authorized document or one known rootRef. Omit continuation to start; repeat the exact rootRef and use page.continuation for the next window. Tokens are single-use, expire after two minutes and do not grant authority. Missing token means traversal ended; page.incomplete means some content was omitted (e.g. frame/depth/oversize boundaries), even at the end. A window is NOT a full snapshot or delta: accumulate distinct windows explicitly, never replace a full-page baseline with one. Structure changes on the active traversal path, navigation, Stop, changed scope, expiry or token reuse fail closed. Earlier windows are historical, not an atomic page snapshot; already-visited branches may change between reads. Only current DOM content is traversed: virtualized/unmounted items require separately approved scrolling. Narrow rootRef on capacity errors. Optional frame:{frameId,documentEpoch} reads one currently discovered same-origin child, optionally narrowed by its own rootRef. Repeat the exact frame and rootRef with each continuation. All ancestors must share the lease origin. Child windows use the child document epoch and refs, with no fallback to the root. No automatic scrolling, cross-origin access, query mixing or input. Existing refs can age/leave the bounded ref cache; re-observe exact targets before actions.',
    { leaseId: schemaString, rootRef: schemaString, continuation: schemaString,
      frame: { type: 'object', properties: { frameId: { type: 'string', minLength: 1, maxLength: 128 },
        documentEpoch: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['frameId', 'documentEpoch'], additionalProperties: false } }, ['leaseId'], (args, exec) =>
      run('browser.readPage', { leaseId: string(args.leaseId), options: pageReadOptions({
        ...(args.frame === undefined ? {} : { frame: args.frame }),
        ...(args.rootRef === undefined ? {} : { rootRef: args.rootRef }),
        ...(args.continuation === undefined ? {} : { continuation: args.continuation }) }) }, exec));
  register('browser_frames', 'Discover bounded frame structure in an authorized tab: opaque frame IDs, parent relationships, document epochs and origins only. No child page text, titles, URL paths/queries, raw CDP sessions or execution contexts are returned. contextStatus=known means a context was observed, NOT permission to access it. originRelation is relative to the authorized root. truncated/unavailable means incomplete evidence. Frame IDs are not node refs and cannot be used for browser_act or rootRef. Explicit browser_observe frame reads support only a same-origin ancestor chain. Same-origin child clicks require explicit browser_act frame and fresh observed child refs; discovery alone never grants input or cross-origin screenshot permission.',
    { leaseId: schemaString }, ['leaseId'], (args, exec) => run('browser.frames', { leaseId: string(args.leaseId) }, exec));
  const expected = { oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'value' }, value: schemaString }, required: ['kind', 'value'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'url' }, url: schemaString }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'text' }, text: schemaString }, required: ['kind', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'state' }, ref: { type: 'string', minLength: 1, maxLength: 128 },
      state: { type: 'string', enum: elementStates } }, required: ['kind', 'ref', 'state'], additionalProperties: false },
  ] };
  const action = { oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'check' }, ref: schemaString, checked: { type: 'boolean' },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'ref', 'checked'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'click' }, ref: schemaString, expected }, required: ['kind', 'ref'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'fill' }, ref: schemaString, text: schemaString, expected }, required: ['kind', 'ref', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'append' }, ref: schemaString, text: { type: 'string', maxLength: 10000 }, expected }, required: ['kind', 'ref', 'text'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'press' }, ref: schemaString,
      key: { type: 'string', enum: browserKeys }, shift: { type: 'boolean' }, expected }, required: ['kind', 'ref', 'key'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'navigate' }, url: schemaString, expected: { oneOf: expected.oneOf.slice(1, 3) } }, required: ['kind', 'url'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'scroll' }, ref: schemaString,
      deltaX: { type: 'integer', minimum: -10000, maximum: 10000 }, deltaY: { type: 'integer', minimum: -10000, maximum: 10000 },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'deltaX', 'deltaY'], additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'wheel' }, ref: schemaString,
      deltaX: { type: 'integer', minimum: -10000, maximum: 10000 }, deltaY: { type: 'integer', minimum: -10000, maximum: 10000 },
      expected: { oneOf: expected.oneOf.slice(1) } }, required: ['kind', 'ref', 'deltaX', 'deltaY'], additionalProperties: false },
  ] };
  register('browser_act', 'Perform one approved click/fill/append/press/scroll/wheel/check or HTTP(S) navigation. Navigation stays on the exact lease origin by default; only an explicit scope=tab personal lease may cross root-page origins. Fill replaces all text in a visible input/textarea or bounded contenteditable editing host (including plaintext-only and generic nodes marked editable:true); it can remove rich formatting. Append instead adds only the provided suffix at the end of a supported input/textarea or editing host, preserving the existing prefix; it is not arbitrary-caret typing or a full refill. It binds the current prefix after actionability and refuses changes before insertion, verifies the whole combined value, respects native maxlength and no-ops on an empty suffix. Combined text is limited to 10000 UTF-16 units. Protected/nested editing islands, password entry and IME composition are unsupported. Contenteditable always verifies the full logical text; an explicit value expectation must equal the final text (including the prefix for append). Check sets a checkbox/switch boolean state, or selects a native radio with checked:true (never false); select another radio to change the group choice. Check does nothing if already correct and verifies after at most one click; it is not an input value. Press uses a focused control; Enter/Space may submit it. Scroll directly changes DOM scroll offsets on the document (no ref) or one known element (ref, including a region), returning measured before/after offsets; no movement stays unknown. Wheel instead sends one real, unmodified CSS-pixel wheel sample at a verified point on the required control/region ref, for wheel-driven interfaces. It may trigger handlers or scroll ancestors, not necessarily the named element. Deltas are not proof of movement. Use a text/URL postcondition for verified wheel feedback; absent one, outcome stays unknown and the immediate observation may precede the wheel effect. No browser/OS shortcuts. Use fresh node IDs, a unique requestId and optional value/URL/text postcondition (no value for scroll/wheel). State postconditions use {kind:state,ref,state} on an already observed connected node: attached/detached/visible/hidden/enabled/disabled/checked/unchecked. The original node is bound before input and rechecked after observation; a same-name replacement never inherits it. Hidden includes detachment, visible means nonempty visible layout (not viewport or hit-test); opacity:0 still counts as visible. Detaching the original does not prove all lookalikes/dialogs are absent. State means final condition, not proof of a transition or business causation. State expectations cannot cross navigation. Browser steps share a deadline. RECOVERY_REQUIRED returns historical metadata only, not current success or restored control. Unknown means DO NOT blindly retry with a new request ID; regain approved control and observe first. Optional frame:{frameId,documentEpoch} selects one observed same-origin child; top-level documentEpoch must equal that child epoch. Currently frame supports click with optional child-text expectation only, not fill/check/press/scroll/wheel/navigation or URL/value/state expectations. All ancestors must share the leased origin and currently one Chromium process. Missing frame never infers a child from a ref. Frame results contain a fresh bounded view of that child, not the root page.',
    { requestId: schemaString, leaseId: schemaString, documentEpoch: schemaString, action, timeoutMs: { type: 'integer' },
      frame:{type:'object',properties:{frameId:{type:'string',minLength:1,maxLength:128},documentEpoch:{type:'string',minLength:1,maxLength:512}},required:['frameId','documentEpoch'],additionalProperties:false} },
    ['requestId', 'leaseId', 'documentEpoch', 'action'], (args, exec) => run('browser.act', { request: actionRequest(args) }, exec));
  register('browser_batch', 'Perform 1-8 explicit browser actions in order with one shared deadline (maximum/default 30000 ms). Each step separately requests user approval and checks current lease, origin, target, actionability and postcondition. This is not a script, blanket approval or atomic transaction: completed side effects are never rolled back. Supply only current known refs from the initial document. Explicit navigation is allowed only as the last step; unexpected document replacement stops remaining steps. A failed, cancelled, unknown or unverified step stops the batch. Use postconditions for click/press/wheel to permit continuation. The result lists attempted/notRun steps with metadata and only the last attempted step observation, not intermediate page payloads. Same requestId deduplicates the WHOLE batch including unfinished steps; never generate a new ID to blindly resume. RECOVERY_REQUIRED contains historical metadata, not current success, restored authority or a resumable plan. Steps omitted during recovery mean their past progress is unknown. The batch occupies one tab queue slot while awaiting step approvals; Stop/handoff can interrupt it. No model JavaScript, newly-created-ref variables, file operations or cross-origin authority expansion.',
    { requestId: { type: 'string', minLength: 1, maxLength: 128 }, leaseId: schemaString, documentEpoch: schemaString,
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
      steps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { action,
        timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, required: ['action'], additionalProperties: false } } },
    ['requestId', 'leaseId', 'documentEpoch', 'steps'], async (args, exec) => {
      const request = batchRequest(args), { scope, signal: owningSignal } = executionScope(exec);
      if (batchApprovals.size >= 8) throw new BrowserError('QUEUE_FULL', 'Too many active batch approval contexts');
      const deadline = new AbortController(), approvalId = randomUUID();
      const timer = setTimeout(() => deadline.abort(new BrowserError('DEADLINE_EXCEEDED', 'Batch deadline exceeded')), request.timeoutMs ?? 30000);
      timer.unref();
      const signal = AbortSignal.any([owningSignal, deadline.signal]);
      try {
        const channel = await peer(); checkAbort(signal);
        // Recheck after connection setup because concurrent executions may have entered meanwhile.
        if (batchApprovals.size >= 8) throw new BrowserError('QUEUE_FULL', 'Too many active batch approval contexts');
        batchApprovals.set(approvalId, { scope, request, exec, peer: channel, signal, next: 0 });
        return await channel.call('browser.batch', { request, approvalId, sessionId: scope.wireSessionId }, signal);
      } finally { clearTimeout(timer); batchApprovals.delete(approvalId); }
    });
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
          redaction: shot.redaction,
          viewport: screenshot.viewport, coordinateSpace: screenshot.coordinateSpace,
          imageToViewport: screenshot.imageToViewport, screenshot };
      } finally { captures.delete(capture); }
    },
  });

  const connectionService = ctx.get?.('connection');
  if (typeof connectionService?.rpc?.handle !== 'function') {
    throw new BrowserError('UNSUPPORTED_CAPABILITY', 'DSH Connection RPC is required for foreground conversation handoff');
  }
  const clientRevisions = new Map<string, number>();
  let latestIssuedAt = 0;
  ctx.effect(() => connectionService.rpc.handle('/dsh-native-browser', async (endpoint: string, raw: unknown, signal: AbortSignal) => {
    checkAbort(signal);
    if (endpoint !== 'foreground') return { ok: false, error: { code: 'gateway/not-found', message: 'Unknown browser endpoint', details: {} } };
    const p = record(raw);
    if (Object.keys(p).some(key => !['clientId', 'revision', 'issuedAt', 'sessionId'].includes(key))
      || typeof p.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.clientId)
      || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1
      || !Number.isSafeInteger(p.issuedAt) || Math.abs(Date.now() - Number(p.issuedAt)) > 5 * 60_000
      || !(p.sessionId === null || (typeof p.sessionId === 'string' && p.sessionId.length >= 1 && p.sessionId.length <= 1024))) {
      return { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid foreground conversation update', details: {} } };
    }
    const clientId = p.clientId, revision = Number(p.revision), issuedAt = Number(p.issuedAt);
    const previousRevision = clientRevisions.get(clientId) ?? 0;
    if (revision <= previousRevision || issuedAt < latestIssuedAt) {
      return { ok: true, value: { accepted: false, released: 0 } };
    }
    clientRevisions.delete(clientId); clientRevisions.set(clientId, revision);
    while (clientRevisions.size > 64) clientRevisions.delete(clientRevisions.keys().next().value!);
    latestIssuedAt = Math.max(latestIssuedAt, issuedAt);
    const released = releaseBackgroundScopes(p.sessionId as string | null);
    return { ok: true, value: { accepted: true, released } };
  }, { authority: 'trusted-host' }));

  ctx.on('tools/pre-execute', (exec: Execution, next: () => unknown) => {
    if (!tools.has(exec.name)) return next();
    if (!exec.agent?.session.id) return { kind: 'deny', reason: 'Browser tools require an owning DSH session.' };
    if (disposed) return { kind: 'deny', reason: 'Browser plugin has been disposed.' };
    bind(exec);
    if ((approvalMode === 'per-action' && (exec.name === 'browser_claim' || exec.name === 'browser_act' || exec.name === 'browser_screenshot'))
      || (approvalMode === 'per-lease' && exec.name === 'browser_claim')) {
      return { kind: 'ask', reason: 'Allow this browser control action on the selected signed-in page?' };
    }
    return next();
  });
  // Personal mode keeps a short-lived lease across turns in the same conversation.
  // Foreground switching, Session disposal, expiry and Stop remain hard boundaries.
  ctx.on('session/event', (session: { id: string }, event: { type: string }) => {
    if (event.type !== 'turn/end') return;
    if (approvalMode === 'personal') return;
    releaseScope(session.id, 'The owning DSH turn ended');
  });
  ctx.on('session/disposed', (session: { id: string }) => { releaseScope(session.id, 'The owning DSH conversation was disposed'); });
  ctx.effect(() => () => {
    disposed = true;
    for (const scope of sessions.values()) scope.controller.abort(new BrowserError('LEASE_REVOKED', 'Browser plugin disposed'));
    void connection?.then(p => p.close()).catch(() => {});
    sessions.clear();
    screenshots.clear();
  });
}
