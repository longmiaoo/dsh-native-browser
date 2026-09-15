# Native browser development protocol v1

Status: implemented development-preview contract, not a stable compatibility promise. Upgrade the DSH plugin/Broker, Native Host and extension together. The [v2 product plan](plans/browser-runtime-plan-v2.zh-CN.md) includes further lifecycle, framing and compatibility work; this document describes current behavior, not completion of that plan.

## Source of truth

`packages/contracts/src/wire.ts` defines the envelope, hello and welcome schemas and the small validator shared by Node and MV3. `protocol/v1.schema.json` is generated from it. Its root validates envelopes; `$defs.hello` and `$defs.welcome` validate handshake payloads separately. Envelope validation does **not** validate method payloads, authenticate senders or authorize input.

```sh
pnpm build
node scripts/wire-schema.mjs --write  # explicitly regenerate after a contract change
node scripts/wire-schema.mjs         # read-only drift check
pnpm test                           # includes published-schema equality
```

Tests compare the shared validator with [Ajv's draft-2020-12 validator](https://ajv.js.org/json-schema.html#draft-2020-12-breaking) on golden envelopes and over 1,000 deterministic field mutations. Ajv is development-only, not bundled into the extension. The portable interpreter supports only the vocabulary used by this contract, not arbitrary JSON Schema. Method payloads continue to be checked by Broker/runtime/provider/extension boundaries; full declarative method schemas remain future work.

## Envelopes

These are the only five shapes. All displayed fields are required; extra envelope fields are rejected.

```json
{"type":"request","id":"r1","method":"browser.instances","params":{}}
{"type":"response","id":"r1","ok":true,"value":[]}
{"type":"response","id":"r2","ok":false,"code":"STALE_TARGET"}
{"type":"event","event":"page.changed","value":{"tab":"instance:7","leaseId":"lease","sequence":1}}
{"type":"cancel","id":"r2"}
```

IDs are nonempty strings of at most 128 Unicode code points. Method/event names match ASCII pattern `[A-Za-z][A-Za-z0-9_.:-]*`, at most 128 characters. Request `params` is an object. Success/event `value` may contain any JSON value; void results become explicit `null`. Error responses carry only a shared `errorCodes` code, not foreign messages, stacks or payloads. Receivers construct fixed local error text.

There are no `kind`, `protocol`, `session`, `epoch`, `result` or `error` envelope fields. `hello` is an ordinary request; its success response is the welcome. There is no wire `goodbye`.

## Authenticated hello

The extension connects through Native Messaging. Its first message must be a provider hello. The Native Host checks the Chrome-supplied caller origin against the installed allowlist, validates hello shape/role, then injects the private IPC token before forwarding. The token is not embedded in the extension or returned in the welcome. The local DSH client reads that token from private runtime state and sends it directly over the Unix socket.

Client hello payload (placeholder token):

```json
{
  "bootstrap":1,"versions":[1],"role":"client","token":"<private IPC token>",
  "journalKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "requiredCapabilities":["runtime.v1","observe.query.v1","journal.recovery.v1","runtime.check.v1","runtime.wheel.v1","runtime.radio.v1","runtime.capture-publication.v1","runtime.contenteditable-fill.v1","runtime.append.v1","runtime.element-state.v1","runtime.batch.v1","runtime.page.v1","runtime.frames.v1","observe.frame.v1","runtime.frame-click.v1","observe.frame-query.v1","observe.frame-subtree.v1","observe.frame-page.v1"]
}
```

Provider hello payload before token injection:

```json
{
  "bootstrap":1,"versions":[1],"role":"provider",
  "capabilities":["lease.fencing.v1","ax.read.v1","ax.find.v1","input.named-keys.v1","scroll.dom.v1","ax.checked-state.v1","input.wheel.v1","input.radio.v1","ax.editable-state.v1","ax.page.v1","frame.sessions.v1","ax.frame.v1","input.frame-click.v1","ax.frame-find.v1","ax.frame-subtree.v1","ax.frame-page.v1","ax.frame-text.v1"],
  "requiredCapabilities":["runtime.v1","provider.ax-read.v1","provider.ax-find.v1"],
  "instance":{"id":"opaque-instance","family":"chromium","brand":"chrome","version":"browser user agent","profileLabel":"User-authorized profile"}
}
```

Welcome payload:

```json
{
  "version":1,"connectionEpoch":"opaque-new-connection",
  "capabilities":["runtime.v1","observe.query.v1","journal.recovery.v1","provider.ax-read.v1","provider.ax-find.v1","runtime.check.v1","runtime.wheel.v1","runtime.radio.v1","runtime.capture-publication.v1","runtime.contenteditable-fill.v1","runtime.append.v1","runtime.element-state.v1","runtime.batch.v1","runtime.page.v1","runtime.frames.v1","observe.frame.v1","runtime.frame-click.v1","observe.frame-query.v1","observe.frame-subtree.v1","observe.frame-page.v1"]
}
```

The Broker authenticates first, then validates and negotiates before registering a provider or accepting runtime commands. Only wire version 1 is implemented: an offer must include it. Bootstrap is separately fixed at 1. Version lists can advertise other majors without implying their implementation. Lists permit at most eight unique positive version integers and 64 unique capability names.

Both roles may declare `requiredCapabilities`; the Broker must support every requested capability. This Broker additionally requires all provider capabilities above. Old providers lacking bounded AX reads/search or fencing fail before registration. Unknown optional advertisements are tolerated; unknown requirements fail with `PROTOCOL_MISMATCH`. Current clients and extensions validate the welcome before use. Missing requirements are not silently downgraded to a less safe action path.

A legacy client may omit requirements and `journalKey`; it then has only connection-local recovery isolation. Current clients send both. Schema-valid hello rejection returns a code; the Broker permits another hello only within its original three-second handshake window, with no runtime access after a failed hello. The extension closes on rejection, malformed welcome or its three-second welcome timeout, and accepts no operation before welcome. Reconnection requires explicit popup intent.

## Roles and implemented methods

`observe.frame-subtree.v1` / `ax.frame-subtree.v1` add `frame` + `rootRef` to `browser.observe`, optionally with `query`. The new optional portable method is `observeFrameSubtree`; `findFrame` receives an optional root-ref argument. Subtree scope is `{kind:'subtree',frameId,rootRef}`; contextual query scope is `{kind:'query',frameId,rootRef,query}`. Both retain the child `documentEpoch`. Scope equality and the public delta reducer include the frame and root, so old/other-region cursors cannot be applied silently. Missing provider support or stale roots never fall back to root-document or whole-frame reads.

Internal `ax.frame.subtree` accepts exact `{lease,request:{binding,root}}`; `ax.frame.find` adds optional `root` to its previous payload. `root` is `{backendNodeId,role,name,editable}`, derived only from the provider's current child ref cache. It has no caller-selected session/context/object/script fields; backend identity is positive, name is at most 1,000 UTF-16 units and editable is boolean. Source verifies document membership and current role/name/editor capability before and after acquisition, then filters candidates against the same composed root and current AX identity. Query and subtree reads share the private-object read/cleanup fence. [Workflow and resource limits](development.md#known-child-regions-and-contextual-queries).

`observe.frame-query.v1` / `ax.frame-find.v1` permit `browser.observe` with both `frame` and an exact `query`. The optional provider seam is `findFrame`; missing support never falls back to root search. The child epoch stays in `documentEpoch`; scope is `{kind:'query',frameId,query}` (not a whole-frame scope). These fields participate in normal delta/reducer scope validation. The newer scoped-read capability below adds `rootRef`; paging options remain unsupported.

Internal `ax.frame.find` accepts exact `{lease,request:{binding,query}}`, not caller DOM/session selectors. `binding` uses the five `ax.frame` fields. Source validation resolves the child document from frame-aware AX root evidence, verifies the corresponding DOM object, performs literal name/role lookup and verifies up to 128 candidates' document ownership and current object-bound AX identity. Private object groups and graph revisions are fenced through cleanup; runtime rechecks the current frame inventory before publication. Shared object-read scopes cap calls and resources but do not bound Chromium's raw name computation. [Source semantics and limits](development.md#exact-same-origin-child-queries).

`runtime.frame-click.v1` / `input.frame-click.v1` require matching runtime/extension builds for explicit child clicks. `browser.act` adds optional `frame:{frameId,documentEpoch}`, with the top-level epoch required to match that child. Only click/text expectations are allowed; portable provider method `actFrame` is optional and never falls back to root `act`. Authorization sees the explicit frame, and durable hashing includes it. Results use the child epoch and `scope:{kind:'frame',frameId}`. Root action and batch contracts do not infer frame scope.

Internal `frame.click.prepare` and `frame.click` accept exact `{lease,request:{binding,backendNodeId,role,name}}`. `binding` is the five-field `ax.frame` document/context binding; role/name come from the observed cached target, not a new search. Neither command accepts raw coordinates, object/session IDs or scripts. Preparation is read-only and returns `{acknowledged:false}`; click reacquires and revalidates the binding/semantic identity/geometry, sends one fenced pointer pair, cleans up and returns `{acknowledged:true}`. Provider dispatch intent is recorded before sending the latter command; missing/invalid replies or post-dispatch document changes remain uncertain and cannot trigger automatic replay. The child-only postcondition read is separate from that acknowledgement. See [workflow, recovery and limitations](development.md#explicit-same-origin-child-clicks).

For a nonblank child text expectation of at most 1,000 UTF-16 units, internal `ax.frame.text` accepts only `{lease,request:{binding,text}}` and returns exactly `{present:boolean}`. It queries the bound child document, then verifies up to 128 candidates' current document ownership and AX identity through the same private-object/revision fence as child queries. No candidate text, backend ID, session, object or script crosses the provider boundary. A negative result falls back to the ordinary bounded child observation so existing substring semantics remain available; longer/blank expectations use only that fallback. A positive predicate permits success while the returned action observation remains the exact frame scope required by the runtime cache—it is not relabeled as a query result.

| Direction | Methods | Authority / payload boundary |
|---|---|---|
| Client → Broker | `browser.instances` | Authenticated client |
| Client → Broker | `browser.tabs`, `browser.claim` | Connection-bound session, instance/tab identity, origin policy and popup approval |
| Client → Broker | `browser.observe`, `browser.capture`, `browser.act` | Owning session and live lease; actions additionally carry request ID and document epoch |
| Client → Broker | `browser.readPage` | `{sessionId,leaseId,options:{frame?,rootRef?,continuation?}}`; owning live lease/read policy; fresh bounded root or same-origin-child window, never a delta baseline |
| Client → Broker | `browser.frames` | `{sessionId,leaseId}`; same owner/read policy and tab queue; validated frame metadata, not child-content permission |
| Client → Broker | `browser.batch` | Same owner/lease/action boundaries; `{sessionId,request,approvalId}` with 1–8 explicit steps, shared deadline and whole-plan durable fence |
| Broker → Client request | `browser.approveBatchStep` | Exact `{approvalId,index}`; private active callback context, same connection/turn and strict next index; public DSH per-step approval, only `{allowed:true}` permits continuation |
| Client → Broker | `browser.validateLease` | Owning session/live lease, current tab/origin and read policy; returns only `{valid:true}`, never renews a lease or reads page content |
| Client → Broker | `browser.release`, `browser.releaseSession` | Calling connection's owner scope |
| Broker → Client event | `browser.lease-revoked` | Exact `{sessionId,leaseId}` on the owning connection only; no token, tab, origin or page data; advisory early cancellation, not an authority grant |
| Broker → extension | `tabs.list`, `lease.grant`, `lease.revoke` | Current instance, approved tab/origin and fencing token |
| Broker → extension | `ax.read`, `ax.find`, `ax.page`, `cdp` | Live lease/Stop gate; fixed AX requests or allowlisted CDP methods/parameter checks |
| Broker → extension | `frames.list` | Exact `{lease}`; lazy recursive iframe attachment, root-document fencing, source frame/session/context metadata only |
| Broker → extension | `ax.frame` | `{lease,binding:{frameId,loaderId,contextUniqueId,rootFrameId,rootLoaderId}}`; same-origin ancestor-chain policy and exact document/context revision fence, fixed bounded AX traversal only |
| Broker → extension | `ax.frame.page` | `{lease,request:{binding,root?,continuation?}}`; bound child document/semantic root, single-use scoped live-window state and normal traversal limits |
| Broker → extension | `ax.frame.text` | `{lease,request:{binding,text}}`; bounded child-only postcondition predicate returning `{present:boolean}` after candidate ownership/identity checks |
| Broker → extension (internal read seam) | `frame.geometry` | `{lease,request:{binding,backendNodeId}}`; same five-field binding as `ax.frame`, same-origin/same-process source-bound geometry only; returns `{point,local,depth}` after object cleanup, not an input ticket or public action; no caller session, object, script or point |

Providers cannot invoke client runtime methods. The Native Host relays messages; it is not a second runtime. Internal `cdp` is not a public DSH tool or arbitrary model-selected CDP interface. Public tools are documented in [development.md](development.md).

`runtime.capture-publication.v1` is required by current clients. A pending screenshot binds to its original Broker connection, owning turn and lease. Handoff cancels it locally; Broker events cancel it after remote Stop/release, and connection loss cannot silently reconnect the pending image. After Host canonicalization, the client calls `browser.validateLease` on that same connection before returning the result. Events may be delayed, so they are not the sole publication check. This rechecks authority, not document/geometry freshness or the Host's later result-publication pipeline. Existing historical Host images are not retracted.

`runtime.batch.v1` adds runtime-level orchestration, not an extension input API. An outer batch occupies one tab queue slot and reserves durable intent before its first child; each child retains its own intent and action verification. Public `batch:` request IDs are reserved for internal deterministic child fences. Any non-success/unverified result or non-final document change ends the plan. Whole-plan recovery never resumes skipped children. The adapter binds callbacks to the validated local plan rather than trusting a remote-supplied action description; the reverse callback carries no form text or page content. Capacity, approval-policy integration, partial-result semantics and recovery/downgrade limits are specified in [bounded action batches](development.md#bounded-action-batches).

`runtime.page.v1` and provider `ax.page.v1` add explicit live traversal windows. Internal `ax.page` accepts `{lease,request:{frameId,backendNodeId?,continuation?}}`; the extension checks the currently leased root frame/loader before and after source acquisition. Opaque single-use continuations are scoped to lease token/document/root and retain identities/offsets only, not page text. They are distinct from transport IDs, action IDs and observation-delta cursors. Reuse, expiry, changed scope/document or active traversal-path changes fail rather than resyncing to a broader read. Stop/release/disconnect/navigation invalidate state. See [live page windows](development.md#live-page-windows) for budgets, incomplete coverage, current-node rereads and the explicit non-atomic consistency model.

`observe.frame-page.v1` and provider `ax.frame-page.v1` extend the same public `browser.readPage` request with an exact `frame:{frameId,documentEpoch}`. The optional portable seam is `readFramePage`. Internal continuations additionally bind the five-field child document/context identity and optional provider-cached semantic root. Runtime requires the returned child epoch and exact frame/subtree scope, and neither source nor runtime falls back to the root document. See [bounded child windows](development.md#bounded-same-origin-child-page-windows).

## Identity, cancellation and replay

`observe.frame.v1` / `ax.frame.v1` add optional `frame:{frameId,documentEpoch}` to `browser.observe`, without a new public tool. The portable optional provider method is `observeFrame`; runtime requires both current inventory and that method. The newer `observe.frame-query.v1` and `observe.frame-subtree.v1` capabilities permit exact child queries and known-root scopes described above. Results use `scope:{kind:'frame',frameId}` and the child's epoch; normal delta/reducer scope checks apply. The root tab URL/title remain metadata, not the source of the child text. Full source identity stays internal. Current content authority permits only an exact same-origin ancestor chain; foreign/opaque ancestors and incomplete evidence fail before AX dispatch. [Read workflow and limitations](development.md#explicit-same-origin-frame-reads).

`runtime.frames.v1` / `frame.sessions.v1` require matching builds for the frame inventory and screenshot safety gate. Public `FrameInventory` contains `{tab,documentEpoch,truncated,frames}`; each frame has opaque `id`, optional `parentId/documentEpoch/origin`, `isMain`, `contextStatus: known|unavailable` and `originRelation: same-origin|cross-origin|opaque`. Runtime projects only these fields, recomputes origin relation, rejects URLs containing paths/queries, and validates one reachable authorized root without cycles. No AX/node-ref or observation-delta authority is granted. Internal source revision/session/context identities do not cross the public boundary. `frameDiscovery:true` is advertised separately from still-false `oopif` action support. [Budgets and current limitations](development.md#frame-discovery-foundation).

`connectionEpoch` is welcome metadata, **not** an authorization field repeated on each message. Authority combines the Broker's connection-bound owner, live lease/fencing token, popup approval, origin, document epoch and validated element identity. Reconnection creates a new extension instance and new authority; old leases are never restored automatically. Claiming does not yet implement the original draft's single-use candidate token/title-match protocol.

Transport IDs and action request IDs differ. Receivers remember accepted **transport** IDs throughout a connection, including completed requests. Reuse closes without dispatching twice. The retained set is capped at 10,000; reaching capacity closes rather than evicting identities and allowing replay. RPC allows 32 in-flight requests per direction; excess incoming RPC work returns `QUEUE_FULL`. The extension instead closes above its 32-operation limit. These are per-connection limits, not a global resource budget.

Broker-wide admission also defaults to 64 sockets (including unauthenticated peers), 16 providers, 64 live/reserved leases and 32 pending claims. Excess sockets close before handshake; provider/claim/lease capacity errors return `QUEUE_FULL` without evicting existing control. Connection lifecycle scopes are private runtime metadata, not another wire capability. Session release and disconnect cancel pre-grant claims as well as existing leases. See [development.md](development.md#connection-and-control-capacity) for cleanup behavior and remaining resource-budget limits.

Cancellation names a transport ID and aborts its receiver work. Local typed timeout/lease/Stop reasons survive the requesting RPC boundary; cancel frames do not serialize arbitrary reasons. Valid late replies with no pending RPC caller are ignored. The extension only originates hello, so unexpected responses after negotiation are protocol violations. Malformed envelopes close the peer and pending RPC callers receive `CONNECTION_LOST`.

Closing synchronously revokes control gates and aborts pending work before asynchronous debugger detach. Active close explicitly tears down: [Chrome does not fire onDisconnect on the port that calls disconnect](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-Port). Teardown is idempotent; old-port messages/delayed disconnects cannot revoke a new connection's grants.

This is not exactly-once browser input and does not roll back dispatched actions. Separately, the journal fences actions by request identity/payload, persists intent before dispatch, and conservatively reports unresolved historical execution. Reconnection must not automatically replay uncertain input. Recovery limitations remain in [implementation-progress.md](implementation-progress.md).

Completed full action payloads have a separate 128-entry/8 MiB/120-second cache. Evicting a payload does not evict its identity fence: an exact historical retry can return metadata-only `RECOVERY_REQUIRED` even on a live connection. A changed payload still conflicts. Lease release purges cached page data and late result delivery rechecks authority. See [action-result retention](development.md#action-result-retention); this is not automatic recovery or permission to replay with another ID.

## Events and freshness

Current extension events are `lease.revoked` (lease ID) and `page.changed` (tab, lease ID, per-lease sequence). Coalesced page-change hints contain no page content and wake current-state observation/waiting. They are not an authoritative DOM stream. Observation cursors/deltas have separate scope/freshness checks. There is no general resumable event stream, wire observation-diff stream or comprehensive event-gap recovery protocol. Dialog/download/handoff event families in the original design are not implemented.

## Framing and budgets

Host stdio and IPC use four-byte native-endian length-prefixed UTF-8 JSON. The decoder checks nonzero length before allocation, rejects malformed UTF-8/JSON and caps payloads at 1,048,575 bytes. Native Host stdout is exclusively protocol frames.

The extension caps serialized success responses at 900,000 bytes. RPC checks buffered output against 2 MiB before sending. AX projection and screenshot budgets constrain normal results earlier; oversize data fails rather than truncating JSON. There is currently **no logical chunking, blob stream, per-chunk checksum or resumable transfer**. Browser CDP allocations and every intermediate serialization allocation are not bounded by transport caps.

## Evolution and remaining work

Envelope and handshake objects reject unknown fields. Adding fields is not automatically backward-compatible: evolve using negotiated capabilities or an explicitly negotiated revision with tested migration. Current fixed-v1 negotiation is not a verified N/N-1 upgrade matrix.

Evidence includes schema/Ajv vectors, real Unix-socket handshake/role tests, a real Native Host child, MV3-bundle lifecycle tests, and isolated Chrome → Native Host → Broker → real DSH tools smoke. Remaining work includes declarative method schemas, richer capabilities, major-version evolution, interrupted upgrades, global limits, long-running soak tests and the plan's trace/deadline/event/blob extensions. These tests do not prove Codex-level latency or cross-site success rates.
