# dsh-native-browser

<p align="center">
  <img src="https://raw.githubusercontent.com/longmiaoo/dsh-native-browser/main/assets/icon-180.png" width="140" alt="dsh-native-browser icon" />
</p>

> Fluid, native Chrome automation for DeepSeek Harness.

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](#try-it) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English · [简体中文](README.zh-CN.md) · [Try it](#try-it) · [Contribute](#contribute) · [Share feedback](https://github.com/longmiaoo/dsh-native-browser/issues/new)

Let DSH work in the Chrome you already use—with your existing tabs, signed-in sessions and extensions. Ask it to read pages, fill forms and work through browser tasks, with visible actions and explicit handoff when you need control.

**Our experience benchmark is Codex: we want people moving from Codex to DSH to find browser work just as natural and continuous.** Version 0.1.0 focuses on macOS and Chrome; improving real-task fluency remains an ongoing goal.

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

Version **0.1.0 supports macOS + Google Chrome**. You need Node.js ≥ 22.19, pnpm 11 and a working DSH installation. The declared DSH range is `>=0.1.5-rc.1 <0.3.0`; recorded host-component checks cover `0.1.5-rc.1` and `0.2.1-rc.3`. Chrome's manifest minimum is 125; see the [release acceptance record](docs/releases/0.1.0-acceptance.zh-CN.md) for tested versions. Edge and complete Linux/Windows installation remain experimental.

### 1 Configure the local components

Paste this entire line into a terminal:

```sh
dsh plugin --profile web add dsh-native-browser@0.1.0 && dsh plugin --profile web exec dsh-native-browser install --browser=chrome
```

Replace **both** occurrences of `web` with your actual DSH profile, such as `desktop` or `browser-lab`. Installing into a different profile does not register tools in your current chat.

The installer stages the extension in a stable private directory, registers Native Messaging, starts and checks a macOS background Broker, and opens Chrome extensions plus Finder. The service continues after you close the terminal.

### 2 Confirm the extension once in Chrome

Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. In the directory picker press **Command + Shift + G**, paste the full extension path printed by the installer, press Return, then Select. This also locates hidden directories.

The extension is currently distributed unpacked through npm; Chrome Web Store distribution is not included.

### 3 Connect and ask DSH

Restart the DSH profile where you installed the plugin. Open a normal webpage in Chrome, open the extension popup, and choose **允许当前标签页并连接** (allow the current tab and connect). Then ask DSH:

```text
Use the native_browser tools to read the title and main content of the page I just authorized, then hand browser control back to me.
```

DSH should return the page contents and leave the tab open. The default approval mode is per-action; installation does not change DSH approval configuration. Screenshot understanding depends on your selected model; Vision Router is optional.

### Approval modes

For one confirmation per tab claim, add this to the **existing** plugin entry in your actual profile and restart it:

```yaml
- id: native-browser
  config:
    approvalMode: per-lease
```

For ordinary personal browsing, explicitly choose `approvalMode: personal`. The installer already provides a matching personal Broker. After the extension connects, personal mode can discover and claim ordinary HTTP(S) tabs in that Chrome instance. Enable it only for a personal browser whose pages you intend to make available. Stop, handoff, foreground conversation changes and lease expiry revoke control. Personal mode can retain control across turns in the same conversation. The plugin cannot reliably identify every consequential business action; let a human handle payment, publishing and irreversible operations. See [approval modes](docs/development.md#approval-modes).

### Upgrade, diagnose and uninstall

Run the installation line again, reload the extension in Chrome, and restart the DSH profile. The staged extension path stays stable across package upgrades. When migrating from an older Alpha, remove the extension loaded from `node_modules` or a checkout, load the new stable directory once, and authorize the tab again.

If an old manual Broker is still running, stop it with Ctrl+C in its terminal before installation. The background service and a manual Broker must not compete for the same runtime.

Replace `web` consistently when diagnosing:

```sh
dsh plugin --profile web exec dsh-native-browser doctor --browser=chrome
dsh plugin --profile web exec dsh-native-browser service-status
```

`ready` confirms local registration and browser connectivity, not tab authorization or model-task success. If the browser is missing, check extension loading and popup consent. If tools are missing, verify the profile and restart DSH. Detailed recovery steps: [installation guide](docs/installation.zh-CN.md).

Before removing the package, run:

```sh
dsh plugin --profile web exec dsh-native-browser uninstall --browser=chrome
```

Then remove the Chrome extension and uninstall the DSH plugin using the plugin manager. This stops the service belonging to the selected runtime and unregisters the browser Host; local state, the staged extension and user tabs are preserved.

## Current capabilities and limits

`0.1.0` includes semantic reads, clicks, text entry, scrolling, checkbox/radio actions, batches, multiple tabs, screenshots, guarded visual clicks, and actions for uploads, downloads and native dialogs. See the [changelog](CHANGELOG.md) and that version's bundled documentation for exact conditions. The [implementation inventory](docs/current-implementation.zh-CN.md) describes the development version, which can contain changes that have not shipped.

- Cross-origin iframe content and actions remain bounded. Discovering a frame does not authorize reading it.
- Visual clicks require a screenshot and suitable model understanding. The plugin does not run a vision model itself.
- Explicit Stop and handoff are implemented. Recognizing arbitrary human intervention and resuming seamlessly still needs work.
- Edge has early compatibility evidence; formal support and complete validation on other operating systems remain work in progress.
- First-time Chrome extension loading requires manual confirmation. The installer handles the local components; store distribution and automatic extension updates remain future work.

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

## Tool names and coexistence

The stable version registers 13 `native_browser_*` tools, including `native_browser_claim`, `native_browser_observe`, `native_browser_act` and `native_browser_handoff`. The dedicated prefix avoids name collisions with plugins using `browser_*`. Old aliases are opt-in through `legacyToolNames: true`; occupied aliases are skipped. Use the canonical names for new tasks.

Source development, manual Broker setup and experimental features are documented in [development.md](docs/development.md).

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
