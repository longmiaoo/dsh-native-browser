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
  "requiredCapabilities":["runtime.v1","observe.query.v1","journal.recovery.v1","runtime.check.v1"]
}
```

Provider hello payload before token injection:

```json
{
  "bootstrap":1,"versions":[1],"role":"provider",
  "capabilities":["lease.fencing.v1","ax.read.v1","ax.find.v1","input.named-keys.v1","scroll.dom.v1","ax.checked-state.v1"],
  "requiredCapabilities":["runtime.v1","provider.ax-read.v1","provider.ax-find.v1"],
  "instance":{"id":"opaque-instance","family":"chromium","brand":"chrome","version":"browser user agent","profileLabel":"User-authorized profile"}
}
```

Welcome payload:

```json
{
  "version":1,"connectionEpoch":"opaque-new-connection",
  "capabilities":["runtime.v1","observe.query.v1","journal.recovery.v1","provider.ax-read.v1","provider.ax-find.v1","runtime.check.v1"]
}
```

The Broker authenticates first, then validates and negotiates before registering a provider or accepting runtime commands. Only wire version 1 is implemented: an offer must include it. Bootstrap is separately fixed at 1. Version lists can advertise other majors without implying their implementation. Lists permit at most eight unique positive version integers and 64 unique capability names.

Both roles may declare `requiredCapabilities`; the Broker must support every requested capability. This Broker additionally requires all six provider capabilities above. Old providers lacking bounded AX reads/search or fencing fail before registration. Unknown optional advertisements are tolerated; unknown requirements fail with `PROTOCOL_MISMATCH`. Current clients and extensions validate the welcome before use. Missing requirements are not silently downgraded to a less safe action path.

A legacy client may omit requirements and `journalKey`; it then has only connection-local recovery isolation. Current clients send both. Schema-valid hello rejection returns a code; the Broker permits another hello only within its original three-second handshake window, with no runtime access after a failed hello. The extension closes on rejection, malformed welcome or its three-second welcome timeout, and accepts no operation before welcome. Reconnection requires explicit popup intent.

## Roles and implemented methods

| Direction | Methods | Authority / payload boundary |
|---|---|---|
| Client → Broker | `browser.instances` | Authenticated client |
| Client → Broker | `browser.tabs`, `browser.claim` | Connection-bound session, instance/tab identity, origin policy and popup approval |
| Client → Broker | `browser.observe`, `browser.capture`, `browser.act` | Owning session and live lease; actions additionally carry request ID and document epoch |
| Client → Broker | `browser.release`, `browser.releaseSession` | Calling connection's owner scope |
| Broker → extension | `tabs.list`, `lease.grant`, `lease.revoke` | Current instance, approved tab/origin and fencing token |
| Broker → extension | `ax.read`, `ax.find`, `cdp` | Live lease/Stop gate; fixed AX requests or allowlisted CDP methods/parameter checks |

Providers cannot invoke client runtime methods. The Native Host relays messages; it is not a second runtime. Internal `cdp` is not a public DSH tool or arbitrary model-selected CDP interface. Public tools are documented in [development.md](development.md).

## Identity, cancellation and replay

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
