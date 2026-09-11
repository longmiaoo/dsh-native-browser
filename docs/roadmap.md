# Chrome-first roadmap

This roadmap is ordered by risk retirement, not feature count. Dates are intentionally absent until the first benchmark harness is running.

## Phase 0 — foundation (current)

- [x] Create the public repository and DSH/GitHub discovery metadata.
- [x] Add a valid, capability-free DSH bundle scaffold.
- [x] Document the Codex comparison, target architecture and protocol.
- [x] Add package-boundary validation and pre-alpha status.
- [ ] Enable GitHub private vulnerability reporting and branch protection.
- [ ] Reserve the npm package name and publish only when a usable vertical slice exists.

Exit: repository metadata is honest, packageable and discoverable; no browser capability is falsely advertised.

## Phase 1 — connection and ownership

- Manifest V3 extension with action/panel connection status.
- Native Messaging host for macOS, Windows and Linux.
- Install, doctor and uninstall commands.
- Versioned handshake, reconnect, cancellation and redacted diagnostics.
- Candidate listing, exact tab claim, tab creation and release.
- DSH `ctx.nativeBrowser` service with per-session leases.

Exit: two concurrent DSH tasks cannot cross-control tabs; extension service-worker and host restarts recover or fail closed.

## Phase 2 — semantic vertical slice

- CDP Accessibility full snapshot and event-driven updates.
- Normalized AX tree with stable refs and generations.
- Navigate, observe, click and type.
- Scroll, stability sampling, content-quad mapping and hit testing.
- Structured failures and bounded post-action observation.
- Deterministic React re-render, overlay, iframe and navigation fixtures.

Exit: representative multi-step Chrome tasks work in an authenticated profile without coordinate clicks, and wrong-action count from stale refs is zero.

## Phase 3 — human collaboration

- Session naming and controlled-tab indicator.
- Stop/takeover/resume controls.
- First-class handoff for login, CAPTCHA and user choices.
- Turn completion cleanup and deliverable preservation.
- Tab grouping for agent-created tabs.
- DSH UI cards for active tab, observation and interruption state.

Exit: a human can intervene at any action boundary and resume without restarting the browser session.

## Phase 4 — production browser workflows

- Semantic select/check/clear/fill and keyboard operations.
- Dialog, download and file-chooser flows.
- Screenshot fallback and visual verification.
- Multi-frame and Shadow DOM hardening.
- Site access gate and DSH approval integration.
- Redaction, retention controls and auditable event trail.

Exit: security review complete; beta performance/reliability gates in `docs/architecture.md` pass on all three operating systems.

## Phase 5 — compact control plane

- Benchmark compact typed tools against a sandboxed persistent-JavaScript façade.
- Add batching without hiding approval boundaries or cancellation.
- Add read-only, bounded page evaluation if its sandbox passes escape testing.
- Implement adaptive observation: diff, targeted subtree, DOM augmentation or screenshot.

Exit: selected API improves task latency and context size without weakening policy or debuggability.

## Deferred

Edge and other Chromium browsers, cloud browsers, stealth/evasion, generic desktop computer use and raw model-facing CDP remain deferred until Chrome stable meets the release gates.
