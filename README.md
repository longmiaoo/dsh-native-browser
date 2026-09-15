# dsh-native-browser

> Chrome-first browser runtime for DeepSeek Harness, designed for fast, observable, human-steerable agent browsing.

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#project-status)
[![Chrome first](https://img.shields.io/badge/browser-Chrome-4285F4?logo=googlechrome&logoColor=white)](#scope)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

`dsh-native-browser` aims to let DSH agents operate the Chrome you already use: existing tabs, signed-in sessions and normal extensions, with low-latency semantic observation, reliable actions, visible handoff and safe interruption.

The target is not another thin `click(x, y)` wrapper. The design is a stateful browser runtime inspired by the strongest parts of Codex's Chrome integration:

- a Manifest V3 Chrome extension connected to a local runtime through Native Messaging;
- CDP-backed control without launching a second browser profile;
- accessibility-tree-first observation with compact incremental updates;
- stable element references plus actionability and hit-target checks;
- explicit ownership for existing tabs, agent-created tabs and end-of-turn cleanup;
- immediate human interruption and resumable handoff;
- a presentation-only virtual pointer and click/wheel pulse after verified browser input;
- screenshots as a visual fallback, not the default source of page structure.

## Project status

**Public alpha — usable for opt-in Chrome testing, not production-ready.** The package contains a typed runtime, per-user Broker, Native Messaging host, shared Chrome/Edge extension builds, a Chromium AX/action provider and nine DSH tools, including bounded live page windows, separately approved action batches and metadata-only frame discovery. Chrome setup is still manual, the extension is loaded unpacked, and broad page compatibility, visual-model accuracy and production hardening remain acceptance work rather than completed claims.

Verified so far: deterministic contract/security tests; exact npm tarball installation into a fresh DSH `0.1.5-rc.1` profile; the assembled local stack in isolated Chrome-for-Testing profiles; and one end-to-end run in an existing local Chrome profile on an owned fixture. The real MV3 extension, Chrome-started Native Host, Unix socket, Broker, installed DSH ToolRuntime, AX actions, screenshot attachment and handoff paths were exercised. Live gates also cover delayed results, cancellation, Stop, late approval after turn end, and Broker restart without replay. No sensitive business account workflow or production visual-model accuracy claim has passed acceptance yet. See [development setup](docs/development.md) and [implementation progress](docs/implementation-progress.md) for exact evidence and limitations.

The early Edge compatibility smoke also passes in an isolated Edge profile with the same runtime-core: 20 unchanged executor fixture oracles plus batch, paging, navigation, Stop and handoff checks. This is an architecture gate, not formal Edge release support; see [the retained evidence](docs/compatibility/2026-09-12-edge-native.json).

## Scope

Frame discovery now maps same-process and recursive OOPIF documents in real isolated Chrome and Edge tests. Explicit `browser_observe` frame reads support a same-origin ancestor chain, with separate child refs/deltas and exact child-document or known-region queries via `frame` + `query` + optional `rootRef`; `browser_read_page({frame,...})` provides bounded child-document/region windows; and explicit same-origin/same-process child clicks use `browser_act({frame,...})` with child-only text verification, including feedback outside the default bounded view. Other child actions and cross-origin approval remain pending. Frame origins alone are metadata, not permission. Screenshot checks inspect all attached sessions so an OOPIF omitted from the root tree cannot bypass the origin gate. See [frame discovery](docs/development.md#frame-discovery-foundation).

In scope for the first production release:

- Google Chrome stable on macOS first; Windows/Linux support follows separate installer and compatibility gates;
- the user's existing Chrome profile and authenticated sessions;
- DSH `web` and `desktop` profiles;
- semantic browsing, screenshots, downloads, dialogs, files and multi-tab workflows;
- local-only control plane with explicit permissions and auditable lifecycle events.

Architectural interfaces are cross-browser from day one. Deferred production support includes:

- Edge and other Chromium brands (shared engine; early smoke testing before formal support), Firefox and Safari (separate providers);
- hosted/remote browser farms;
- CAPTCHA bypass or stealth claims;
- arbitrary unrestricted CDP exposed directly to the model.

## Planned architecture

```mermaid
flowchart LR
    A[DSH agent] --> T[Browser tool adapter]
    T --> R[Persistent browser runtime]
    R --> H[Local native host]
    H <--> E[Chrome MV3 extension]
    E <--> C[Chrome tabs via chrome.debugger / CDP]
    C --> O[AX tree + DOM + screenshot observations]
    O --> R
    U[Human using Chrome] <--> C
    U -. interrupt / handoff .-> R
```

The runtime keeps live browser objects and event subscriptions out of the model context. The model receives compact, typed observations and stable references; the runtime performs freshness, visibility, stability and hit-target checks immediately before actions.

The current design is the [v2 runtime implementation plan](docs/plans/browser-runtime-plan-v2.zh-CN.md), including [Vision Router integration](docs/plans/vision-router-integration.zh-CN.md). Earlier [architecture](docs/architecture.md), [research](docs/research/codex-chrome-browser-architecture.md) and [protocol](docs/protocol.md) documents are historical inputs; they do not override the v2 plan or describe all current implementation details.

## DSH discovery metadata

The package is structured as a DSH bundle and includes the discovery terms used by the ecosystem:

- npm keywords: `dsh-plugin`, `deepseek-harness`, `browser-automation`, `computer-use`, `chrome-extension`;
- GitHub topics: `dsh-plugin`, `deepseek-harness`, `browser-automation`, `computer-use`, `browser-agent`;
- bundle declaration: `dsh.bundle.patch` in `package.json`;
- compatibility declaration for DSH `0.1.5` release candidates and the `web`/`desktop` profiles.

## Install the alpha

Prerequisites: macOS, Google Chrome, DSH `0.1.5-rc.1`, Node.js 22.19 or newer, and pnpm 11. The npm package ships built JavaScript and does not run a build script during installation.

```bash
dsh plugin --profile web add dsh-native-browser@0.1.0-alpha.0
dsh plugin --profile web exec dsh-native-browser extension-path --browser=chrome
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the printed directory. Record Chrome's generated 32-character extension ID, then register the Native Messaging host:

```bash
dsh plugin --profile web exec dsh-native-browser install-host --browser=chrome --extension-id=<extension-id>
```

Start the local Broker with an explicit allowlist. Origins are exact and include the port; repeat `--allow-origin` for additional sites:

```bash
dsh plugin --profile web exec dsh-native-browser broker --allow-origin=https://example.com
```

Open an allowed page in Chrome, click the extension, approve that tab, then restart the DSH profile. `approvalMode` defaults to `per-action`. Advanced testers can choose `per-lease`, or `trusted` with a non-empty exact `trustedOrigins` list, in the `native-browser` row of their profile patch. Trusted mode removes repeated DSH prompts only for those exact origins; extension consent, live lease checks, Stop and origin checks still apply. See the [explicit setup and diagnostic guide](docs/development.md#explicit-chromeprofile-setup) before using a signed-in page.

## Development

Prerequisites: Node.js 22.19 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test
pnpm test:chrome
pnpm pack
```

Only the explicitly versioned alpha is recommended for testing. Do not use it for payments, destructive business actions, password entry, or unattended operation.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security-sensitive findings should follow [SECURITY.md](SECURITY.md), not a public issue.

## Design principles

1. **Fast paths are semantic.** Use AX/DOM state for routine work and images only where pixels carry essential meaning.
2. **Actions verify reality.** Resolve targets fresh, scroll, wait for stability, hit-test, act, then observe the resulting change.
3. **Browser state has an owner.** Existing user tabs are claimed and released; agent tabs are tracked and cleaned up.
4. **Human control wins immediately.** User interaction or an extension stop action cancels in-flight work and produces a resumable state.
5. **Capabilities are explicit.** Sensitive operations are narrow, policy-gated and auditable; raw CDP is an internal transport.
6. **Performance is measured.** Latency, observation size, stale-reference rate, action success and recovery behavior are benchmark gates.

The virtual pointer improves observability, but is never an input primitive: semantic discovery and last-moment hit testing choose the target first, the browser dispatches the real input, and only then does the extension draw the pointer. A drawing failure cannot authorize, retarget, delay or replay an action.

## License

[MIT](LICENSE)
