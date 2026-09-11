# Native browser protocol draft

Status: design draft; no compatibility guarantee before `0.1.0-beta.1`.

## Goals

The protocol connects one DSH runtime to one installed Chrome extension through a local native host. It must survive extension service-worker restarts, native-host reconnects, DSH cancellation and Chrome tab churn without confusing ownership.

## Envelope

Every logical message uses this envelope before Native Messaging framing:

```json
{
  "protocol": 1,
  "kind": "request",
  "id": "01J...",
  "session": "opaque-session-id",
  "epoch": 7,
  "method": "tab.observe",
  "params": {}
}
```

`kind` is `hello`, `welcome`, `request`, `response`, `event`, `cancel` or `goodbye`. IDs are unique within an epoch. Every response repeats the request ID. Events carry monotonically increasing sequence numbers so the runtime can detect gaps.

## Handshake

The native host and extension exchange:

- implementation name and semantic version;
- minimum and maximum supported protocol version;
- random connection nonce and authenticated peer proof;
- Chrome version, extension instance and profile-scoped instance identifier;
- capability flags, including supported CDP domains and screenshot formats;
- new connection epoch.

No tab handle from a previous epoch is accepted. Reconnect recovery asks the runtime which leases remain desired, then revalidates each against current Chrome state.

## Core requests

Initial vertical slice:

- `browser.status`
- `tab.listCandidates`
- `tab.claim`
- `tab.create`
- `tab.navigate`
- `tab.observe`
- `tab.click`
- `tab.type`
- `tab.release`
- `operation.cancel`

Next slices add selection, check, scroll, wait, screenshot, dialog, download, file chooser, history and tab grouping.

## Identity and freshness

Three independent values prevent confused-deputy actions:

- `epoch` invalidates every handle after transport reconnection;
- `lease` proves the DSH session owns the tab;
- `generation` binds element refs to a known observation lineage.

The extension never accepts a raw Chrome tab ID as authorization. Claiming an existing tab requires a candidate token returned by the immediately preceding `tab.listCandidates` call and an exact title/URL match.

## Response shape

Successful responses carry `result`. Failures carry a stable code, message safe for model context, retryability and optional current observation:

```json
{
  "protocol": 1,
  "kind": "response",
  "id": "01J...",
  "session": "opaque-session-id",
  "epoch": 7,
  "ok": false,
  "error": {
    "code": "STALE_TARGET",
    "message": "The page changed after this element was observed.",
    "retryable": true,
    "observation": {}
  }
}
```

Internal stack traces, cookies, request headers, native paths and page secrets never enter the model-safe message. Diagnostic detail goes to a separate redacted local log.

## Events

The extension may emit:

- `connection.changed`
- `tab.updated`
- `tab.closed`
- `tab.detached`
- `observation.diff`
- `navigation.started|committed|settled`
- `dialog.opened`
- `download.started|finished`
- `human.intervened`
- `handoff.resumed`
- `protocol.gap`

Events include sequence and epoch. A gap forces resynchronization; it is never papered over with inferred state.

## Cancellation

Every request that can wait carries an operation ID. DSH cancellation sends `cancel`, and the extension/native host stop timers, CDP waits and result collection. A late response after cancellation is discarded by ID and epoch.

## Native Messaging limits

Messages are length-prefixed UTF-8 JSON. Large screenshots and snapshots are chunked at the logical protocol layer with per-chunk checksums and total-size ceilings. The protocol does not rely on implementation-specific behavior near Chrome's message-size limits.

## Versioning

Adding optional fields or new methods is backward-compatible. Changing meaning, removing fields or weakening identity checks requires a new protocol major. Handshake selects the highest mutually supported major and rejects an empty intersection with `VERSION_MISMATCH`.
