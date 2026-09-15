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

### Frame geometry development gate

`pnpm test:frame-geometry` runs the internal content-quad mapping and ancestor-owner hit checks against isolated same-process nested iframe fixtures. Set `DSH_CHROME_TEST_EXECUTABLE` to select a binary; for Edge also set `DSH_TEST_BROWSER_BRAND=edge`. It does not install an extension or use a daily browser profile. Reports with source/build hashes and actual event coordinates are written to `output/playwright/{chrome,edge}-frame-geometry-smoke.json`.

The mapping uses projective quadrilaterals, not axis-aligned bounding boxes or summed iframe offsets. Every boundary explicitly names its child/parent document and viewport. Invalid/nonconvex/degenerate geometry, out-of-viewport points, mismatched document chains and cycles are rejected. Up to 32 ancestors are checked twice; the second pass rereads exact geometry and checks the original point against each bound iframe owner, without picking a replacement point. Cancellation and caller mutation cannot silently retarget an in-flight measurement.

Real Chrome-for-Testing `151.0.7922.10` and Edge `152.0.4191.66` each passed seven layouts and 42 assertion groups: 35 trusted clicks with independent child-local event coordinates, top/intermediate overlays, pointer-disabled owners and moved geometry. Layouts include iframe border/padding, nested scroll, nonuniform scaling, rotation, perspective, high DPR, nested CSS zoom and reflection/zoom-out. Near-corner checks supplement the center candidate; the retained [Chrome](compatibility/2026-09-12-chrome-frame-geometry.json) and [Edge](compatibility/2026-09-12-edge-frame-geometry.json) reports record the exact samples. These are functional checks, not latency or general webpage-accuracy benchmarks.

The live fixture initially exposed a scale-unit bug: under inherited CSS zoom, an inner iframe's same-process CDP box quad was not in the same units as the root viewport. In the tested Chromium sessions, multiplying it by the measured owner-document/root-document `devicePixelRatio` ratio before inverse parent mapping fixed the actual child event position. Multiplying by absolute DPR is wrong. This conversion is a narrowly tested Chromium acquisition helper, not a generic OOPIF, page-pinch/visual-viewport, browser-version or hostile-renderer guarantee.

This geometry-only gate dispatches test-only CDP input. The separate [public child-click path](#explicit-same-origin-child-clicks) now uses this primitive with fresh source binding; this older gate does not exercise that path. Its result is a measurement, not an authorization ticket, an atomic layout lock or proof that the target inside the leaf is actionable. The source acquisition below adds document/object binding and leaf hit checks to the read path. The separate child-click implementation adds semantic ref identity, approval, final Stop/lease/document/input fences and result verification, never replaying a returned point. No public tool, wire input command or `oopif` action capability is enabled by this gate. Child refs remain invalid root action targets.

### Bound frame geometry acquisition

The extension now implements internal `frame.geometry({lease,request:{binding,backendNodeId}})`. The binding has the same five document/context fields as `ax.frame`; it cannot include a session selector, JavaScript, object handle or desired point. The source independently validates the complete same-origin ancestor chain and resolves target/iframe-owner objects in the corresponding current default execution contexts. Each fixed renderer function also checks `ownerDocument === document`: resolving a backend ID in a context is not sufficient to prove document ownership. The target's own actionability and original point are checked before/after ancestor mapping. Results contain only `{point,local,depth}`, not a reusable input token or remote object identity.

Every geometry read checks graph revision at the last browser-dispatch boundary, after asynchronous lease lookup, and after the result. The read scope allows only fixed DOM geometry/object resolution, three fixed renderer functions and exact-backend AX identity reads; no input, focus, scroll, arbitrary evaluation or caller-selected object group. A separate internal click callback can dispatch a guarded pointer pair, but is unavailable through the `frame.geometry` wire command. Objects are allocated into an operation-private [CDP object group](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-resolveNode) and [released together](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-releaseObjectGroup), including failed/cancelled reads. A graph check after cleanup catches navigation during that final await. Cleanup uses its own one-second deadline, cannot address a replacement session, and closes the graph/control gate if a live cleanup fails. Stop's debugger detach releases remaining session objects. Bounds are 32 ancestor boundaries, eight concurrent internal scopes and 1,024 read calls per scope; the extension tab queue serializes actual wire requests. These do not bound browser-internal CDP response allocation or promise atomicity with future layout changes.

`pnpm test:frame-geometry-source` runs this production source acquisition through real CDP on seven Chrome/Edge fixtures, with 35 trusted test-only input oracles per browser. It additionally rejects covered leaf nodes, wrong-document backend IDs, parent/intermediate overlays, moved geometry and obsolete child documents, and independently tries every allocated remote object after completion to confirm release. [Chrome](compatibility/2026-09-12-chrome-frame-geometry-source.json) and [Edge](compatibility/2026-09-12-edge-frame-geometry-source.json) retain 70 assertion groups each, exact samples and source/build hashes. `test:extension` separately runs the actual MV3 command through the existing substituted-native-port seam: actual context/object acquisition, cleanup, overlay refusal, a test-only trusted click, navigation and popup Stop. Its 15 checks do not exercise the separate public DSH child-click path.

Geometry acquisition currently rejects remote-session ancestors with `UNSUPPORTED_CAPABILITY`; it never guesses an OOPIF coordinate conversion. Foreign/opaque ancestors are denied before DOM acquisition. A foreign sibling is not read and does not inherit authority from this operation. Semantic ref/name/version validation and full Native/DSH integration are now covered separately for explicit same-origin child clicks below. OOPIF coordinate acquisition and approved cross-origin interaction remain pending. Regular profiles, hostile renderer intrinsics, pinch/visual viewport behavior and broad site accuracy remain outside this fixture evidence.

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

## Early Edge compatibility smoke

The P2 early Edge gate now passes on macOS with Microsoft Edge `152.0.4191.66` and DSH `0.1.5-rc.1`. This validates cross-browser reuse before formal P5 support; it does not change the Chrome-first release scope. The only integration change was an explicit `chrome|edge` selector in the isolated native test harness, selecting the existing extension bundle and installer brand. No production runtime/provider/extension implementation or runtime-core source needed an Edge-specific change. The report records all three runtime-core source hashes relative to the pre-Edge local implementation state, not an assertion that the worktree equals the last Git commit.

```bash
DSH_EDGE_TEST_EXECUTABLE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  pnpm test:edge-native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

Use an explicit installed executable. The harness starts a fresh temporary headless user-data directory, loads `dist/extension/edge`, and writes this host's manifest only under that temporary directory's `NativeMessagingHosts`. [Microsoft documents user-specific Native Messaging registration under the user-data directory](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging); Edge itself starts the actual host and communicates through the production native transport. The script neither mounts an existing user profile nor writes the regular Edge/Chrome registration locations. It verifies both the extension's `brand: edge` and the browser's `Edg/` user-agent marker, rather than trusting a renamed Chrome build. The full version comes from the browser connection; the reduced UA reports `152.0.0.0` separately. The `Extensions.triggerAction` test seam and unpacked-extension flags were verified on this version, not promised for every older Edge build or policy environment.

Eight gate checks include all 20 unchanged Chrome L1 fixture oracles (one pass each, not a timing benchmark), a two-step Chinese fill/Enter batch with real public ApprovalService grants and replay fencing, all 220 controls across five page windows, same-origin navigation/stale-ref refusal, actual popup Stop during a covered pending input, explicit re-consent and handoff leaving the tab open. Forty-five approval asks each have one audited decision; answers are controlled local test responses, not human UI interaction. The normal DSH tool registry, session, attachment service, independent Broker, Edge-started Native Host and production MV3 are present—there is no substituted CDP/native transport.

Local report: `output/playwright/edge-native-smoke.json`; retained sanitized evidence: [2026-09-12 Edge smoke](compatibility/2026-09-12-edge-native.json). Cleanup of all owned temporary resources passed. The existing Chrome batch/page native tests are rerun against the default harness brand to catch regressions. This is not a repeated statistical reliability gate, performance comparison, actual agent/model turn, signed-in profile, enterprise policy, installer/uninstaller lifecycle, store publication or full P5 Edge certification. [Porting extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension) still requires API/store/policy review; sharing Chromium code alone is insufficient release evidence.

## Frame discovery foundation

`browser_frames({leaseId})` returns structural metadata for the authorized tab: opaque frame IDs, parent IDs, document epochs, canonical HTTP(S) origins, root-relative origin relation and observed context availability. It never returns child text, frame names/titles, URL paths/query strings, or raw Chromium session/context IDs. `contextStatus: known` is evidence of a default execution context, not access permission. Missing context/epoch and `truncated:true` must not be treated as complete evidence. Frame handles cannot be passed as node refs or AX roots.

The optional portable provider seam and runtime validator contain no Chromium or DSH dependency. MV3 lazily enables metadata discovery on the first frame query **or screenshot**: root Runtime events distinguish same-process frames; recursive iframe-only flat attachment covers OOPIF descendants. Each child enables Page/Runtime metadata and its own auto-attach. Only default-world contexts are retained. A late destroyed-context event with an old unique ID cannot erase a reused numeric-ID successor. Session detach and failed parent setup remove descendants; Stop/release/disconnect dispose the graph before queued detachment. Root setup failure revokes the lease instead of retaining partially configured attachment. A child setup failure conservatively marks coverage incomplete until the next lease.

Limits: 32 sessions including root, 256 frames and default contexts, depth 32, source inventory 128 KiB and public projection 96 KiB. Source acquisition has the caller/lease/runtime deadline and checks topology changes during the read. These bounds cover retained/projected state, not arbitrary single raw CDP response allocations or renderer memory. Frame IDs remain stable during observed document/context changes, while that child's document epoch changes; disappearance purges the mapping. Main-document replacement, lease release and reconnect prevent reuse. A missing frame may reflect a capacity boundary, not deletion proof. Frame queries never overwrite AX delta baselines.

The first real native frame run reproduced a screenshot permission bug: root `Page.getFrameTree` omitted already-attached OOPIFs. The last-mile screenshot gate now initializes the graph independently of the public frame tool, checks all session origins/completeness before capture, then rechecks authority and structural revision before returning pixels. Foreign/opaque/incomplete coverage is denied. Transient frame attach/detach during capture invalidates pixels even when the final tree looks unchanged. This remains conservative root-origin screenshot policy, not child-origin approval or authorized cross-origin compositing.

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing \
  pnpm test:frames-native /absolute/path/to/node_modules/@deepseek-ai/dsh
# Same production core and test oracle, using a fresh Edge profile:
DSH_CHROME_TEST_EXECUTABLE='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \
  DSH_TEST_BROWSER_BRAND=edge pnpm test:frames-native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

The CLI harness uses the existing Playwright/native test infrastructure, an owned loopback server and fresh profile only. `127.0.0.1 → localhost → 127.0.0.1` creates nested cross-site frames; same-process and sandboxed opaque frames are also present. Extension-owned CDP attachment events independently prove recursive flat sessions—not merely iframe DOM presence or Playwright's own sessions. Ten checks cover five-frame discovery, stable identities, explicit same-origin child reading/deltas and password-value omission, foreign/opaque/foreign-ancestor refusal, child navigation and stale-read rejection, OOPIF-to-same-process-and-back retargeting with read eligibility changes, parent/descendant removal, actual Stop/new consent and handoff with browser-confirmed debugger detachment. Chrome-for-Testing `151.0.7922.10` and Edge `152.0.4191.66`, DSH `0.1.5-rc.1`, each passed with zero topology retries and complete owned-resource cleanup. Reports: `output/playwright/{chrome,edge}-frames-native-smoke.json`; retained sanitized copies are under `docs/compatibility/`.

Still required by the full v2 plan: cross-origin frame authorization and reads, richer child input beyond the explicit same-process click below, OOPIF geometry/hit testing, broader navigation/retargeting races and real-page/model acceptance. Bounded child paging is now implemented below, but `oopif:false` remains correct. This is not completed iframe support or Codex parity.

### Explicit same-origin frame reads

Frame discovery itself still returns metadata only. To read one selected child, use the existing observation tool with its exact current identity:

```javascript
const inventory = await browser_frames({ leaseId });
const selected = inventory.frames.find(frame => frame.id === chosenFrameId);
const frame = { frameId: selected.id, documentEpoch: selected.documentEpoch };
const first = await browser_observe({ leaseId, frame });
const next = await browser_observe({ leaseId, frame, cursor: first.cursor });
```

The portable runtime validates current metadata before reading: target and every ancestor must have the leased root origin, complete ancestry and a current default context. A root-origin grandchild behind a foreign parent is denied, as are opaque/foreign targets, incomplete graphs, main-frame targets and stale epochs. Main-frame observation uses the ordinary path. No child URL/title is returned; `url/title` remain tab metadata while `scope:{kind:'frame',frameId}` identifies the content view. `documentEpoch` belongs to the child, not the root.

The extension accepts only internal `ax.frame({lease,binding})`, with exact root/child frame and loader IDs plus a unique default-context identity. It resolves the session from fresh metadata; requests cannot choose a raw session, backend node, script or wider subtree. The source uses [frame-aware Accessibility root/child queries](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-getRootAXNode) and enables AX identity tracking in the selected session. Every browser command checks graph revision after asynchronous lease lookup and immediately before dispatch, then again after its result. Final source and provider metadata checks discard a navigated/replaced/revoked read. Revision checks are deliberately conservative: unrelated frame/context churn may reject a read; no atomic arbitrary-DOM snapshot is claimed.

The existing bounded AX traversal and projection are reused: one selected frame only, stopping at nested iframe boundaries, with password values omitted. Node caches are separate from the root and from other frame documents; identical backend IDs cannot collide across scopes. At most eight child document caches per tab, each capped at 2,048 emitted identities, are retained in an LRU, in addition to the root cache. Cache eviction may yield fresh node refs on a later read; it never revives old ones. Navigation, context replacement, disappearance and lease revocation purge the corresponding caches. Delta cursors use the normal global cache budgets and exact frame/document scope, and the exported reducer rejects cross-scope application.

This is an increment toward full frame interaction: `frame` combines with exact `query`, known child `rootRef` scopes and bounded child page windows as described below. It is also supported separately for explicit child clicks. Child node refs and epochs are not valid root action targets. The same-origin source routing works with same-process or flat sessions in unit tests; real Chrome/Edge evidence covers same-process reading/paging, recursive OOPIF denial, and OOPIF-to-same-process retargeting followed by successful reading. It does not prove allowed cross-origin OOPIF content or input. `sameOriginFrameRead:true` is separate from still-false `oopif` action support.

### Exact same-origin child queries

`browser_observe({leaseId,frame,query,cursor?})` finds an exact accessible name and optional role within one currently authorized child document. It can locate an exposed control omitted by the default bounded view without returning the whole child tree. For example:

```javascript
const query = { name: '精确查找目标', role: 'button' };
const candidates = await browser_observe({ leaseId, frame, query });
// Inspect candidates; do not select the first result when several are plausible.
const update = await browser_observe({ leaseId, frame, query, cursor: candidates.cursor });
```

The portable optional seam is `findFrame(lease,frame,query,signal)`. Providers without it fail closed, never calling root `find` or substituting a whole-frame read. Results carry the child epoch and `scope:{kind:'query',frameId,query}`. Root queries, other frames, full-frame observations and different filters have separate delta bases. The exported reducer validates these scopes. Querying absent matches does not invalidate unrelated child refs; current query refs can be used by the existing explicit child-click path. Same-name candidates stay distinct, replacements get new refs, and action-time identity checks still apply. Known child `rootRef` scopes and child page windows are implemented below; fuzzy/substring/regex public search and automatic disambiguation are not implemented.

The internal command is `ax.frame.find({lease,request:{binding,query}})`, where `binding` contains the same exact root/child loader and unique default-context identity as `ax.frame`. No public caller backend root, object/session ID, expression or script is accepted. The newer scoped form below accepts only a provider-bound semantic root. Source authority validates all ancestors. The query obtains the explicitly named frame's [AX root](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-getRootAXNode), resolves that backend document in the bound default context and verifies `this === document`. It then invokes [queryAXTree](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-queryAXTree) at that exact DOM root. This API computes names/roles over a DOM subtree; selecting a session alone is not a document-isolation guarantee. Returned candidates are resolved in the same context, checked for connection and `ownerDocument === document`, and rechecked with object-bound partial AX identity. Out-of-document candidates are excluded with `truncated:true`; changed name/role identity fails the query. This is not an atomic snapshot of arbitrary page mutations.

The source reuses the bounded query projection: up to 2,048 raw candidates examined / 192 KiB projected bytes, then at most 128 candidates have ownership and identity verified. The ordinary public projection remains at most 120 controls and 24 named regions, bounded bytes. Excess candidates produce truncation; it is not a complete-result promise or an automatic request to select one. Query scopes share the eight-scope / 1,024-call bound and private object-group cleanup with geometry reads, but have a distinct fixed command/function allowlist and cannot issue input or geometry commands. Root and node objects are released before reply; revision checks after cleanup and fresh provider/runtime inventories reject navigation, changed ancestry and Stop. Bounds do not cap Chromium's raw query allocation/name-computation CPU or hostile renderer intrinsics.

`pnpm test:frame-query-native /absolute/path/to/node_modules/@deepseek-ai/dsh` uses `DSH_CHROME_TEST_EXECUTABLE`, and optionally `DSH_TEST_BROWSER_BRAND=edge`, like the other native gates. Real Chrome-for-Testing `151.0.7922.10` and Edge `152.0.4191.66` each pass eight assertion groups: finding a target omitted behind 220 controls, one trusted formal child click/no replay, same-name root/sibling/foreign-descendant exclusion, 20 distinct duplicate candidates and exact-base state delta, query/frame/root cursor separation, literal/role constraints, replacement identity, foreign/subtree denial, navigation and Stop/re-consent. The initial fixture placed the target at a shallower AX level and therefore did not actually omit it; it was corrected to share the sibling list with the preceding 220 controls while preserving the assertion that the target is absent from default observation. This is a test-fixture correction, not a product discovery bug. Reports: [Chrome](compatibility/2026-09-12-chrome-frame-query-native.json), [Edge](compatibility/2026-09-12-edge-frame-query-native.json). Only owned loopback pages/fresh profiles and controlled approval answers are used; no signed-in accounts, LLM, cloud vision or Codex parity evidence.

### Known child regions and contextual queries

Use a root ref obtained from the selected child's observation/query. The root can be a named region or another observed node; a frame handle, root-page ref or sibling-frame ref is not a child root. These are ordinary tool arguments, not an arbitrary JavaScript tool:

```javascript
const local = await browser_observe({ leaseId, frame, rootRef: billingRegion.id });
const matches = await browser_observe({
  leaseId, frame, rootRef: billingRegion.id,
  query: { name: '保存', role: 'button' }
});
```

`scope:{kind:'subtree',frameId,rootRef}` means a bounded view of that child region, even when `format:'full'`. Context queries use `{kind:'query',frameId,rootRef,query}`. Repeat the frame, root and optional query on every cursor read; changing any scope element resyncs the base. Omitting `rootRef` explicitly switches back to the selected frame/document query; a failed root never causes that switch automatically. `observeFrameSubtree` is an optional portable provider method; `findFrame` now has an optional root-ref argument. Root and child provider methods remain separate, and runtime verifies the returned scope and fresh frame authority before publication. These read roots do not grant new input authority or persist a region constraint on a later action; normal approval and current target identity still apply, and changed layout/context may require re-observation.

Provider caches supply the exact root's backend identity, complete name (up to 1,000 UTF-16 units), role and observed generic-editor capability. Source `ax.frame.subtree({lease,request:{binding,root}})` validates that structured root; `ax.frame.find` accepts the same optional `root`. Public tools never accept backend IDs or remote objects. Shared `withFrameNodeScope` binds the current child document, resolves the original root in its unique context, checks connection/document/semantic identity before and after acquisition, and releases all private objects before the final topology check. Root rename/role or editable-capability change, replacement, detachment, adoption by another document, navigation and Stop fail without rebinding to a lookalike. Root-page CDP identity calls are not used to validate child caches.

Subtree acquisition reuses the existing bounded AX walker at that exact root. Every emitted node must have a resolvable backend node, current AX name/role and composed ancestry reaching the original root in the same child document. The fixed membership function handles open Shadow DOM and slots, is bounded to 256 ancestor steps and excludes outside nodes, including ARIA-owned candidates that are outside this composed root. Missing identity, depth-limited/outside membership and projection limits may omit content with `truncated:true`; they are not proof of absence. The ordinary whole-frame reader is unchanged. Scoped acquisition additionally verifies at most 256 projected nodes; contextual query retains its 128-candidate bound. Both share eight active private scopes, 1,024 source calls/scope and one-second bounded cleanup. The AX walker retains its existing node/edge/depth/byte/call limits. This is not an atomic DOM snapshot or a bound on Chromium's individual raw CDP allocations; no arbitrary input/script is available through these read commands.

`pnpm test:frame-subtree-native /absolute/path/to/node_modules/@deepseek-ai/dsh` uses the same `DSH_CHROME_TEST_EXECUTABLE` and optional `DSH_TEST_BROWSER_BRAND=edge` as the other native gates. Chrome-for-Testing `151.0.7922.10` and Edge `152.0.4191.66` each pass seven assertion groups: local text/controls/Shadow DOM/slot membership, foreign/sibling exclusion, disambiguated trusted Billing-only Save/no replay, independent region/query/frame deltas, wrong root/sibling-ref refusal, renamed/replaced roots, adoption into another same-origin document, and actual Stop/re-consent. [Chrome](compatibility/2026-09-12-chrome-frame-subtree-native.json) / [Edge](compatibility/2026-09-12-edge-frame-subtree-native.json) retain source hashes and complete isolated cleanup. No daily accounts, LLM, actual human approval UI, cross-origin permission or Codex parity is tested. Richer child input and OOPIF action geometry remain pending.

### Bounded same-origin child page windows

`browser_read_page({leaseId,frame,rootRef?,continuation?})` extends the existing live-window contract to one current same-origin child document or an already observed root inside it. Repeat the exact frame and root on every continuation call. Tokens are single-use, expire after two minutes and bind the lease, child loader/context, root identity and traversal state; scope changes, reordering on the active path, root replacement/adoption, navigation, Stop and re-consent invalidate them. Returned windows keep `scope:{kind:'frame',frameId}` or `{kind:'subtree',frameId,rootRef}` and the child epoch, and never enter a nested frame or replace a delta baseline.

The optional portable seam is `readFramePage`; internal `ax.frame.page` reuses `withFrameNodeScope` and the shared bounded AX pager. The source validates document/root ownership before and after each window, while the provider retains the explicitly validated root across its 2,048-ref LRU churn. Whole-child traversal marks nested-frame omissions with `page.incomplete:true`. This reads mounted DOM only: it does not scroll, materialize virtualized items, provide an atomic snapshot or authorize input.

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing \
  pnpm test:frame-page-native /absolute/path/to/node_modules/@deepseek-ai/dsh
DSH_CHROME_TEST_EXECUTABLE='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \
  DSH_TEST_BROWSER_BRAND=edge pnpm test:frame-page-native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

On 2026-09-15 the assembled DSH → Broker → browser-started Native Host → MV3 gate passed seven groups on Chrome-for-Testing `151.0.7922.10` and Edge `153.0.4234.32`: 4,000 ordered controls across 81 windows, maximum result 5,943/5,942 bytes, final-window trusted click with no replay and text feedback outside the default bounded observation, token/scope/reorder/replacement/adoption denial, whole-child incomplete marking, navigation, actual Stop and re-consent. Owned-resource cleanup completed. Reports: [Chrome](compatibility/2026-09-15-chrome-frame-page-native.json), [Edge](compatibility/2026-09-15-edge-frame-page-native.json). These are isolated fixtures with controlled approvals, not signed-in-profile, model, latency or Codex-parity evidence.

### Explicit same-origin child clicks

Use the child's current frame/document identity and a node ref from its own observation. The top-level `documentEpoch` must equal `frame.documentEpoch`, not the root epoch:

```javascript
const child = await browser_observe({ leaseId, frame });
// Select the intended unambiguous control from this child observation.
const result = await browser_act({
  requestId: uniqueRequestId, leaseId,
  documentEpoch: frame.documentEpoch, frame,
  action: { kind: 'click', ref: chosenChildNode.id,
    expected: { kind: 'text', text: '子帧已完成' } },
  timeoutMs: 3000
});
```

Only `click` and an optional text expectation are currently accepted in a frame action. Missing `frame` never infers a child from a node ref. Main-frame targets, mixed epochs, child fill/append/check/press/scroll/wheel/navigation, other expectation types and batch frame fields are rejected. `action.frame` is invalid: the scope belongs on the request. A text postcondition is tested only inside that exact child, not the root or a descendant frame. For a nonblank expectation up to 1,000 UTF-16 units, a document-bound AX name query confirms feedback even when the ordinary bounded child observation cannot reach it; up to 128 candidates are revalidated and only `{present:boolean}` leaves MV3. Negative/longer checks retain the ordinary bounded-observation substring fallback. The returned action observation remains frame-scoped and may not itself contain independently confirmed off-window text. A pre-existing match can satisfy the condition, so choose a meaningful expected result. No expectation means `unknown`/`unverified`, not confirmed success.

The DSH tool remains approval-gated; portable policy receives a separate immutable copy of the action and frame. Runtime checks the current same-origin ancestor chain before durable reservation/provider work and after result acquisition. Providers without both frame discovery and `actFrame` fail closed; no root-action fallback exists. The Chromium provider binds the child cache's exact backend ID, role/name, document loader and unique default context. Source `frame.click.prepare` performs read-only identity/actionability/ancestor geometry checks. After preparation, the provider rechecks metadata/cache identity and marks durable dispatch intent **before** `frame.click` is sent. The dispatch command reacquires private objects and repeats checks, then sends one graph/lease/Stop-fenced mouse-down/up pair in the root session. No caller coordinates, raw sessions, scripts, object groups or reusable geometry tickets are accepted. Groups are released before a reply, and post-cleanup graph changes discard that reply.

Preparation failures are `notDispatched`. Once the dispatch command begins, source refusal or a lost acknowledgement can be conservatively `unknown` even if no mouse event reached the page; this is not exact physical dispatch knowledge. A topology change or lost acknowledgement after down prevents further delivery/retry. Repeating the same request ID/payload retrieves the old result or metadata-only `RECOVERY_REQUIRED`, never a new click. The frame is included in the durable payload hash. A fresh ID is **not** a safe way to blindly retry an uncertain action. Public DSH approval may be asked again on a duplicate call; runtime input is still deduplicated. Stop during approval invalidates authority even if a late answer allows the old request.

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing \
  pnpm test:frame-click-native /absolute/path/to/node_modules/@deepseek-ai/dsh
DSH_CHROME_TEST_EXECUTABLE='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \
  DSH_TEST_BROWSER_BRAND=edge pnpm test:frame-click-native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

The CLI gate uses real DSH ToolRuntime/public ApprovalService with controlled local answerers, an independent Broker, actual browser-started Native Host/MV3 and fresh profiles. Playwright sets up owned loopback fixtures and reads independent event oracles; it does not perform the clicks under test. Chrome-for-Testing `151.0.7922.10` and Edge `152.0.4191.66` each pass 11 assertion groups: two transformed/bordered/padded same-origin levels beside a foreign sibling; trusted click and child-only verification; replay/no-expectation/timeout behavior; root overlay, rename/replacement, foreign-frame and old-document refusal; actual approval denial, Stop during pending approval, and Broker SIGKILL after a click. Each run pairs all 17 approval asks with one decision and fully cleans up owned resources. Reports with source/build hashes: [Chrome](compatibility/2026-09-12-chrome-frame-click-native.json), [Edge](compatibility/2026-09-12-edge-frame-click-native.json).

This is not full iframe support: only same-origin ancestors in the root process, a currently exposed actionable point, and text verification. OOPIF geometry, approved foreign origins, child scrolling/automatic reveal, fill/keys/state predicates, child batches, hostile renderer intrinsics and general moving-page accuracy remain missing. Frame read bounds and geometry call/depth bounds still apply; repeated action rechecks can exhaust the 1,024-call budget before the nominal 32-boundary maximum, and maximum-depth input is not certified. These are current-state rechecks, not an atomic lock against future DOM/layout changes, human UI/model approval, signed-in profile acceptance or Codex latency/accuracy parity. `sameOriginFrameClick:true` is separate from still-false `oopif` support.

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

   For an explicitly opted-in personal profile, use `--access-mode=personal` instead of any `--allow-origin` argument. The modes are mutually exclusive. Personal mode lists only extension-consented tabs, but issues a tab-scoped lease that can be rebound to that same tab's current HTTP(S) root origin.

4. In another terminal run `node scripts/dev-fixtures.mjs`, then open `http://127.0.0.1:18765/` in the selected Chrome profile. Open the extension popup and choose “允许当前标签页并连接”.
5. Run `node bin/dsh-native-browser.mjs doctor --browser=chrome --extension-id=<id>`. It reports installation and connection checks with actionable findings, as described below. Use `status` separately if you deliberately want raw connected-instance details.
6. Mount this local bundle in a dedicated DSH development profile using that DSH version's documented local-plugin mechanism. The plugin requires the `tools` service; `browser_screenshot` also requires `attachments`. Do not replace the user's production profile as part of a test.

All CLI commands accept `--runtime-dir=/absolute/private/directory`. When using a nondefault directory, the DSH plugin config must set `runtimeDirectory` to the same path. Directory permissions must be `0700`; the token, lock database and newly bound socket are `0600`. Startup now recovers an eligible stale socket while holding process-lifetime ownership, as described below. Do not manually remove the lock database or recovery journal to bypass a startup failure.

### Approval modes

The adapter defaults to `approvalMode: per-action`: claim, each ordinary action and each screenshot ask through DSH, while every batch step receives its own approval. `per-lease` asks once when a tab is claimed, then allows actions, screenshots and batch steps for that short-lived lease. The Broker, exact tab lease, extension popup consent, expiry and Stop button remain enforced in every mode; restricted modes additionally retain the exact root-origin boundary.

`trusted` is the prompt-free development mode. It requires one or more exact origins; paths are normalized away, ports remain significant, and wildcards are rejected. Before and after claim, the adapter verifies that the selected tab is still on a configured origin. Keep this list narrow and match it to the Broker allowlist:

```yaml
- id: native-browser
  config:
    approvalMode: trusted
    trustedOrigins:
      - http://127.0.0.1:18765
```

Do not use `trusted` as a global “all websites” switch. Changing DSH's general filesystem permission does not override this browser-specific policy; configure the adapter explicitly. For signed-in or consequential sites, start with `per-lease` or `per-action`.

`personal` is the opt-in prompt-free mode for ordinary browsing in a personal Chrome profile. It requires the Broker to be started separately with `--access-mode=personal`, rejects `trustedOrigins`, follows only the same extension-consented tab across credential-free HTTP(S) root navigations, and keeps its short-lived lease across turns in the same DSH conversation. Switching the foreground conversation, disposing the Session, lease expiry, explicit handoff, disconnect or Stop still revokes it. A newly selected existing Chrome tab still needs its own popup consent.

```yaml
- id: native-browser
  config:
    approvalMode: personal
```

The alpha cannot reliably infer whether an arbitrary click submits a payment, publishes content or performs another irreversible business operation. Personal mode therefore does not implement the future sensitive-action confirmation layer and must not be used for those workflows.

The Chrome extension also draws a short-lived virtual pointer after a verified click or wheel event is dispatched. It runs in an isolated world, is inert and accessibility-hidden. HTTP/HTTPS injection is declared as an optional host permission and requested from Chrome only when the user clicks the popup's tab-consent button; this lets the pointer survive cross-site navigation in personal mode. The overlay is human feedback only: it cannot supply coordinates, influence target selection, grant browser control or cause retries. An existing unpacked installation must be reloaded after upgrading, then the optional permission must be accepted once.

### Foreground conversation handoff

The package includes a DSH Web client module in `client.js`. It subscribes to the Session Controller's canonical `sessions.list.current` value rather than scraping the URL, sidebar or DOM. A visible DSH document reports only an opaque client ID, monotonic revision, timestamp and selected session ID over DSH Connection's existing RPC transport. The Host registers that route with `trusted-host` authority, bounds every field, rejects stale/out-of-order updates and retains at most 64 client revision entries. Browser leases, screenshots and page content never cross into this UI bridge.

An accepted selection change synchronously aborts all browser scopes owned by other DSH sessions, revokes pending screenshot publication and starts asynchronous Broker cleanup. The selected conversation does not inherit a lease or wire owner; its next browser tool call creates a fresh owner and must claim the tab under the configured approval mode. In local `trusted` mode that reclaim is prompt-free only for an exact configured origin. In `personal` mode a lease may survive turn boundaries inside the same conversation, but foreground switching and `session/disposed` still revoke it; other modes also release on `turn/end`.

Hidden DSH documents do not publish selection changes. Becoming visible or reconnecting reasserts the current selection, and per-page serialized revisions prevent an older queued selection from overtaking a newer one. If multiple DSH windows are simultaneously visible, the newest valid report wins. Switching conversations while a browser tool is running intentionally returns a lease-revoked/cancelled path to the old task; already-dispatched browser input cannot be undone.

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
| `browser_claim` | Request a short-lived exclusive tab lease; approval follows `approvalMode` |
| `browser_observe` | AX text/controls/named regions; optional `query` for exact name/role search, `rootRef` for a contextual subtree, and per-consumer cursor for deltas/resync |
| `browser_read_page` | Explicit bounded live traversal windows of the document or a known root; single-use, lease/document/scope-bound continuation; separate from snapshot/delta cursors |
| `browser_frames` | Bounded frame/document/origin metadata with opaque handles; discovery never grants child AX, input or screenshot permission |
| `browser_act` | Click/fill/append/check, press a named page key, scroll an exact document/element, send wheel input to an observed target, or navigate within the leased origin; action-specific postconditions; approval follows `approvalMode` |
| `browser_batch` | 1–8 explicit actions in one tab queue slot; shared deadline, approval follows `approvalMode`, stop on failure/uncertainty and whole-plan replay fence |
| `browser_screenshot` | Capture viewport into a Host image attachment; approval follows `approvalMode` |
| `browser_handoff` | Release debugger/control and keep the tab open |

The lease lasts up to two minutes in this preview. On expiry/release/disconnect, old commands cannot resume with the old token. The extension Stop button closes its local gate before contacting the Broker. Already-dispatched inputs cannot be undone.

The DSH adapter binds each execution to its owning turn **before** waiting for approval. `turn/end`, session disposal, and an accepted foreground-conversation change synchronously cancel the affected session's pending approvals/connection work and in-flight operations, then release its Broker owner. Each new turn gets a new opaque wire owner, so delayed cleanup from an earlier turn cannot release its successor. A screenshot already being stored locally may finish storage, but is not returned to an ended execution. This is not a claim that the plugin can override a malicious same-process plugin or undo already-dispatched browser input.

A click or key press without a verifiable expected result returns `unknown`, not fabricated success. Fill supports visible text inputs/textarea and bounded contenteditable editing hosts as described below, not password entry, file inputs or arbitrary framework editors. `Input.insertText` has been checked with Chinese text; that is not the same as full IME-event support.

Actionability waits for the same target's semantic identity, visibility, enabled state, stable geometry and a verified exposed hit point. Candidate points come from up to 16 actual client-rect fragments intersected with the viewport and ancestor overflow clips, with at most nine points per fragment (144 candidates). This avoids blindly clicking a multiline link's empty bounding-box center or rejecting a partly exposed button. Ancestor walks are bounded to 64 and open-shadow hit descent to 16; exceeding the bounds fails closed. Noninteractive text/icon descendants are valid hits, but a nested independent control cannot be clicked on behalf of its parent.

Immediately before mouse-down the provider rechecks the selected coordinate and geometry; it never silently changes to a different point at that boundary. Offscreen targets are scrolled into view once. Page events wake read predicates, with bounded polling when events are absent; predicates and dispatch share one action deadline (default 10 seconds, maximum 30 seconds). Covered elements and delayed results therefore get time to become ready without replaying the click/input. Empty fill uses a real Backspace key pair after selection. RPC cancellation preserves typed local deadline/lease/Stop reasons instead of labeling every abort as user cancellation.

The live fixtures verify trusted events on partial overlays, multiline links, narrow overflow clips and open-shadow buttons, and no input to nested independent controls. Candidate sampling can miss narrow/complex/transformed regions, ancestor bounding rectangles only approximate transformed clips, and renderer APIs are not an isolated-world proof against page monkeypatching. The final read is not atomic with later page/human changes or input dispatch. Closed shadow roots, OOPIFs, hover-dependent layouts and general complex-animation reliability remain unproven.

### Element-state postconditions

Non-navigation actions can additionally wait for a state on another **already observed, connected node**:

```js
await browserAct({
  requestId: 'refresh-eligibility-1', leaseId, documentEpoch: snapshot.documentEpoch,
  action: {
    kind: 'click', ref: refreshButton.id,
    expected: { kind: 'state', ref: initiallyDisabledContinueButton.id, state: 'enabled' },
  },
  timeoutMs: 4000,
});
```

The Chromium provider resolves the expected ref's original backend node before any action-side input or auto-scroll, checks its current document/semantic identity and predicate support, and retains that exact remote object until cleanup. It uses a fixed read-only renderer predicate, not arbitrary selectors, model JavaScript, DOM-value assignment or simulated events. It never switches to a same-name replacement. Ordinary action approval, current lease/origin checks, last-hop cancellation and request-ID payload fencing still apply; changing the expected ref/state with the same request ID is a conflict.

| State | Meaning on the retained original node |
|---|---|
| `attached` / `detached` | Connected to / disconnected from the current document. An unavailable object, lost connection, adopted foreign document or navigation is an error, not detachment proof. |
| `visible` / `hidden` | Nonempty bounding box with computed `visibility: visible`, or its absence; `hidden` also includes detachment. Offscreen and opacity-zero nodes can still be visible. This is not viewport intersection, clipping, painted pixels, stable geometry or pointer actionability. |
| `enabled` / `disabled` | Supported native form elements or explicit supported ARIA control roles; native `:disabled` plus composed ancestor ARIA-disabled/inert checks (64-level bound). Readonly is distinct from disabled. Disconnected nodes satisfy neither state. Arbitrary structural regions/generic editing hosts without supported control semantics are refused. |
| `checked` / `unchecked` | Current native checkbox/radio property or explicit ARIA checkbox/switch/radio state. Mixed satisfies neither; unsupported/missing ARIA state is refused. This read does not toggle a control or claim the `check` action supports custom ARIA radios. |

The visibility distinction follows the conceptual separation in [Playwright's actionability documentation](https://playwright.dev/docs/actionability); this bounded predicate is not an implementation-parity claim. Connection checks use the node's [document connection](https://developer.mozilla.org/en-US/docs/Web/API/Node/isConnected), not disappearance from a truncated AX view.

After input, the predicate shares the action's deadline and event-hinted wait loop. It must match before acquiring the result observation and again afterward in the same document epoch. Native fill with a state condition also verifies the requested full input value before and after that result path, so an already-enabled button cannot mask prevented/truncated input. Contenteditable fill, append, checked actions and scrolling keep their own existing result verification in addition to the state condition. Handles are released on exit where the connection still permits cleanup.

A condition asserts current state, **not a transition or business causation**. If already true, it may pass without seeing an intermediate false state. Likewise, `detached`/`hidden` on an original dialog does not establish that no replacement dialog or other lookalike exists. Use separate observation or a task oracle for those claims. Names/roles are checked while binding, then the predicate follows object identity rather than re-running a locator. Removal followed by reattachment of the same object is distinguishable from replacement.

Refs must still be resolvable in the current semantic view at action start. Waiting for a not-yet-created node or an initially AX-ignored hidden node needs a future discovery/wait API; do not invent refs. The `navigate` action rejects state expectations before dispatch, and navigation caused by another action invalidates the bound expectation even on the same origin. Cross-frame state discovery, arbitrary CSS/framework semantics, atomic protection against all future page changes, and hostile renderer monkeypatching remain unproven. Post-dispatch timeout/uncertainty stays unknown and does not replay the input.

`test/element-state.test.mjs`, provider/adapter regressions and `scripts/verify-element-state.mjs` cover the contract, public schema, per-action approval, delayed conditions, fieldset inheritance, Shadow DOM, original-node removal/reattachment, replacement rejection, unsupported/stale preflight, cancelled/lost-object/navigation checks, post-observation recheck, prevented fill and action-specific result paths. The live helper runs both direct Chrome and assembled DSH/native, checking trusted triggering events and repeat-request counts. Clients require `runtime.element-state.v1`; connected Chromium instances advertise `stateExpectations: true`. The fixed predicate uses the existing gated CDP route, with no new raw model-facing browser command. Update the Broker and client together; these conditions are not yet included in the frozen initial 20-task performance baseline.

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

### Contenteditable fill

Use the existing `fill` action with the editing host's observed ref and the entire desired replacement text, including an empty string to clear it. Hosts with `role="textbox"` and focusable generic AX nodes reported as editable are supported. Generic nodes retain their authentic `role: "generic"` and expose `editable: true`; exact accessible-name queries can find them too. No role is fabricated, no DOM selector/name fallback is used, and losing that observed editing capability invalidates the old identity. An open-shadow host uses its own focus/selection root.

```js
await browserAct({
  requestId: 'replace-editor-1', leaseId, documentEpoch: snapshot.documentEpoch,
  action: { kind: 'fill', ref: editor.id, text: '第一行🙂\n第二行' },
});
```

This **replaces all editor text and can remove formatting**; it is not insertion at the caret, a rich-document patch or append. After visible/stable/hit checks, a fixed renderer program checks the exact editing host, read-only/disabled/inert ancestry, and absence of protected/nested editing islands or embedded form controls. Inspection is bounded to 4,096 descendants, 100,000 existing text code units and 64 ancestors. It focuses the host, selects its contents with a Range, verifies browser AX focus and DOM focus, then rechecks that the current selection covers the entire same host. Shadow-root range normalization to first/last leaves is accepted only when the structural endpoints are equivalent; matching selected text alone is not proof.

Replacement uses [CDP `Input.insertText`](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-insertText), or one Backspace down/up pair for clearing. It never assigns editor `innerHTML`/`textContent` and never dispatches synthetic DOM input events. Focus/selection are themselves potentially side-effecting: later cancellation/focus theft/selection collapse stays conservatively unknown. These checks are not atomic with subsequent renderer/human changes; Stop and cancellation still gate every CDP command.

The provider always verifies the full logical editing text, then any additional text/URL postcondition, then identity/text again after result observation. An explicit `expected: {kind:"value",value:...}` must equal the replacement text. A page message cannot mask a refused edit. Verification recognizes bounded inline/DIV/P/BR editing structures, including Chromium's terminal caret-placeholder BR and blank lines; it does not trim whitespace or compare only a substring. The logical-text reader is capped at 4,096 nodes, depth 64 and 10,000 output code units. Unsupported resulting structures, framework rewrites and unconfirmed edits are not reported as success or automatically repeated. This is not a general HTML/CSS text serializer; custom whitespace/layout and rich-editor frameworks still need acceptance fixtures.

The live fixture tests Chinese/emoji/multiline replacement, plaintext-only and ordinary contenteditable, leading/trailing whitespace and blank lines against Chrome's independent copy-text behavior, empty deletion, open shadow roots, generic-role discovery/search, request deduplication, read-only/protected/oversized refusal, real beforeinput cancellation, stolen focus/selection and replaced refs. Input events are checked for `isTrusted`, not inferred from a CDP acknowledgement. Unit tests add post-observation mutation, cancellation, lost acknowledgement, acquisition metadata and byte/node/depth bounds. Neither this nor [Playwright's contenteditable fill support](https://playwright.dev/docs/input#text-input) proves IME composition, arbitrary editor-framework compatibility or cross-frame support.

Current clients require `runtime.contenteditable-fill.v1`; the Broker additionally requires provider `ax.editable-state.v1` for projected generic-editor metadata. Upgrade/restart Broker, DSH adapter and extension together. The extension's CDP input allowlist is unchanged; the portable runtime/action format and request replay fences are reused.

### Append without refilling

`{ kind: "append", ref, text, expected? }` adds a suffix at the **end** of the observed field. It is not insertion at an arbitrary current caret and does not reconstruct/refill the entire field. It supports native textarea, input types text/search/url/tel, and the contenteditable hosts described above. Native email/number/password/file/date inputs are deliberately excluded: the append path requires usable native selection offsets and never reads password values. Single-line inputs reject appended CR/LF before focus; textarea/editor newline handling still requires exact final-value verification.

```js
await browserAct({
  requestId: 'append-draft-1', leaseId, documentEpoch: snapshot.documentEpoch,
  action: { kind: 'append', ref: editor.id, text: '\n补充说明：请保留已有内容。' },
});
```

After ordinary actionability, the provider captures the current bounded prefix. It moves a collapsed caret to the end using native [setSelectionRange](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#dom-textarea/input-setselectionrange) or a collapsed editor Range. Browser AX/DOM focus checks then precede one final same-call read of the prefix and caret position. A changed prefix, unsupported/readonly state, moved caret or updated maxlength prevents insertion; it never rereads a changed prefix and silently tries again. Only the suffix is sent through `Input.insertText`, preserving existing DOM nodes/formatting subject to the browser's normal editing behavior. A valid empty suffix verifies current content without focus or input; ordinary actionability/scrolling checks still apply.

The suffix and resulting combined value are each limited to 10,000 UTF-16 code units. Native maxlength is checked before focus and again before insertion, rather than treating browser truncation as success. An explicit value expectation must include the old prefix and equal the combined value. The full combined text must match before any extra page text/URL postcondition and again after result observation. Page handlers preventing/truncating/rewriting input, lost acknowledgements or uncertain outcomes do not trigger another insertion. This is a current-prefix check, not a document lock or atomic compare-and-swap against later page/user edits.

`scripts/verify-append.mjs` runs through both direct Chrome and actual DSH/Native Host/MV3: trusted suffix-only event data, selected-input replacement avoidance, textarea/newlines, rich-format node preservation, generic and open-shadow hosts, empty/trailing-newline editors, empty suffix, maxlength/protected/native-type refusal, page focus-value changes, shifted caret, cancelled beforeinput and stale refs. Unit tests additionally cover cancellation, changed final values, lost-ack deduplication, renderer bounds, capability negotiation and durable append-journal reopen without text retention. This does not establish full IME or arbitrary framework-editor support.

Clients require `runtime.append.v1`; an older Broker is rejected rather than treating append as fill. No new extension CDP command or brand-specific runtime branch was added. Journals now recognize `kind: "append"`; older builds may refuse such journals on downgrade. Do not delete replay fences to force a downgrade.

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

For `navigate`, use a credential-free absolute HTTP(S) URL. Restricted leases require the exact current origin. A `scope=tab` lease issued only by the personal Broker may navigate the same consented tab to another HTTP(S) origin; the runtime then rebinds later operations to the tab's freshly observed root origin. The result waits for the returned document loader (if any), document readiness and the expected result. Redirects or navigation races outside the declared destination are denied, though already-started navigation cannot be undone. All old-document node references become invalid. An unexpected timeout after dispatch returns `unknown`, so callers should observe the page instead of issuing a fresh duplicate action.

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

`BrowserProvider.observeSubtree` is optional and browser-independent. Providers without it fail with `UNSUPPORTED_CAPABILITY`; a provider returning a different scope is rejected. A future non-Chromium provider can implement this seam without browser code in the runtime. Initial discovery, action-result observations and known subtrees all use bounded acquisition now. For sequential discovery beyond the default snapshot, use the separate [live page window API](#live-page-windows); exact semantic search below remains useful when the target's name is known. Event-driven dirty-subtree acquisition and iframe/OOPIF interaction remain pending. Update the Broker and extension together for this preview's new internal commands; an old extension rejects them rather than falling back to an unbounded read.

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

## Live page windows

`browser_read_page` is an explicit read-only discovery tool, separate from `browser_observe` snapshots/deltas. It starts at the current authorized document or an exact known `rootRef` and walks the currently exposed AX subtree in depth-first order. [Chrome's Accessibility API](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) supplies the root, exact backend subtree and child-node reads; `Accessibility.enable` keeps AX identities stable between calls. The default observation/action path is unchanged and does not automatically enumerate the whole page.

```js
const first = await browser_read_page({ leaseId, rootRef });
// Repeat the exact scope; omit rootRef on both calls for document windows.
if (first.page.continuation) {
  const second = await browser_read_page({
    leaseId, rootRef, continuation: first.page.continuation
  });
}
```

These calls illustrate tool arguments, not a model-facing JavaScript executor. Each response contains ordinary observation fields plus `page: { index, incomplete, continuation? }`; there is no snapshot `cursor`, `format` or delta. A window never replaces the whole document/subtree baseline, and runtime-core never inserts it into the delta cache. Accumulate windows explicitly as historical observations; a later window does not prove that earlier controls/text remain current. Query filtering and delta cursors cannot be mixed into a page request.

`page.continuation` means more traversal work is pending. Its absence means this traversal ended; check `page.incomplete` before interpreting coverage. Frame boundaries, depth limits and oversized names/text mark the walk incomplete, even at its end. Other state/call/response limits fail explicitly with `QUEUE_FULL`, not silent scope widening. `truncated` is true exactly when another token is present or the walk is incomplete. Empty windows are possible when bounded work traverses ignored/structural nodes; a continuation still matters. This is current-DOM discovery, not virtualized-list pagination: absent/unmounted rows require separate, explicitly approved scrolling or site interaction.

The source-side continuation stores only an active DFS path, child identities/offsets, visited IDs, scope and expiry—not page text, form values or projected future windows. On every continuation it obtains a fresh root and re-reads the active ancestor path, requiring the same AX identities and child order before consuming saved offsets. Upcoming content is read again instead of replaying cached text. Changed active structure or a same-name replacement yields `STALE_TARGET`; start a fresh, appropriately scoped read. Already-completed branches may change without detection, and scripts may mutate during one read: this is **not an atomic snapshot, complete mutation log or globally consistent whole-page scan**. Action-time target checks remain mandatory.

Tokens are random, single-use and bound to the exact extension lease token, root frame/document loader and optional backend root. Public root refs remain required on every scoped continuation; omitting one cannot widen access. A failed or cancelled request after consumption does not rewind or resurrect its token; uncertain transport delivery may require a fresh read. A token grants no lease or origin authority. The normal owner/read-policy/serial-queue/deadline and extension last-mile checks apply to every window. Stop, release and disconnect revoke retained/active paging state; root navigation invalidates its tokens. Provider reboot and MV3 restart do not restore them.

Bounds per extension: at most eight live/active traversals; fixed two-minute lifetime (not renewed by reading, expired entries pruned on access); at most 100 projected AX entries and 16 KiB entry bytes per window, with at most 24 named regions; at most 128 AX calls per window; depth 64, 8,192 children in one list, 32,768 entries in a received sibling response, 16,384 visited identities and 256 KiB serialized retained state per traversal. Ephemeral acquisition caches are separately capped at 256 normalized nodes/1 MiB. Browser/native framing and runtime 96 KiB result bounds apply as well. These bound retained application data, not Chrome's allocation of one CDP sibling response, all transient serialization memory or a process RSS/latency ceiling. Narrow the requested region when capacity is reached.

The shared provider's existing 2,048-ref LRU remains bounded. Each successfully revalidated paging root is refreshed so scanning more than 2,048 controls does not evict the active root. Earlier window refs can still age out; final-window refs are ordinary action refs and must pass the same identity/actionability checks. A last window does not imply other retained refs disappeared and therefore never purges them as a complete document observation would.

The portable `BrowserProvider.readPage` seam is optional; missing support fails with `UNSUPPORTED_CAPABILITY`. Current clients require `runtime.page.v1`, the Broker requires provider `ax.page.v1`, and connected instances advertise `pageWindows: true`. Chromium/MV3 traversal remains outside runtime-core, so another browser family can implement the same observation-window contract. Update the full development stack together.

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing \
  pnpm test:page-native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

The isolated real DSH → Broker → Chrome-started Native Host → MV3 test reads 4,000 controls in 81 windows, without duplicate refs/names, then clicks the last window's button and verifies a trusted browser event. It also checks scope widening refusal, fresh upcoming text, single-use replay rejection, active-order changes, same-name root replacement, actual popup Stop/re-consent and same-origin full navigation. `output/playwright/page-native-smoke.json` records seven checks, per-run response size and owned-resource cleanup. This does not measure model-call latency, Codex parity, production sites or infinite/virtualized-list completeness; the initial L1 benchmark predates page windows.

## Bounded action batches

`browser_batch` combines already planned actions into one model tool call, not a JavaScript interpreter. For a currently observed input and a same-document result:

```js
// leaseId, documentEpoch and inputRef come from the current approved observation.
browser_batch({
  requestId: "unique-search-request",
  leaseId, documentEpoch, timeoutMs: 20000,
  steps: [
    { action: { kind: "fill", ref: inputRef, text: "浏览器插件" } },
    { action: { kind: "press", ref: inputRef, key: "Enter",
        expected: { kind: "text", text: "Search complete" } }, timeoutMs: 5000 }
  ]
})
```

Replace the expected text with a real, independently meaningful page condition. A fill verifies its final value; click/press/wheel need explicit supported postconditions to permit continuation. There are no variable bindings for newly created refs, nested batches, loops, arbitrary scripts or authority-expanding navigation. All refs belong to the initial document. Explicit navigation may only be the last step. An implicit document change after an otherwise successful non-final step ends the batch with `STALE_TARGET`; other stale-target failures also stop it. End the plan at a page boundary and observe again with approved control.

The overall deadline defaults to, and cannot exceed, 30 seconds. It includes connection work on the adapter side, queue waiting and all approval/action waits; a step timeout cannot extend it. Steps execute under one tab queue slot, so other queued actions/reads do not interleave between steps, including during approvals. This is not isolation from the human, page scripts or another browser actor. Stop, handoff, turn end, lease expiry and transport cancellation can interrupt the batch; already-dispatched effects cannot be rolled back. Slow filesystem settlement and non-cooperative third-party callbacks are not hard real-time cancellable.

Each step calls the public DSH `approval.request` service with `toolName: "browser_batch"`, the owning agent and the outer tool `callId`. Its reason identifies the exact step index/kind and a digest; review the corresponding full arguments displayed for that call. Reasons do not duplicate entered strings or page payloads. Only `allowed-once` grants that step. Missing/unavailable approval service, denial or cancellation fails closed. There is no blanket approval or fallback auto-approval. This uses the parent `browser_batch` Host tool policy plus the public per-step approval service; it does **not** recursively execute `browser_act` or inherit tool-specific middleware attached only to that other name. Keep the new tool appropriately restricted in DSH. Automatic classification of high-risk business steps remains future work; this preview is still unsuitable for payments/destructive business operations.

The adapter permits at most eight active/queued batch approval contexts. Internal callbacks are bound to the exact connection, turn, private approval ID and next step index. Repeated, skipped or old-connection callbacks are refused, and late grants cannot revive cancelled work. Runtime policy and lease checks run again after each asynchronous approval; the provider retains its normal target/actionability and last-mile input gates.

Results include `totalSteps`, a `steps` array of `attempted`/`notRun` entries, and at most the last attempted step's observation. `attempted` includes approval refusal or pre-input validation failure: inspect its `dispatch`, `outcome` and `code`, not just that label. Step entries contain metadata, not observations or scroll payloads. A later failure without an observation never returns an earlier step's page as if current. The root dispatch flag conservatively indicates whether **any** child may have dispatched; it is not a count. Partial success is neither an atomic transaction nor an automatic resume point.

The durable journal reserves the whole plan before any child, then reserves each executable child before provider work. Root plus children use up to nine identity slots; reaching capacity mid-plan stops the remaining work, rather than evicting fences. Reserved `batch:` request IDs belong to internal children and are rejected by public actions/batches. Repeating the same outer ID/payload retrieves the historical whole result, never reruns or resumes skipped steps; a changed payload conflicts. If payloads were evicted or the Broker restarted, `RECOVERY_REQUIRED` returns metadata only. Missing `steps` means historical per-step progress is unknown, **not** that nothing ran. Recovery does not restore a lease; do not issue a new ID to blindly continue. New journal kind `batch` requires this build or newer: an older reader may fail closed. Never erase recovery records to force a downgrade.

Current clients require `runtime.batch.v1`; instances advertise `batch: true`. The orchestration remains in portable runtime-core and uses existing provider actions, without a new MV3/CDP input capability. This is a reduction in model-call count for explicit sequences, not measured end-to-end model latency or Codex parity. The frozen initial L1 benchmark predates batching and does not measure it.

To verify the assembled batch/approval path in an isolated profile:

```bash
DSH_CHROME_TEST_EXECUTABLE=/absolute/path/to/chrome-for-testing \
  pnpm test:batch-native /absolute/path/to/node_modules/@deepseek-ai/dsh
```

`scripts/smoke-batch-native.mjs` mounts the installed public DSH ApprovalService with a controlled local answerer, real Session/audit and ToolRuntime, then the production Broker/Native Host/MV3/Chrome chain. It checks Chinese fill+Enter and whole-batch deduplication, step rejection, real Session `never` policy, unknown-result cutoff, actual popup Stop during approval and SIGKILL of its own Broker after the first input. Restart returns reserved historical metadata without another Enter or resuming skipped steps. The retained report is `output/playwright/batch-native-smoke.json`; the verified run had seven checks and 16 uniquely paired asked/decided audit events. The test validates the service boundary, not a human approval UI, model planning or a signed-in profile. Only owned temporary test processes/profiles are changed and removed.

## Known limitations

- Most actions remain root-document-only. Explicit same-origin ancestor-chain child reading and same-process child click/text verification are supported; no child fill/keys/scroll/batches, cross-origin frame reading/screenshots, or open/upload/download tools yet. Batches use only explicit current refs; new-ref bindings and richer workflow/risk boundaries remain pending.
- Document discovery, action-result reads and known subtrees use bounded source traversal; exact semantic search and explicit live windows can read beyond the default view. Event-driven incremental acquisition, globally consistent scans and virtualized-list workflows remain pending. Hard traversal bounds can still require a narrower region. Large individual CDP sibling/query responses are not browser-memory-bounded.
- Actionability uses event hints plus polling and bounded fragment-based hit-point selection. Named page keys, explicit DOM scrolling and single native wheel samples exist; continuous trackpad gestures, richer keyboard/IME/editor behavior, hover-dependent/complex layout and animation handling remain pending.
- Screenshot JPEG is bounded to the initial control-channel budget; chunked blobs are still pending.
- Native host/Broker/extension/DSH are verified together in an isolated Chrome-for-Testing profile, not yet inside the user's regular signed-in profile or via an actual agent/model turn.
- Durable short-lived action fences, same-adapter-turn metadata recovery and ownership-guarded stale-socket recovery exist. DSH-process recovery identity, corrupt/bootstrap/interrupted-compaction repair, complete lifecycle/resource reconciliation, heartbeat renewal, unattended installer, store signing and production benchmarks remain pending. Browser reconnect/control is still explicit, not transparent automatic resumption.
- Edge shares the same extension/runtime source and now passes the isolated early native compatibility smoke. Full P5 acceptance, regular signed-in profiles, enterprise policies, lifecycle matrix, store/distribution and formal support remain pending.

See [implementation progress](implementation-progress.md) for the remaining planned gates.
