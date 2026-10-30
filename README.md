# dsh-native-browser

> Fluid, native Chrome automation for DeepSeek Harness.

[![Alpha](https://img.shields.io/badge/status-alpha-orange)](#current-capabilities-and-limits) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English · [简体中文](README.zh-CN.md) · [Try it](#try-it) · [Contribute](#contribute) · [Share feedback](https://github.com/longmiaoo/dsh-native-browser/issues/new)

Let DSH work in the Chrome you already use—with your existing tabs, signed-in sessions and extensions. Ask it to read pages, fill forms and work through browser tasks, with visible actions and explicit handoff when you need control.

**Our experience benchmark is Codex: we want people moving from Codex to DSH to find browser work just as natural and continuous.** This is an open alpha, and we are building toward that goal.

We want browser work to feel smooth enough that you choose to delegate more of it. Bring a real task, show us where the experience breaks down, and help improve the next step.

## The experience we are building

| What matters to you | What the project works on |
|---|---|
| Work in a familiar browser | Connect to existing Chrome tabs, logins and extensions. |
| Keep actions connected | Preserve browser connections; use semantic observations, scoped reads, incremental results and bounded batches. |
| See what the agent is doing | Operate real pages and show pointer feedback for dispatched clicks and wheel actions. |
| Take control when needed | Release control through the extension Stop button or explicit handoff. Switching DSH conversations also revokes the previous conversation's control. |
| Recover without guessing | Check actionability and distinguish verified results from unknown outcomes, avoiding blind duplicate actions. |

“Native” means integration with DSH sessions, tools and approvals, together with direct control of existing Chrome. The plugin runs in DSH; Codex is the experience reference.

## Tasks to try

After installing and authorizing the relevant sites, ask DSH:

```text
Read the documentation page I specify, summarize the key steps and caveats,
then release browser control.
```

```text
Fill this test form with the details I provide. Check every field,
then hand control back to me before submitting.
```

```text
Read the reference pages I specify and build a comparison table.
Keep the relevant pages open and release control when finished.
```

Results depend on the page, model and permission configuration. Start with the public-page task below, then try familiar sites.

## Try it

These instructions pin the published `0.1.0-alpha.10` and use the DSH `web` profile. The [development version](#develop-the-next-version) prepares `alpha.11` with a one-command installer and isolated tool names. For `desktop`, replace `web` consistently in every command. Install separately into each profile you use.

**macOS + Google Chrome** is the primary validation target. You need Node.js ≥ 22.19, a working DSH installation and pnpm 11. Recorded DSH validation uses `0.1.5-rc.1`; the published package declares `>=0.1.5-rc.1 <0.3.0`. Reports from other versions are welcome.

### 1 Install and register the connection components

```bash
dsh plugin --profile web add dsh-native-browser@0.1.0-alpha.10
dsh plugin --profile web exec dsh-native-browser setup --browser=chrome
```

`setup` registers the Native Messaging host and prints `extensionPath` and the stable extension ID.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extensionPath`. If an older unpacked extension is present, follow the setup instructions to remove it before loading this build.

### 2 Start the first connection

Run the following command in a terminal and keep it running. This first-run route admits only `https://example.com` and uses the default approval for individual actions.

```bash
dsh plugin --profile web exec dsh-native-browser broker --allow-origin=https://example.com
```

The selected DSH profile's `native-browser` configuration should use the default `approvalMode: per-action`. If you previously changed it, check the [configuration guide](docs/development.md#explicit-chromeprofile-setup).

Restart the corresponding DSH profile. Open `https://example.com` in the intended Chrome profile, then use the extension popup to allow that tab and connect.

### 3 Finish a first task

Send this to DSH:

```text
Claim the authorized tab titled “Example Domain”, read its title and main
content, then release browser control.
```

Approve the requested tool operations. A successful first run returns the correct page content and releases control while leaving the page open.

If the connection fails, run:

```bash
dsh plugin --profile web exec dsh-native-browser doctor --browser=chrome
```

`ready` means the connection components are healthy. A page task still needs authorization for the relevant tab.

### Configure continuous everyday use

Once the first connection works, choose `per-lease`, `trusted` or explicitly enabled `personal` mode as appropriate to reduce individual approval prompts. See [approval modes](docs/development.md#approval-modes) for their scope and complete configuration.

`personal` requires matching Broker and DSH settings. Follow the guide when switching an existing process; use one Broker per runtime directory. This alpha is unsuitable for payments, destructive business operations, password entry or unattended tasks.

## Current capabilities and limits

`alpha.10` includes semantic reads, clicks, text entry, scrolling, checkbox/radio actions, batches, multiple tabs, screenshots, guarded visual clicks, and actions for uploads, downloads and native dialogs. See the [changelog](CHANGELOG.md) and that version's bundled documentation for exact conditions. The [implementation inventory](docs/current-implementation.zh-CN.md) describes the development version, which can contain changes that have not shipped.

- Cross-origin iframe content and actions remain bounded. Discovering a frame does not authorize reading it.
- Visual clicks require a screenshot and suitable model understanding. The plugin does not run a vision model itself.
- Explicit Stop and handoff are implemented. Recognizing arbitrary human intervention and resuming seamlessly still needs work.
- Edge has early compatibility evidence; formal support and complete validation on other operating systems remain work in progress.
- Chrome currently loads the extension manually. Easier installation and upgrades are contribution opportunities.

The control connection runs locally. Page text and screenshots may be sent through DSH to your configured model; choose content according to your DSH and model provider's data policies.

## Contribute

**The most useful feedback starts with: “This task stopped feeling smooth here.”** You can help by trying, recording and reproducing a problem before deciding whether to change code.

| How you want to help | A useful contribution |
|---|---|
| Try an everyday task | Explain the goal, the step that stalled and the behavior you expected. |
| Bring experience with Codex | Identify a concrete gap in initial response, pauses between actions, page feedback or handoff. |
| Improve docs or translations | Clarify installation, errors, task examples and English or Chinese documentation. |
| Build tests or web interfaces | Turn a failing step into a small public page and reproducible case. |
| Work on browsers or systems | Improve reconnection, semantic observation, action waiting, compatibility or installation. |

Start with [existing issues](https://github.com/longmiaoo/dsh-native-browser/issues) or [propose a concrete improvement](https://github.com/longmiaoo/dsh-native-browser/issues/new). If there is no suitable task, describe the scenario you want to improve. Discuss protocol, permission or large architectural changes before implementation to reduce rework.

### Report a rough edge

Include what you can safely share:

```text
Task goal:
OS, Chrome, DSH and plugin versions:
Model, web/desktop profile and approval mode:
Step that stalled or behaved unexpectedly:
Expected behavior / actual behavior:
Minimal reproduction or public test page:
Optional: redacted recording, diagnostics, timing
```

Keep cookies, tokens, account details and private screenshots out of public issues. Follow the [security reporting policy](SECURITY.md) for vulnerabilities.

### Start a code contribution

From a local checkout:

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
```

Start with a focused change and read the [contribution guide](CONTRIBUTING.md). Browser behavior changes also need appropriate real-Chrome verification; performance changes should include reproducible before/after results. Recordings, documentation and reproductions are valuable contributions in their own right.

## What to improve next

- Make first connection, installation and upgrades easier.
- Reduce idle gaps, repeated observations and unnecessary model round trips.
- Improve action feedback, stopping, handoff and continuation.
- Validate fluidity and compatibility on more real-site tasks.
- Expand validation across DSH Desktop, Web and browser versions.

These directions welcome proposals; use discussions in concrete issues and reproducible tasks to define the work. See the [roadmap](docs/roadmap.md) for the broader plan.

## Develop the next version

This checkout prepares `0.1.0-alpha.11`. Its metadata records compatibility with DSH `0.1.5-rc.1` and `0.2.1-rc.3`, within the declared `>=0.1.5-rc.1 <0.3.0` range. Use its local-plugin installation instructions when developing from source; the published `alpha.10` quickstart above remains a separate route.

The development version adds a one-command installer. From a built local checkout:

```bash
node bin/dsh-native-browser.mjs install --browser=chrome
```

On macOS, it stages the extension under a stable private path, registers the Native Messaging host, starts a LaunchAgent Broker and opens the extension setup page. Complete Chrome's **Load unpacked** confirmation manually, then mount the local bundle into a dedicated DSH development profile. See [installation details](docs/development.md#explicit-chromeprofile-setup). After an upgrade, rerun installation and reload the extension. A service installed this way supplies the Broker; do not also start a competing manual Broker in the same runtime directory.

The installer starts a personal Broker while the adapter retains its default `per-action` approvals. To opt in to fewer prompts for ordinary personal browsing, set `approvalMode: personal` on the profile's existing `native-browser` row and restart that DSH profile. Explicit Stop, handoff and conversation switching continue to release control.

### Tool names and coexistence

`alpha.11` uses `native_browser_*` tools, including `native_browser_claim`, `native_browser_observe`, `native_browser_act` and `native_browser_handoff`. The dedicated prefix permits coexistence with other browser plugins. Published `alpha.10` uses the earlier `browser_*` names.

For an older prompt or automation that needs the aliases, opt in explicitly:

```yaml
- id: native-browser
  config:
    legacyToolNames: true
```

Aliases already owned by another plugin are skipped; the canonical `native_browser_*` tools remain available. New integrations should use the canonical names.

## Technical foundations and evidence

Semantic observations describe the page, actionability checks confirm targets, the local runtime preserves connection and session state, and the virtual pointer shows dispatched actions. Reducing repeated reads and model round trips is an important part of making tasks feel continuous.

Existing executor tests and local benchmarks validate these foundations. Complete model-driven tasks, real sites and sustained use need broader evidence as we work toward the Codex experience benchmark.

[Implementation](docs/current-implementation.zh-CN.md) · [Benchmarks](docs/benchmarks.md) · [Security model](docs/security-model.md) · [Architecture plans](docs/plans/README.md)

### Documentation map

- [Installation, configuration and diagnostics](docs/development.md)
- [Current implementation](docs/current-implementation.zh-CN.md) and [implementation progress](docs/implementation-progress.md)
- [Benchmarks](docs/benchmarks.md) and [security model](docs/security-model.md)
- [Roadmap](docs/roadmap.md) and [architecture plans](docs/plans/README.md)
- [Browser plugin comparison and Codex experience plan](docs/plans/browser-plugin-competitive-analysis.zh-CN.md)
- [Architecture background](docs/architecture.md), [protocol](docs/protocol.md) and [Chrome integration research](docs/research/codex-chrome-browser-architecture.md)
- [Chrome-first decision](docs/decisions/0001-chrome-first.md)

A Chrome DevTools MCP provider remains planned. Current browser work uses the native Chromium path.

## Acknowledgements and license

Thanks to DeepSeek Harness, Chrome DevTools Protocol, the Chrome Extensions platform and the browser-agent community. Codex provides an experience reference. This is an independent implementation with no OpenAI affiliation or endorsement.

[MIT License](LICENSE)
