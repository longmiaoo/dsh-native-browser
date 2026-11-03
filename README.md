# dsh-native-browser

<p align="center">
  <img src="https://raw.githubusercontent.com/longmiaoo/dsh-native-browser/main/assets/icon-180.png" width="140" alt="dsh-native-browser icon" />
</p>

> Fluid, native Chrome automation for DeepSeek Harness.

[![Version](https://img.shields.io/badge/version-0.1.8-blue)](#try-it) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English · [简体中文](README.zh-CN.md) · [Try it](#try-it) · [Contribute](#contribute) · [Share feedback](https://github.com/longmiaoo/dsh-native-browser/issues/new)

## Quick start: connect Chrome after installing

**Already connected on 0.1.7? Update to 0.1.8 and reload DSH to restore the sidebar. This frontend fix does not require reinstalling or reloading the Chrome extension.**

**For macOS + Google Chrome. Install in the DSH app you actually use. No terminal command or Profile name is needed.**

1. **Install and enable**: DSH → **Plugins → Plugin market**, search `dsh-native-browser`, install and enable it. Reload if DSH asks.
2. **Open setup**: use **Browser** in the sidebar, or **Plugins → the top-level Installed tab → dsh-native-browser** details. Use DSH’s top-level Installed tab, outside Plugin market’s own installed list. Click **Set up Chrome** to open Chrome extensions and its folder.
   **Missing those entries? Published `0.1.6` and earlier use the full fallback path: bottom-left More → Settings → Browser setup → Set up Chrome.** Version 0.1.7 added plugin-detail and sidebar entries; 0.1.8 fixes their cold-boot registration; older hosts can continue using Settings.
3. **Load the extension once**: in `chrome://extensions`, enable **Developer mode** and click **Load unpacked**. Copy the extension path from setup; in the folder picker press **Command + Shift + G**, paste it, press Return and select the entire `chrome` folder. If already loaded, click **Reload** on its extension card instead.
4. **Check and chat**: return to setup and click **Check connection**. Once Chrome is connected, open an ordinary webpage in Chrome and paste this into DSH:

```text
Use native_browser tools to read the title and main content of my current Chrome page, then hand control back to me.
```

**After setup, ask for tasks directly in chat.** After upgrading the plugin, rerun setup to sync its extension, then click **Reload** on the Chrome extension card.

Chrome Web Store distribution is pending, so the initial Load unpacked confirmation remains. Setup opens the relevant Chrome page automatically. A public README cannot link to every user's authenticated local DSH; the in-app entry uses the DSH instance you are running.

---


Let DSH work in the Chrome you already use—with your existing tabs, signed-in sessions and extensions. Ask it to read pages, fill forms and work through browser tasks, with visible actions and explicit handoff when you need control.

**Our experience benchmark is Codex: we want people moving from Codex to DSH to find browser work just as natural and continuous.** Version 0.1.0 focuses on macOS and Chrome; improving real-task fluency remains an ongoing goal.

We want browser work to feel smooth enough that you choose to delegate more of it. Bring a real task, show us where the experience breaks down, and help improve the next step.

## The experience we are building

| What matters to you | What the project works on |
|---|---|
| Work in a familiar browser | Connect to existing Chrome tabs, logins and extensions. |
| Keep actions connected | Preserve browser connections; use semantic observations, scoped reads, incremental results and bounded batches. |
| See what the agent is doing | Show smooth cursor motion for dispatched clicks, scrolling and typing, plus a separate control/read/navigation/wait indicator. |
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

Version **0.1.8 supports macOS + Google Chrome**. You need a working DSH installation. CLI/Web setups require Node.js ≥ 22.19 and pnpm 11; Desktop setup uses its verified built-in runtime. The declared DSH range is `>=0.1.5-rc.1 <0.3.0`; recorded host-component checks cover `0.1.5-rc.1` and `0.2.1-rc.3`. Chrome's manifest minimum is 125; see the [release acceptance record](docs/releases/0.1.0-acceptance.zh-CN.md) for tested versions. Edge and complete Linux/Windows installation remain experimental.

### Recommended: setup inside DSH (0.1.8)

Version `0.1.8` keeps the **Browser** sidebar entry available after reload and provides setup directly in **Plugins → top-level Installed → dsh-native-browser** details. Install or update in the DSH app you use, reload as instructed, then click **Set up Chrome**. Older hosts retain **More → Settings → Browser setup**. No Profile name is needed. It provides connection checks, path copying and a button to reopen Chrome. Desktop reuses its verified built-in runtime without a separate Node installation.

The extension is not on the Chrome Web Store yet, so initial unpacked loading remains. A future store release can replace directory selection with the user's **Add to Chrome** confirmation and automatic extension updates; that distribution path has not shipped. See the [setup design and validation](docs/setup-ui.zh-CN.md).

### CLI installation (advanced CLI/Web usage)

Paste this entire line into a terminal:

```sh
dsh plugin --profile web add dsh-native-browser@0.1.8 && dsh plugin --profile web exec dsh-native-browser install --browser=chrome
```

Use this only for a known CLI/Web profile such as `web` or `browser-lab`, with the same name in both places. `web` is not a universal default. **Desktop users should manage plugins through the Desktop plugin market, not substitute `desktop` into the public CLI**, which restricts management of Desktop-owned profiles. Installing into a different profile does not register tools in the current chat.

The installer stages the extension in a stable private directory, registers Native Messaging, starts and checks a macOS background Broker, and opens Chrome extensions plus Finder. The service continues after you close the terminal.

### 2 Confirm the extension once in Chrome

Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. In the directory picker press **Command + Shift + G**, paste the full extension path printed by the installer, press Return, then Select. This also locates hidden directories.

The extension is currently distributed unpacked through npm; Chrome Web Store distribution is not included.

### 3 Connect and ask DSH

Reload the DSH environment where you installed the plugin. Check the connection in Browser setup, open a normal webpage in Chrome, and ask DSH. Default personal mode needs no per-tab popup consent:

```text
Use the native_browser tools to read the title and main content of the Chrome page I have open, then hand browser control back to me.
```

DSH should return the page contents and leave the tab open. Version `0.1.8` defaults to personal mode. Installation does not change host-wide DSH permissions. Screenshot understanding depends on your selected model; Vision Router is optional.

### Approval modes

**Since 0.1.2:** the adapter now defaults to `personal`, matching the standard installer. Ordinary pages need no per-tab popup consent and the plugin adds no per-action approval prompts. Explicit `per-action`, `per-lease` and `trusted` configurations remain effective. Stop, handoff, conversation switching, lease checks and DSH's own permissions still apply.

Upgrade existing installations to `0.1.8`, rerun setup to update the staged extension and Broker, reload the extension in Chrome, and reload DSH. Existing explicit approval settings take precedence. A personal Broker is required for personal mode.

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

Version 0.1.3 adds [task lifecycle and status](docs/task-lifecycle.zh-CN.md): explicit page-purpose marks, cleanup of still-controlled temporary tabs on confirmed completed turns, conversation action cards, and settings controls. Temporary pages are cleaned only while control is valid; retained and user-owned pages remain open. Use explicit finish when the Host ending is unknown; mark unfinished multi-turn pages for handoff.

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

The stable version registers 14 `native_browser_*` tools, including `native_browser_claim`, `native_browser_observe`, `native_browser_act` and `native_browser_handoff`. The dedicated prefix avoids name collisions with plugins using `browser_*`. Old aliases are opt-in through `legacyToolNames: true`; occupied aliases are skipped. Use the canonical names for new tasks.

Source development, manual Broker setup and experimental features are documented in [development.md](docs/development.md).

## Technical foundations and evidence

Semantic observations describe the page, actionability checks confirm targets, the local runtime preserves connection and session state, and the virtual pointer shows dispatched actions. Version 0.1.6 adds smooth motion between actual targets and a separate indicator for reads, navigation, screenshots and waiting; read-only work never invents a mouse target. Animation does not add browser input or delay dispatch, and respects reduced-motion preferences. Reducing repeated reads and model round trips is an important part of making tasks feel continuous.

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
