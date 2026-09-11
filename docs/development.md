# Development preview setup

This is an opt-in developer build, not a stable release. Do not use it for payments, destructive changes or unattended work on business accounts yet. No installation into the user's browser/profile is performed by `pnpm build` or the automated tests.

## Build and validate

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:chrome
```

Broker, Native Host and MV3 must come from the same development build. Handshake requirements now reject older peers missing bounded AX read/search support before tab control is granted. The [wire protocol](protocol.md) documents the actual envelope and current compatibility limits. After a deliberate contract edit, run `pnpm build && node scripts/wire-schema.mjs --write`; the standard tests fail if the published JSON Schema drifts. Ajv is a test-only dependency, not extension runtime code.

### Connection and control capacity

The default Broker admits at most 64 simultaneous sockets, including peers that have not authenticated. Excess connections are closed before allocating RPC decoders/handshake timers; existing peers are not evicted. A client may see `CONNECTION_LOST` because admission happens before a hello can be correlated. Closed sockets free their slots. Runtime defaults additionally cap connected browser providers at 16, live/reserved leases at 64 and pending claims at 32. Those limits fail with `QUEUE_FULL` before a new provider is registered or lease is granted; they never evict existing leases or replay input. Lower-limit tests exercise concurrent reservation and recovery after release. These are implementation defaults, not new end-user CLI configuration flags.

Claims have the runtime's shared 10-second default operation deadline. Session release cancels its pending claims as well as existing leases; client disconnect does the same for that connection's lifecycle scope. An explicit later claim can establish new authority, but a late old request cannot. Provider disconnect and runtime disposal also cancel outstanding claims. If a grant returns after its earlier release, revocation of the exact old token is attempted again; a disconnected or failing provider may not acknowledge cleanup. Cancellation does not reclaim a pending-claim slot until the underlying work settles: a non-cooperative provider cannot obtain unbounded new work by ignoring cancellation. Such a provider can still stall its occupied slots and cannot be forcibly interrupted by JavaScript; built-in RPC propagates cancellation/disconnection.

Broker cleanup no longer retains every historical session or a second historical lease-owner map. Only active/reserved leases and outstanding claims carry lifecycle scope, and provider Stop is checked against the runtime's current lease. Internal `resourceUsage()` returns counts for regression diagnostics; it is not a new unauthenticated or wire API. Tests cover expiration, churn, late authorization/grants, provider replacement and cross-connection isolation. This is not a process RSS guarantee or complete global budgeting: pending teardown, arbitrary provider allocations, OS socket backlog, renderer memory and long-running soak remain separate work. Completed action payloads have the independent cache budget described below.

`test:chrome` opens a fresh headless Chrome context on a loopback-only fixture, runs our ChromiumProvider and BrowserRuntime, verifies input and result state, captures evidence under `output/playwright`, and closes its browser. It does not exercise MV3/native messaging or your real profile. The standard tests separately exercise Native Host as a child process and the extension gate using a Chrome API test double.

To exercise the real MV3 extension in an isolated Chrome-for-Testing profile:

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing pnpm test:extension
```

This test loads the production extension bundle, triggers its toolbar action, uses the production popup authorization/Stop handlers, and executes real `chrome.debugger` commands. Only `connectNative` is replaced by an in-memory test bridge inside that temporary extension worker. The test does not install a Native Host or touch the user's Chrome profiles; it removes its own temporary profile after Chrome exits. It uses the experimental [Extensions.triggerAction test API](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-triggerAction) and requires a browser supporting it (verified with Chrome-for-Testing 151.0.7922.10). A regular Chrome executable may reject unpacked-extension test flags. This is **not** a substitute for a complete Native Messaging acceptance test.

Reports/screenshots are written to `output/playwright/chrome-smoke.*` and `output/playwright/mv3-smoke.*`. These reports identify the tested seam explicitly.

To exercise the assembled local stack with **real Native Messaging** and an installed DSH runtime:

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing \
  pnpm test:native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

This script writes the host manifest only into its newly created Chrome user-data directory's `NativeMessagingHosts` subdirectory. That location follows [Chromium's user-native-messaging path implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_paths.cc). Chrome itself starts the actual host launcher; the native API and transport are **not mocked**. The real DSH ToolRuntime calls the production plugin via a real Unix socket and an independent production Broker CLI child process. Its approval service returns controlled test answers, and it uses a temporary attachment store, not the user's DSH configuration.

The test verifies Chinese input, delayed-result waiting, screenshot attachment admission, different-session rejection, unknown-outcome deduplication, cancellation, popup Stop, turn/end cleanup, late approval rejection and Broker SIGKILL/restart/reconnect. It confirms a stale socket remains after the kill and that the replacement CLI reports recovery; the old request returns metadata rather than another click. It also verifies independent observation cursors, exact text-delta reconstruction, cursors from action results, Stop/reclaim invalidation and full resync after document navigation. Report and screenshot: `output/playwright/native-smoke.*`. Verified on macOS with Chrome-for-Testing 151.0.7922.10 and installed DSH 0.1.5-rc.1. It does not prove vision-model understanding, natural-language agent planning, existing business-account compatibility, or other OS/browser versions. The temporary profile, manifest, token and DSH test home are removed after the owned processes close.

The report's `toolScreenshot` points to the exact canonical image returned through DSH after input verification (`native-tool-screenshot.*`), with its SHA-256. This is distinct from the Playwright diagnostic `native-smoke.png` captured at the end, after navigation and handoff; that final diagnostic is not the image returned by the browser tool.

To check the actual installed DSH tool registry without loading user configuration or making a model call:

```bash
node scripts/smoke-dsh.mjs /absolute/path/to/node_modules/@deepseek-ai/dsh
```

This script uses a temporary Broker, fake browser, real DSH ToolRuntime and real local AttachmentStore. It checks schema registration, no-approval denial, approved claim/action, image content blocks and handoff. It does **not** prove that a model has understood an image.

## Explicit Chrome/profile setup

1. Build, open `chrome://extensions`, enable Developer mode and load unpacked `dist/extension/chrome`. Record the extension ID. Only install into the profile you intend to authorize.
2. Register the native host for that exact ID:

   ```bash
   node bin/dsh-native-browser.mjs install-host --browser=chrome --extension-id=<32-character-extension-id>
   ```

   This writes our host manifest under Chrome's current-user NativeMessagingHosts directory and a launcher/token under the private runtime directory. It does not modify any other extension manifest. Installation preflight, serialization, atomic file replacement and ordinary-failure rollback are described below. Keep the checkout path stable: the development launcher points to this build. Scoped host unregistration is available below; a signed, relocatable installer and complete package removal remain pending.

3. Start the local Broker, listing exact origins you intend to test:

   ```bash
   node bin/dsh-native-browser.mjs broker --allow-origin=http://127.0.0.1:18765
   ```

   With no allowed origins, the Broker denies page access. Origin ports matter. It does not auto-approve newly reached websites. Multiple `--allow-origin=` arguments are supported; this preview's list is fixed for the Broker lifetime.

4. In another terminal run `node scripts/dev-fixtures.mjs`, then open `http://127.0.0.1:18765/` in the selected Chrome profile. Open the extension popup and choose “允许当前标签页并连接”.
5. Run `node bin/dsh-native-browser.mjs doctor --browser=chrome --extension-id=<id>`. It reports installation and connection checks with actionable findings, as described below. Use `status` separately if you deliberately want raw connected-instance details.
6. Mount this local bundle in a dedicated DSH development profile using that DSH version's documented local-plugin mechanism. The plugin requires the `tools` service; `browser_screenshot` also requires `attachments`. Do not replace the user's production profile as part of a test.

All CLI commands accept `--runtime-dir=/absolute/private/directory`. When using a nondefault directory, the DSH plugin config must set `runtimeDirectory` to the same path. Directory permissions must be `0700`; the token, lock database and newly bound socket are `0600`. Startup now recovers an eligible stale socket while holding process-lifetime ownership, as described below. Do not manually remove the lock database or recovery journal to bypass a startup failure.

### Read-only installation diagnosis

`doctor --browser=chrome|edge --extension-id=<id>` returns versioned JSON containing `status`, individual `checks`, and connection counts. `ready` means the inspected local registration/paths and protocol check passed with a matching browser connected; it does **not** prove a tab lease, site permission, working DSH/model integration, or visual understanding. `attention` covers missing extension-ID evidence or no matching browser; `failed` covers installation, security or connection errors. Both non-ready states exit with code 1; ready exits with code 0.

The checks distinguish a missing runtime/token/manifest/socket, unsafe ownership/permissions/links, malformed or mismatched origin lists, wrong extension ID, unsupported launcher content, moved Node/CLI paths, authentication/protocol failure and a silent Broker. The socket connect, hello and instance query share a 1.5-second deadline. Local filesystem operations are bounded by file size, not cancellable wall-clock I/O; a stalled filesystem can still delay diagnosis.

Diagnostics never create installation files, launch a host/browser/Broker, change permissions, acquire ownership, read/open the SQLite lock database or action journal, repair state, claim a tab, or read page content. Only client hello and instance-list RPCs are sent. Output omits token/config contents, extension IDs, absolute local paths, URLs and profile/instance labels; counts and fixed messages are safe by construction, rather than redacting arbitrary remote error strings afterward. No diagnostic bundle is automatically exported. `status` retains its separate raw instance-list behavior and is not a redacted diagnostic export.

Runtime config/launcher/manifest reads reject symlinks, multiple hard links, unsafe modes and oversized files, and compare inode/size/modification evidence during bounded reads. Node's executable path may itself be a legitimate nvm-managed symlink: only file/access metadata is checked, never execution. The fixed shell launcher grammar is parsed without evaluation. The installed Node version/build dependencies and DSH configuration still require separate verification; presence is not compatibility proof. The CLI checks the selected brand's default current-user manifest location, or an explicitly supplied `--manifest-dir`; this is not automatic profile discovery or proof that a browser uses that directory. Enterprise policies, Windows registry, durable repair, full package removal and diagnostic UI remain unfinished. These are local Unix checks, not a security guarantee against hostile code running as the same user or concurrent ancestor-path replacement.

### Broker ownership and crash recovery

The Broker requires the built-in [Node SQLite API available in the declared Node 22.19+ baseline](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html). Custom Node builds lacking `node:sqlite` fail with `UNSUPPORTED_CAPABILITY`. Node 22 may emit an experimental-feature warning on stderr; this is not native-protocol stdout. No additional database package, native-addon compilation or background database server is installed.

`broker-lock.sqlite` is a small, private metadata-only file with a fixed application/version marker and no tables or page content. A rollback-mode [SQLite exclusive transaction](https://www.sqlite.org/lockingv3.html) holds ownership throughout startup, journal recovery, serving and shutdown draining. The file is never unlinked or replaced to break a lock. Only SQLite opens/closes that inode; ordinary reads through unrelated descriptors in the same process could interfere with POSIX record locks. Ownership files/sidecars are checked for type, owner, links, permissions and size; unexpected data or WAL state fails closed. Runtime paths are resolved before asynchronous work, and device/inode comparisons retain integer precision.

After obtaining ownership, startup examines only the exact `broker.sock` path. A live listener is preserved, including an older listener without the ownership lock. Only a same-user socket that refuses connection and still has the same device/inode after probing can be removed. Ordinary files, symlinks, probe errors/timeouts and changed identities are not discarded. A competing current Broker gets `BROKER_BUSY`; unsafe/unavailable ownership state gets `BROKER_STATE_UNSAFE`. Successful stale recovery is reported on the CLI's startup stderr line. The new socket is bound before the action journal opens, and ownership is released only after journal draining and socket closure.

This implementation is for cooperative Brokers on local Unix filesystems; it is verified on macOS. Network-filesystem locking, Windows ACL/ownership and hostile same-user file manipulation are outside validated support. Stop old versions before upgrading: the live-listener probe protects an already-running legacy endpoint, but an old version does not participate in the new lifetime lock protocol. A corrupt lock database, incomplete unsafe bootstrap, corrupt action journal or interrupted compaction still requires diagnosis; startup never erases those files to regain availability. Recovery of the endpoint does not automatically reconnect the extension, restore a lease or replay browser input.

## Tools and authority

| Tool | Current behavior |
|---|---|
| `browser_list` | List instances, or explicitly allowed tabs for an instance |
| `browser_claim` | Request a short-lived exclusive tab lease; DSH approval required |
| `browser_observe` | AX text/controls/named regions; optional `query` for exact name/role search, `rootRef` for a contextual subtree, and per-consumer cursor for deltas/resync |
| `browser_act` | Click/fill/check, press a named page key, scroll an exact document/element, send wheel input to an observed target, or navigate within the leased origin; action-specific postconditions; DSH approval required |
| `browser_screenshot` | Capture viewport into a Host image attachment; DSH approval required |
| `browser_handoff` | Release debugger/control and keep the tab open |

The lease lasts up to two minutes in this preview. On expiry/release/disconnect, old commands cannot resume with the old token. The extension Stop button closes its local gate before contacting the Broker. Already-dispatched inputs cannot be undone.

The DSH adapter binds each execution to its owning turn **before** waiting for approval. `turn/end` synchronously cancels that turn's pending approvals/connection work and in-flight operations, then releases its Broker owner. Each new turn gets a new opaque wire owner, so delayed cleanup from an earlier turn cannot release its successor. A screenshot already being stored locally may finish storage, but is not returned to an ended execution. This is not a claim that the plugin can override a malicious same-process plugin or undo already-dispatched browser input.

A click or key press without a verifiable expected result returns `unknown`, not fabricated success. Fill currently supports standard visible text inputs/textarea, not password entry, file inputs, arbitrary contenteditable or IME composition simulation. `Input.insertText` has been checked with Chinese text; that is not the same as full IME-event support.

Actionability waits for the same target's semantic identity, visibility, enabled state, stable geometry and a verified exposed hit point. Candidate points come from up to 16 actual client-rect fragments intersected with the viewport and ancestor overflow clips, with at most nine points per fragment (144 candidates). This avoids blindly clicking a multiline link's empty bounding-box center or rejecting a partly exposed button. Ancestor walks are bounded to 64 and open-shadow hit descent to 16; exceeding the bounds fails closed. Noninteractive text/icon descendants are valid hits, but a nested independent control cannot be clicked on behalf of its parent.

Immediately before mouse-down the provider rechecks the selected coordinate and geometry; it never silently changes to a different point at that boundary. Offscreen targets are scrolled into view once. Page events wake read predicates, with bounded polling when events are absent; predicates and dispatch share one action deadline (default 10 seconds, maximum 30 seconds). Covered elements and delayed results therefore get time to become ready without replaying the click/input. Empty fill uses a real Backspace key pair after selection. RPC cancellation preserves typed local deadline/lease/Stop reasons instead of labeling every abort as user cancellation.

The live fixtures verify trusted events on partial overlays, multiline links, narrow overflow clips and open-shadow buttons, and no input to nested independent controls. Candidate sampling can miss narrow/complex/transformed regions, ancestor bounding rectangles only approximate transformed clips, and renderer APIs are not an isolated-world proof against page monkeypatching. The final read is not atomic with later page/human changes or input dispatch. Closed shadow roots, OOPIFs, hover-dependent layouts and general complex-animation reliability remain unproven.

### Checkbox, switch and native radio state

For native radio selection, the browser retains its own [HTML radio-group semantics](https://html.spec.whatwg.org/multipage/input.html#radio-button-state-(type=radio)): same nonempty name, form owner and tree define peers. The provider does not enumerate or clear other radios, group nameless inputs together, assign `checked`, or fire synthetic input/change events. It observes the chosen node's checked state, not a transactional snapshot of every peer.

Within each radio action, a read-only remote binding retains the exact input, root and form objects plus its name and submission value. These are checked while waiting, immediately before mouse-down and while verifying the result. An in-action change fails as `STALE_TARGET`; if input may already have happened, the runtime returns unknown rather than replaying it. The binding is released on all exit paths. It is captured at action start, not at observation time, and is not an atomic defense against subsequent page/human changes or hostile renderer monkeypatching.

`scripts/verify-radio.mjs` runs real native controls through direct Chrome and the assembled DSH/native stack: trusted click/input/change, same-group exclusivity, cross-form isolation, nameless independence, no-op/deduplication, transparent-input labels, prevented default activation, disabled/custom-control refusal and stale references. Page-side fault injection changes name/form/value during geometry acquisition without changing the AX identity; a separate real click handler changes the group after input and must produce unknown. Unit tests also check root/form object identity and handle release. Clients now require `runtime.radio.v1`, and Broker provider negotiation requires `input.radio.v1`; restart/upgrade all components together.

Use `browser_act` with `action: { kind: "check", ref, checked: true }` (or `false`) to set an exact checkbox/switch state. The ordinary action approval, lease, document identity, deadline and request-ID fence apply. `NodeRef.checked` exposes boolean or `"mixed"` state when [Chrome Accessibility provides it](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#type-AXPropertyName); it is not the input's submission `value` attribute. Native checkboxes and explicit ARIA checkbox/switch widgets are supported. Native radios also support `checked: true`; `false` is rejected even if already unchecked. Select another observed radio to change the group choice. Custom ARIA radios remain unsupported by `check`.

The provider compares fixed read-only DOM state with browser AX state on the exact backend node. If already correct, it verifies again after observing the result and sends no click or focus request. Otherwise it waits for ordinary click actionability, rechecks whether another actor has already reached the desired state, and sends at most one trusted mouse down/up pair. It waits for the requested checked state, applies any additional text/URL expectation, and rechecks state and identity after result observation. A `value` expectation is rejected. No assignment to `checked`/`aria-checked`, synthetic `click()` or dispatched DOM change events are used by the action.

When a native checkbox or radio's own pointer surface is unavailable, `check` can use its sole associated HTML label. The fixed read-only resolver uses [HTML's native `input.labels` / `label.control` association](https://html.spec.whatwg.org/multipage/forms.html#the-label-element), including explicit `for` and wrapping labels; it never searches text or arbitrary parent containers. The label must have eligible layout (not hidden/disabled/inert) and passes the same fragment, stability and hit-ownership checks as other click targets. An offscreen label is scrolled using its exact [CDP remote object](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-scrollIntoViewIfNeeded). A hidden label does not displace the original input's actionability path.

The input remains the semantic/state target throughout. The provider checks the exact label-to-input association and native/ARIA-disabled/inert input ancestry while waiting and after the final point check, before mouse-down; reassociation fails without selecting another label. Nested independent controls inside a label are not valid label hit points. All remote object handles are released on completion/failure. Only `check` uses this alternate surface; ordinary click/fill/press do not silently delegate. Multiple labels, custom-element label activation, inputs absent from AX (for example `display:none`), and labels that appear only after the initial resolution are not supported by this increment.

Prevented/default-cancelled toggles, a delayed state that never arrives, lost acknowledgements and state changes after dispatch remain unknown; there is no second click to force convergence. An initial `mixed` state can be observed, but the requested state must be boolean: one click may not reach that state for every tri-state widget, in which case the action does not cycle again. Nonstandard custom state, cross-frame controls and atomic protection against changes between the final reads and mouse dispatch remain unsupported/unproven. Existing-state no-ops do not require pointer actionability but still require supported, current AX/DOM state and authorization.

`test/checked.test.mjs` and provider regressions cover parsing, desired-state validation, no-op, disagreement, no-repeat timeout and concurrent state changes. `scripts/verify-checked.mjs` runs through both direct Chrome and actual DSH/nativeMessaging, checking `isTrusted` events, request deduplication, checked/unchecked native state, a delayed custom switch, prevented toggles and same-name replacements. All fixtures are isolated loopback content. Current clients require `runtime.check.v1`; the Broker requires provider `ax.checked-state.v1`. Upgrade the components together. Older builds may reject journals containing the new `check` action kind; do not erase recovery records to force a downgrade.

`scripts/verify-check-labels.mjs` exercises transparent native inputs, explicit/wrapping labels, no-op/deduplication, nested-button exclusion, native fieldset and ARIA-disabled ancestry, offscreen labels, hidden-label fallback and reassociation while AX identity stays unchanged. The reassociation fixture deliberately changes `for` during geometry acquisition; this is a race regression, not evidence of protection against arbitrary renderer monkeypatching. The same helper runs through direct Chrome and the assembled DSH/native stack.

### Page keyboard actions

`browser_act` now accepts `{ kind: "press", ref, key, shift?, expected? }`. The reference must name an observed control, not a structural region. Supported keys are `Enter`, `Tab`, `Escape`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Backspace` and `Delete`. `shift: true` supports combinations such as Shift+Tab; Ctrl/Alt/Command, arbitrary characters, editing commands, repetitions and held-key requests are not exposed. Use `fill` for text content.

```js
await browserAct({
  requestId: 'confirm-search-1', leaseId, documentEpoch: snapshot.documentEpoch,
  action: { kind: 'press', ref: searchInput.id, key: 'Enter',
    expected: { kind: 'text', text: '搜索结果' } },
});
```

`browserAct` above is your authorized runtime/tool-call wrapper. Enter and Space can submit forms or activate controls, so these are approved actions, not harmless observation. The provider waits for actionability, requests focus without selecting/replacing text, rechecks semantic identity and the browser's AX `focused` state, then checks DOM focus ownership before sending one canonical down/up pair through [Input.dispatchKeyEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent). The extension validates the exact key/code/modifier/text shape and applies its ordinary Stop/lease gate to each event. The same focus guards now protect `fill` after selection. Password fields are not supported.

If page handlers steal focus, subsequent key/text input is rejected. Focusing or scrolling can themselves run page handlers, so a later failure can correctly return `outcome: "unknown"` even when no key was sent; it must not be described as entirely `notDispatched`. These checks are not an atomic lock against arbitrary later page/human focus changes. Interrupted pairs or lost acknowledgements remain unknown; after cancellation/revocation the plugin does not bypass the closed gate to send more input. A repeated request ID retrieves its historical result and never repeats the keydown. Observe the page before deciding what to do next.

The real Chrome and real DSH/native fixtures verify trusted Enter form submission with deduplication, left/right caret motion, Tab/Shift+Tab focus, Space activation, and focus-stealing rejection for both press and fill. The full key table also has deterministic encoding/gate tests. This is not evidence that every key, keyboard layout, complex editor or IME works across every site/platform. The initial implementation still requires a visible, hittable control; it is not a global browser/OS shortcut API.

For `navigate`, use a credential-free absolute HTTP(S) URL on the lease's exact origin. The result waits for the navigation's returned document loader (if any), document readiness and the expected result. Cross-origin navigation must not be attempted with this action; a redirected page outside scope is denied, though already-started navigation cannot be undone. All old-document node references become invalid. An unexpected timeout after dispatch returns `unknown`, so callers should observe the page instead of issuing a fresh duplicate action.

Observations include at most 120 controls plus 24 named regions (shared 40 KiB budget) and 240 AX text fragments (32 KiB budget). `truncated: true` means the observation is not complete. AX `StaticText` is reading content, not a complete rendered-page transcription. Only stale, read-only screenshots are retried within a deadline; policy failures are not retried.

### Native wheel input

Use `wheel` when a page reacts to wheel events (for example a canvas or virtual-list handler), rather than directly changing a DOM scroll offset:

```js
await browserAct({
  requestId: 'wheel-results-1', leaseId, documentEpoch: observation.documentEpoch,
  action: { kind: 'wheel', ref: resultsRegion.id, deltaX: 0, deltaY: 240,
    expected: { kind: 'text', text: 'Next results loaded' } },
});
```

The reference is required and must name an observed control or named region. The provider verifies current semantic identity and an exposed, stable point, auto-scrolls that target into view once if necessary, and rechecks that exact point before sending one [CDP `mouseWheel` event](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent). Both signed CSS-pixel deltas are required integers within ±10,000, not both zero. No model-supplied coordinates, keyboard modifiers, held buttons, gesture loops or synthetic DOM `WheelEvent` are admitted. Node and MV3 share the exact mouse-event encoder/validator; the final extension gate also restricts click events to the existing canonical left-button pair.

Wheel routing is not exact-element DOM scrolling: the browser may deliver to a noninteractive descendant and propagate scrolling to an ancestor, or a page handler can consume the event without moving any scroll offset. [UI Events defines wheel's scroll/zoom behavior and cancellation](https://w3c.github.io/uievents/#event-type-wheel). This increment does not opt into nested independent controls: if only a child button/input can be hit, target that control explicitly or use exact DOM `scroll`, rather than silently applying wheel to it on behalf of a parent. The requested deltas are input, not measured movement; no `result.scroll` evidence is fabricated for wheel.

An optional text/URL condition is checked under the same action deadline; `value` is rejected. Without a condition, the outcome remains `unknown`/`unverified`: CDP acknowledgement is not proof of page processing, and the immediate observation may precede asynchronous wheel effects. A passed condition confirms only that the requested condition was observed, not that this event uniquely caused it or moved the requested distance. Lost acknowledgements, prevented/no-feedback events and cancellation never trigger an automatic second sample. Duplicate request IDs return historical results; a new request requires fresh observation and intent. Stop/lease/document checks and durable before-input fencing are unchanged. These are not continuous trackpad inertia, pinch/zoom, cross-frame or atomic renderer-state guarantees.

`test/wheel.test.mjs` covers exact contracts/encoding, capability negotiation, region targeting, changed/covered points, cancellation, missing conditions and lost acknowledgements. MV3 tests cover parameter rejection and Stop. `scripts/verify-wheel.mjs` is shared by direct Chrome and real DSH/native tests: trusted CSS-pixel events, a canvas handler without DOM scrolling, vertical/horizontal overflow scrolling, no-repeat unknown results, independent-child exclusion and replaced-region references. Upgrade together: clients require `runtime.wheel.v1`, and the Broker requires provider `input.wheel.v1`. Older builds can reject journals containing wheel actions; do not delete recovery fences to force a downgrade.

### Explicit document and container scrolling

```js
const result = await browserAct({
  requestId: 'scroll-results-1', leaseId, documentEpoch: observation.documentEpoch,
  action: { kind: 'scroll', ref: resultsRegion.id, deltaX: 0, deltaY: 400,
    expected: { kind: 'text', text: 'Next result' } }
});
```

Omit `ref` to scroll the root document; supply a current control/region reference to scroll **that exact element**, never an inferred ancestor. Both deltas are required integers in CSS pixels, each between -10,000 and 10,000 and not both zero. Optional expectations support text or URL, not input value. The fixed operation uses DOM `scrollBy` with instant behavior; it does not inject wheel events or emulate a pointer gesture. A rendered offscreen container may be scrolled directly without moving its ancestors.

`result.scroll` contains `target`, `requested`, `before`, `after` and `moved`. Each position includes signed `x`/`y`, `scrollWidth`/`scrollHeight` and `clientWidth`/`clientHeight`. Negative RTL/reverse-layout offsets are preserved. The provider samples until offsets and dimensions are stable for at least 50 ms under the action's shared deadline, then verifies them again after observing the result. Movement exceeding 0.5 CSS pixels in the requested direction can verify scrolling; this does not promise the exact requested distance because boundaries and scroll snapping may constrain it. An explicit text/URL expectation must also pass. Zero movement returns evidence with `moved: false` and an `unknown` outcome, not fabricated success.

The action dispatches once. Navigation, target replacement, cancellation or an unstable result prevents a stale success; a post-dispatch failure remains unknown and is never replayed. Duplicate request IDs return their historical result, not a new measurement. Only shallow root discovery (`DOM.getDocument` with depth 0 and no piercing) is admitted by the extension. Real Chrome and assembled DSH/native fixtures verify document deduplication, exact nested containers, loaded text, signed RTL offsets, boundaries and replaced-reference rejection. These are DOM-scroll guarantees, not wheel/canvas support, cross-frame support, or atomic protection against arbitrary subsequent page mutations.

### Scoped browser-side reads

The default observation has `scope: { kind: "document" }`. Named structural regions (for example named forms, dialogs or regions) appear among `nodes` with `kind: "region"`. These references are reading roots and may be explicit scroll targets, but click/fill/press on them fail before input. A known control reference can also be used as a reading root.

```js
import { applyObservationUpdate } from 'dsh-native-browser/observations';

// browserObserve is your authorized runtime/tool-call wrapper.
const page = await browserObserve({ leaseId });
const region = page.nodes.find(node => node.kind === 'region' && node.name === '搜索表单');
if (!region) throw new Error('Region not present in this bounded observation');
let local = await browserObserve({ leaseId, rootRef: region.id });
const update = await browserObserve({ leaseId, rootRef: region.id, cursor: local.cursor });
local = applyObservationUpdate(local, update);
```

`scope: { kind: "subtree", rootRef }` means **only that subtree** was read, even when `format` is `full` and `truncated` is false. Repeat `rootRef` on each scoped request. Omitting it switches back to the document; a cursor from a different region/document scope produces a fresh full view with `resyncReason: "scope-changed"`. A disappeared, replaced or renamed root is `STALE_TARGET`, never an automatic whole-page fallback or a same-name rebind.

The Chromium implementation validates a known root before and after acquisition. A fixed internal `ax.read` request runs next to CDP, inside the extension in production: document reads start at [Accessibility.getRootAXNode](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-getRootAXNode), scoped reads resolve only their exact backend root, and both traverse reachable child links with [Accessibility.getChildAXNodes](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-getChildAXNodes). Ignored descendants returned together are cached once; nodes not reachable from the requested root are not emitted. Static text is retained without duplicating inline text boxes. AX values, name-source/related-node payloads and URL properties are not part of the source projection. Raw `getFullAXTree`/`queryAXTree` and arbitrary child traversal are no longer available through the extension's public CDP allowlist.

Each read has limits of 2,048 retained nodes, 8,192 retained child edges, 1 MiB serialized retained metadata, 128 AX calls, depth 64 and 192 KiB projected bridge output. The existing smaller semantic output budgets still apply afterward. Limits, missing child evidence, cycles, oversized names or unsupported frame boundaries set `truncated: true`; oversize control names are omitted, not shortened into fake exact identities. `format: full` means a full replacement of the current **bounded view**, not proof the entire page was read. Chromium can still allocate a large single sibling response before our code receives it; these limits do not bound browser-internal computation, transient CDP allocations or exact JavaScript heap usage.

The extension validates the currently leased root frame and brackets traversal with loader/origin checks. Every internal browser call rechecks lease, cancellation and Stop before dispatch and after return. A stopped or navigated traversal is discarded, not returned as partial success. Reads do not widen into other frames. This does not create an atomic same-document snapshot against arbitrary DOM changes; actions still perform fresh identity and actionability checks. Unrelated references are not removed because they are absent from a local or source-truncated view. The provider retains at most 2,048 emitted identities per page in an LRU; evicted refs must be observed again.

`BrowserProvider.observeSubtree` is optional and browser-independent. Providers without it fail with `UNSUPPORTED_CAPABILITY`; a provider returning a different scope is rejected. A future non-Chromium provider can implement this seam without browser code in the runtime. Initial discovery, action-result observations and known subtrees all use bounded acquisition now. There is no continuation/pagination API yet: use a known region explicitly or the exact semantic search below when its name is known. Unnamed/unknown content beyond discovery bounds can remain unreachable. Event-driven dirty-subtree acquisition and iframe/OOPIF interaction remain pending. Update the Broker and extension together for this preview's new internal commands; an old extension rejects them rather than falling back to an unbounded read.

### Exact semantic target search

```js
const query = { name: '保存', role: 'button' };
const matches = await browserObserve({ leaseId, query });
// Do not select the first ambiguous match. Search in a known context instead.
const region = await browserObserve({ leaseId, query: { name: '收货地址', role: 'region' } });
if (region.truncated || region.nodes.length !== 1) throw new Error('Region is not uniquely identified');
const local = await browserObserve({ leaseId, query, rootRef: region.nodes[0].id });
if (local.truncated || local.nodes.length !== 1) throw new Error('Target requires further disambiguation');
// local.nodes[0].id is a fresh candidate for the ordinary approved action flow.
```

`query.name` is required, nonblank and at most 1,000 characters. It matches the **computed accessible name exactly and case-sensitively**, not visible-text substrings, CSS selectors, regex or fuzzy search. Optional `query.role` narrows the computed AX role (`button`, `textbox`, `region`, etc.). A region can itself be found by name, then used as `rootRef`. All matches in the bounded result retain distinct refs; querying never selects, focuses or clicks anything. No matches is not permission to guess a selector or broaden the origin. Hidden/ignored matches are excluded; the usual exposed-control/named-region/text projection still applies.

The response has `scope: { kind: 'query', query, rootRef? }`, containing only query matches—not the whole document or complete subtree text. Repeat the exact query and optional root on cursor updates. Changing the name, role presence/value, root or returning to ordinary observation requires scope resync. The public reducer checks those boundaries. `BrowserProvider.find` is an optional portable capability; unsupported providers refuse without silently returning a page instead. The normal observe authorization, serial queue, deadline, revocation, document and root-identity checks still apply. A found ref does not bypass action approval/actionability, and a same-name replacement never inherits it.

The fixed internal `ax.find` uses [Accessibility.queryAXTree](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-queryAXTree) with the exact backend root and literal name/role filters. It remains unavailable as arbitrary raw CDP. Only a bounded projection is sent over Native Messaging (up to 2,048 examined candidates and 192 KiB, then the normal semantic output caps); truncation means the candidate set may be incomplete. Chrome still computes names throughout the requested DOM subtree and may allocate a large matching response, so this is not bounded browser CPU/memory or incremental acquisition. Root-document-only searches do not enter iframes; real iframe exclusion, same-name ambiguity, literal `.*`, query-scope cursors, replacement rejection and a target beyond the 4,000-button discovery limit are tested. Cross-frame search, fuzzy matching, query waits and automatic contextual resolution remain future work.

### Incremental observation contract

Call `browser_observe({ leaseId })` for a `format: "full"` snapshot. Keep its opaque `cursor` with that exact snapshot; the next call can pass `{ leaseId, cursor }` (and the same `query`/`rootRef` for a scoped view). Each consumer keeps its own cursor, not a shared global “last observed” position. A response is either a new full snapshot of the requested scope (replace the old one) or `format: "delta"` tied to its exact `baseCursor`, tab, document epoch and scope:

- `nodes.upsert` contains added or changed controls; `nodes.remove` contains IDs absent from the new **bounded view**, not proof of DOM deletion. Optional `nodes.order` is the complete new ordering of the returned controls.
- Optional `text` is one `{ start, deleteCount, insert }` array splice against the baseline's text fragments. When absent, the baseline text is unchanged.
- Metadata including revision, URL, title, scope and truncation is always current. A delta can contain no content changes and still advance the cursor/revision.
- Missing, expired, evicted or foreign-owner/lease cursors yield only the freshly authorized full view, with `resyncRequired: true` and `resyncReason: "cursor-unavailable"`. A document replacement uses `"document-changed"`; a changed read root uses `"scope-changed"`. Never apply a delta to a different base/scope or reuse old-document references. An invalid requested root fails rather than returning another scope.
- Large changes return a full snapshot with `resyncRequired: false` if the delta is not at least 15% smaller in serialized bytes. Callers must handle both formats on every response.

JavaScript consumers can use the public, browser-independent reducer (with TypeScript declarations):

```js
import { applyObservationUpdate } from 'dsh-native-browser/observations';

let snapshot = await browserObserve({ leaseId }); // Your runtime/tool-call wrapper.
const update = await browserObserve({ leaseId, cursor: snapshot.cursor });
snapshot = applyObservationUpdate(snapshot, update);
```

The runtime caches at most 128 immutable baselines, 8 MiB of serialized snapshot/owner/lease data, 96 KiB per snapshot, for up to 120 seconds each. These are serialized-data bounds, not a claim of exact JavaScript heap usage. Lease release purges its cursors immediately. Successful/unverified action results with an observation include a full snapshot and cursor as well; a deduplicated action response remains its **historical** result, so observe again when current state is needed.

Output deltas reduce runtime→DSH/model response duplication. Every call still reauthorizes access and freshly traverses its bounded requested scope; neither cursor reuse nor source caching bypasses authority. The native smoke records bounded-view response bytes. The direct Chrome smoke separately measures a raw full-tree baseline (test instrumentation only), actual scoped AX calls including identity checks, and projected source responses. A 4,000-button loopback fixture whose raw AX exceeds 1 MiB verifies truncated observation, complete known-region reading and a trusted verified click with deduplication through the real native stack. These are fixture-specific byte/correctness measurements, not browser-memory, latency, model-token or Codex-comparison benchmarks; more local CDP calls may trade latency for bounded transport.

## Action result retention

Action identity fences and full result payloads have independent lifetimes. The runtime retains up to 10,000 identity/hash records without evicting them to admit more actions; exhausted identity capacity still returns `JOURNAL_FULL`. Settled records contain only small historical metadata or a stable failure code, not fulfilled/rejected Promises retaining page results. In-flight duplicates share one execution and receive independent copies of its result.

Completed full results use a separate LRU cache: by default 128 entries, 8 MiB of retained UTF-8 JSON buffers, 128 KiB per result and 120-second TTL. Reading does not extend TTL. Expiration is pruned on cache access/inspection; inactive retention still cannot exceed the byte/count limits. Results too large for this cache are returned to current callers but not retained. These caps exclude metadata/Map overhead, transient serialization, executing operations, consumer-owned returned objects and the separate observation cursor cache; they do not assert an exact process heap/RSS limit.

An exact duplicate after payload eviction/expiry returns `RECOVERY_REQUIRED`, `outcome: "unknown"` and historical `recovery` metadata without re-executing input. Even `priorOutcome: "succeeded"` is not proof of current page state. Use an approved fresh observation, not a new request ID to bypass the fence. Changed payloads still return `REQUEST_ID_CONFLICT`, including after eviction. Cached full results require the current owning lease; release purges that lease's cached payloads synchronously. Authority is checked again before delivering an initial or concurrent result after asynchronous work, including durable settlement: if control ended, only historical metadata is returned instead of old page contents. A later call with no live lease needs durable recovery authority or is denied as before.

`test/action-results.test.mjs` checks UTF-8 byte accounting, immutable copies, LRU/TTL, oversize admission, conflict/no-replay after eviction, pending duplicates, release during cache reads/settlement and removal of settled Promise references. A real-socket Broker test executes 129 fake-provider actions against the default 128-entry cache, verifies metadata-only retry and unchanged dispatch count, then releases the session and verifies zero retained result bytes. Internal `journalUsage()` exposes counts for these diagnostics, not a new wire API. Disposal clears the payload cache and in-memory fences; a disposed runtime cannot accept another action. Journal capacity reconciliation across long-lived runtime epochs and broader memory/soak testing remain unfinished.

## Durable replay fences and reconnects

The production Broker opens a private `action-journal.jsonl` only after it holds lifetime ownership and has bound its Unix socket. After current lease/origin/policy checks, the runtime durably reserves an action **before calling the provider**. The intent conservatively means “may have dispatched”; there is no attempt to make disk and a browser side effect a single transaction. The existing provider dispatch marker still distinguishes pre-input failures in the live response. Settlement writes only outcome/dispatch metadata. A storage error before dispatch blocks input; an error after dispatch returns `JOURNAL_UNAVAILABLE`/unknown, retaining the intent instead of retrying.

The file contains keyed digests of the request identity/payload, action kind, timestamps, reserved/settled state, dispatch state and prior outcome. It does **not** persist raw request IDs, leases, recovery capabilities, URLs, form values, page observations or screenshots. A local-secret HMAC protects record integrity and prevents an unkeyed dictionary check of the payload digest. This is not protection against a malicious process with complete access to the same user's private files and token.

Writes are serialized and use [Node's file-handle sync](https://nodejs.org/api/fs.html#filehandlesync) before authorizing dispatch. Private regular-file ownership/permissions, no-follow opens, single-link checks, bounded reads and record validation are enforced. The limits are 10,000 retained identities and 20 MiB, with space reserved for outstanding settlements. The default recovery window is 24 hours; expired records are removed atomically at startup, on relevant writes, and in a minute-interval sweep while the Broker is running. Active intents are not expired mid-action. Compaction syncs the replacement and directory; it never evicts unexpired fences to admit another action. Disk/fsync/corruption failures stop new dispatch rather than selecting a volatile fallback. A partial final record fails closed; this preview has no automatic corruption repair. Filesystem calls themselves cannot be cancelled, so a stuck filesystem can delay the response even though cancellation/deadline checks prevent later browser dispatch.

The adapter privately retains a random recovery capability across its Broker connections. Recovery identity combines that capability with the opaque DSH turn identity, independently of connection-bound lease authority. Repeating an exact old request after reconnect returns `outcome: "unknown"`, `code: "RECOVERY_REQUIRED"` and `recovery` metadata, with no old observation. Even `recovery.priorOutcome: "succeeded"` is historical, not confirmation of current page state. Changing the old request's lease, ref, content or timeout yields `REQUEST_ID_CONFLICT`. Reacquire explicit control and freshly observe before deciding on a new action; never use a fresh ID merely to bypass an unknown outcome.

Different capabilities/turns cannot recover one another's metadata, and knowing a recovery capability never restores a lease. The capability currently lives in the adapter process only: restarting DSH itself creates a new one. Legacy clients without it have connection-local recovery only. The in-memory full-result cache still requires live lease authority and remains bounded for the runtime epoch. This is a short-lived replay fence, **not exactly-once business execution**, indefinite deduplication, or restoration of lost form transactions.

Tests cover child/Broker processes killed after a side effect but before settlement, durable reopening, write failures, interrupted/corrupt records, capacity, expiry, shutdown draining, unsafe paths, competing Broker processes and recovery-scope isolation. The assembled real DSH/native test verifies a Broker CLI SIGKILL and stale-socket recovery between actual button input and replay: click count does not increase, old leases stay unusable, and replacing the lease in the old payload conflicts. The process-level fixture additionally kills a Broker during an unacknowledged action and recovers its reserved intent without a second effect. Interrupted-compaction cleanup and corrupt-state diagnosis/repair remain unfinished. Do not delete recovery files or socket paths blindly to make a restart succeed.

## Images and Vision Router

`browser_screenshot` returns a Host-owned attachment and an image content block; it does not send the image to a separate vision endpoint itself. Text-only DSH models need a separately configured visual tool such as `dsh-vision-router`. Passing the screenshot's authorized attachment ID to its public tools is the planned collaboration route; the complete browser→Vision Router→model task has not passed live acceptance yet.

The result now also includes `screenshot`: an opaque screenshot ID, exact canonical attachment ID/content SHA-256, lease/tab/document identity, capture/expiry times, canonical pixel dimensions and an image-to-CSS-viewport transform. The adapter reads back the Host-normalized bytes to verify that the hash matches the persisted attachment ID. The in-memory registry is per owning DSH turn, limited to 128 metadata entries and 60 seconds per reference; handoff/turn end/disposal removes that scope's references. It does not duplicate pixel storage or delete Host-owned image files. An expired runtime reference is **not** a claim that an independently authorized Host attachment has been erased or made unreadable to other plugins.

The browser-independent vision adapter has a strict parser for the public `vision_ground` result: canonical dimensions must match; malformed/unavailable responses and non-finite, empty or out-of-range boxes are rejected instead of clamped. It maps the public result once (upstream already removes its letterbox), without blindly adding page scroll or DPR again. The affine helper also handles explicit crop/rotation transforms, but the current capture path only produces full-viewport scale transforms. Parsed results are candidates only: no visual-click action or automatic visual backend dispatch is exposed yet. Document/geometry freshness, current lease checks and browser hit testing still need to be joined to that candidate before execution.

Optional compatibility test: `pnpm test:vision-router /absolute/installed/dsh /absolute/dsh-vision-router`. Both supplied packages must already have dependencies; the test does not install or change user plugins. It loads Router's public package entry into real DSH ToolRuntime/Session/attachments/files/LLM services with a private temporary Host and only a loopback pixel-detector backend. Six checks verify durable tool-result image admission, Vision mode off/on, full/short attachment identity, cross-session rejection, actual 1000-square frame transport and single inverse mapping, and a non-retried local 429. The source rectangle position is random and absent from the request text. Browser capture is a FakeProvider: this is not a real vision-model accuracy test or Chrome-to-visual-click acceptance.

This compatibility run found prerequisites that a bare attachment hash does not satisfy: publish the image into the owning Session, explicitly enable a Router-owned Vision route, and provide Host file service for Router's internal temporary grounding frame even when `annotate:false`. Its no-fallback local backend configuration still attempts npm/GitHub release checks. An exact socket allowlist in the isolated test blocks those attempts before connection and reports them; it is not shipped as a production privacy guard. Never infer complete offline behavior or frozen per-call egress from one local backend toggle. See [the detailed integration evidence](plans/vision-router-integration.zh-CN.md#61-已验证的集成前提与限制).

Vision Router may use cloud fallbacks. Review its full effective provider/fallback configuration before giving it screenshots. This build does not enforce another plugin's outbound network policy, and must not be advertised as doing so. The inspected public tool interface does not expose a per-call frozen backend allowlist contract; automatic dispatch remains disabled until that boundary can be enforced. Visual coordinate actions, backend-policy enforcement and actual VisionProvider dispatch remain pending.

## Host installation integrity

`install-host` validates Node/CLI file accessibility, resolves the selected paths, and requires a private runtime directory and a user-owned Native Messaging directory not writable by other users. Node may be an executable symlink (for example an nvm-managed path). The three managed targets—`native-host`, `native-host.json` and this host's browser manifest—are all preflighted before any of them is published. Existing targets must be bounded (16 KiB), private, user-owned single-link regular files; no-follow reads compare inode/size/timestamps. Symlinks, hardlinks, oversized files, malformed allowlists, unrecognized launchers and a manifest pointing at another runtime fail without overwriting them. A moved old CLI can be replaced by an explicitly supplied, valid new path; arbitrary launcher shell content is not treated as an owned launcher.

The shared host allowlist retains the union of valid existing origins, with a 64-origin ceiling. Each browser manifest retains its own existing origins and the explicitly requested extension ID: registering a new Edge ID does not copy that new ID into Chrome's manifest. Existing legacy manifest entries are preserved, not automatically pruned. Identical reinstalls preserve file inodes/content and do not rotate `auth-token`, rewrite Broker ownership, or touch action recovery data. The installer does not stop or restart a running Broker or an already-running Native Host.

Installations use two dedicated private ownership directories: `.host-install-lock` inside the runtime and `.dsh-host-install-lock` inside the selected Native Messaging directory. They reuse the tested SQLite lifetime-lock primitive in separate database inodes; the live Broker lock/socket are not acquired or opened. Runtime ownership serializes shared-config updates across browser brands; manifest ownership also blocks a second runtime from racing to replace the same browser registration. A competing installer gets `INSTALLATION_BUSY`. OS process exit releases the lock; do not delete lock databases to force an installation through. These directories can remain after unsuccessful preflight, and initial runtime bootstrap may already have created the private token.

Each changed file is staged with an exclusive random sibling path, fixed private mode, file fsync, a final comparison against its preflight snapshot, atomic rename, and parent-directory fsync. On an ordinary caught failure, already-published files are rolled back in reverse order, restoring previous bytes/modes or removing only newly published files. If another writer replaced a published file, rollback preserves that replacement and reports `INSTALLATION_FAILED` with an incomplete-rollback message. Normal success/failure cleans its staging files; runtime identity and recovery records are never rollback targets.

This is **per-file atomicity plus in-process rollback**, not an atomic transaction spanning directories. A crash/power loss between publications can leave a partial install or orphan staging files; durable rollback/repair and full package removal are still pending. Automatic cleanup of crash leftovers is deliberately absent. Same-user hostile code, concurrent ancestor-directory substitution, remote filesystems and Windows ACL/registry support are outside the demonstrated guarantees. The error message's restored-state statement concerns only files published by this attempt, not independently changed files or newly created directories.

`test/installer.test.mjs` uses real private files to cover fresh/repeated installation, brand allowlist separation, corrupt/link/mode/path conflicts, ownership conflicts and rollback. Fault injection wraps the real publisher at each of three post-publication boundaries; it does not simulate a full power-loss recovery. An independent child holds both installation locks, is killed with SIGKILL, and the next install succeeds without replacing either lock inode. The native smoke reinstalls while the independent Broker is live, checks unchanged registration/token files, and then lets Chrome launch the real host from that registration.

## Scoped host unregistration

```bash
node bin/dsh-native-browser.mjs uninstall-host --browser=chrome --extension-id=<32-character-extension-id>
```

Specify the same `--runtime-dir` used at installation if it was nondefault. `install-host`, `uninstall-host` and `doctor` also accept an explicit `--manifest-dir` for a known registration location, such as an isolated test profile. Do not guess a profile path: [Chrome's registration lookup locations depend on browser/platform](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location).

This command removes **only that extension origin from this host's manifest in the selected directory**. If other origins remain, it atomically updates the manifest. If it was the last origin, it removes the exact validated manifest. Before either change it fsyncs a private byte-for-byte backup named `.dsh-host-<random-id>.disabled` in that directory; JSON output returns the backup path. The suffix is not the host's registered `.json` path. Repeating an absent origin/manifest returns `status: "not-registered"` without another backup. Missing registration/runtime directories are not bootstrapped by uninstall. It can unregister a matching manifest left behind by a partial installation even if its runtime directory no longer exists.

The same installer locks, ownership/path/allowlist checks and bounded no-follow reads apply. A malformed, linked or foreign-runtime manifest is left in place. If a later write/removal cannot be confirmed, the error points to the retained backup; do not infer that rollback or deletion completed. Explicit `install-host` with the intended ID is the supported way to register again. Backups are retained for manual review; there is no automatic pruning or restore command yet.

The command does **not** delete the shared launcher, combined host allowlist, token, action journals, lock files, other browser registrations, DSH plugin package or Chrome extension. Keeping the combined allowlist avoids revoking an ID still used by another browser. It does not shut down existing Native Hosts/Broker connections or revoke existing leases: the result explicitly reports `runningConnectionsStopped: false` and `runtimeStatePreserved: true`. Stop controlled tabs first; to stop the whole running plugin, also stop its Broker and disable/close the extension's active connections. A system-wide or policy-provided registration can still exist outside the selected path, so unregistration is not a global security revocation or whole-machine uninstall.

`test/uninstall.test.mjs` covers partial/last-origin removal, no-op, preserved shared state/other brands, backup bytes/permissions, malformed/linked/foreign targets, locks, stale-file refusal and the real CLI with explicit temporary directories. The assembled native test adds a control-free native handshake probe: fresh Chrome host discovery works before unregistration, returns host-not-found afterward while the existing connection survives, and succeeds again after explicit reinstallation. The probe uses real Native Messaging and a real Broker hello, never page reads or input. This is isolated Chrome-for-Testing evidence, not enterprise-policy or real Edge acceptance.

## Known limitations

- Root document only; no OOPIF interaction, no cross-origin screenshot frames, no open/batch/upload/download tools yet.
- Document discovery, action-result reads and known subtrees use bounded source traversal; exact semantic search can find named targets beyond that default view. Continuation/paging and event-driven incremental acquisition remain unimplemented, so unknown/unnamed content beyond discovery bounds can still be inaccessible. Large individual CDP sibling/query responses are not browser-memory-bounded.
- Actionability uses event hints plus polling and bounded fragment-based hit-point selection. Named page keys, explicit DOM scrolling and single native wheel samples exist; continuous trackpad gestures, richer keyboard/IME/editor behavior, hover-dependent/complex layout and animation handling remain pending.
- Screenshot JPEG is bounded to the initial control-channel budget; chunked blobs are still pending.
- Native host/Broker/extension/DSH are verified together in an isolated Chrome-for-Testing profile, not yet inside the user's regular signed-in profile or via an actual agent/model turn.
- Durable short-lived action fences, same-adapter-turn metadata recovery and ownership-guarded stale-socket recovery exist. DSH-process recovery identity, corrupt/bootstrap/interrupted-compaction repair, complete lifecycle/resource reconciliation, heartbeat renewal, unattended installer, store signing and production benchmarks remain pending. Browser reconnect/control is still explicit, not transparent automatic resumption.
- Edge build shares the same extension/runtime source and has different manifest installation paths, but has not passed real Edge acceptance.

See [implementation progress](implementation-progress.md) for the remaining planned gates.
