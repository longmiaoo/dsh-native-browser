# Changelog

All notable changes will be documented here. The project follows semantic versioning after the first stable release.

## 0.1.0-alpha.12 - 2026-10-30

- Include the one-command installer and isolated tool namespace prepared for alpha.11.
- Simulate the macOS platform explicitly in the installer orchestration test and keep both OS command runners mocked, so Ubuntu publication exercises the same scenario without invoking macOS services.
- Add an unsupported-platform service regression test and an Ubuntu package CI job before release tagging.
- Alpha.11 was tagged but not published to npm: its release verification caught the platform-dependent test. Its tag is preserved unchanged.

## 0.1.0-alpha.11 - 2026-10-30 (unpublished)

- Add a one-command `install` flow: stage the Chrome/Edge bundle in a stable private directory, register the Native Messaging host, install and start a macOS user LaunchAgent for the Broker, then open the browser extension page and the staged folder.
- Keep the sole unavoidable Chrome Stable step explicit: the user confirms **Load unpacked** once. The installer never automates Chrome UI or weakens extension installation security.
- Add `uninstall` and `service-status`, preserve compatibility with the existing `setup`/`install-host` commands, and derive the extension manifest version from `package.json`.
- Move all 13 public tools to the collision-resistant `native_browser_*` namespace. Existing `browser_*` names are available only through the explicit `legacyToolNames` config; occupied aliases are skipped rather than overwriting another plugin.

## 0.1.0-alpha.10 - 2026-10-30

- Add `native_browser_act` `dialog` handling for pending `alert`, `confirm`, `prompt` and `beforeunload` dialogs: accept or dismiss the exact leased tab's dialog, optionally provide bounded prompt text, return typed dialog evidence, and continue with a text/state postcondition.
- Add `input.dialog.v1` / `runtime.dialog.v1` capability negotiation. Dialog control bypasses the blocked page-command queue so a synchronous `confirm()` cannot deadlock behind the click that opened it.

## 0.1.0-alpha.9 - 2026-10-30

- Group agent-created tabs into a `DSH Browser` Chrome tab group (blue), and add `native_browser_close`: only tabs created by `native_browser_open` can be closed; user tabs are rejected.
- Add the `tabGroups` permission and `tabs.group` / `tabs.close` capabilities with `runtime.tab-grouping.v1` / `runtime.close-tab.v1` negotiation.

## 0.1.0-alpha.8 - 2026-10-30

- Add `visual-click`: a screenshot-bound image-pixel box from a multimodal model (or an optional vision tool) is mapped to the CSS viewport and clicked only after document-epoch, viewport scroll/size, hit-target and box-overlap checks.
- Add `input.visual-click.v1` / `runtime.visual-click.v1` capability negotiation.
- Add the `tabs` permission so personal-mode discovery can read tab URLs and titles without granting plaintext HTTP host access.
- Extend the durable action journal's validated kind list to `upload`, `choose`, `download` and `visual-click`, so those actions settle correctly across journal reopen.
- Add multi-tab workflows: one DSH session can open additional HTTP(S) tabs (`native_browser_open`), bring any controlled tab to the foreground (`native_browser_activate`), and release every owned lease at once (`native_browser_release_all`); agent-created tabs stay open on release.
- Add `tabs.create` / `tabs.activate` provider capabilities and `runtime.open-tab.v1` / `runtime.activate-tab.v1` negotiation.

## 0.1.0-alpha.7 - 2026-10-29

- Reduce extension permissions: keep required host access for HTTPS only, move plaintext HTTP to `optional_host_permissions`, and request it from an explicit optional HTTP-pointer control in the popup. Browser control still works without the optional grant; only pointer rendering on plaintext pages is skipped.

## 0.1.0-alpha.6 - 2026-10-29

- Add verified file upload to `native_browser_act`: an observed, connected, enabled `<input type=file>` ref receives bounded absolute local paths through `DOM.setFileInputFiles`, keeping the same identity rechecks, approval gate and text/state postconditions as other actions.
- Add the `DOM.setFileInputFiles` CDP last-mile gate (resolved-object-only dispatch with bounded absolute local files), `runtime.upload.v1` / `input.file-input.v1` capability negotiation, and a real Chrome MV3 upload case.
- Add native file chooser support to `native_browser_act`: `choose` clicks an observed chooser trigger under `Page.setInterceptFileChooserDialog`, waits for `Page.fileChooserOpened`, then accepts bounded absolute local files through `Page.handleFileChooser`; `runtime.choose.v1` / `input.file-chooser.v1` negotiate the capability.
- Add verified downloads to `native_browser_act`: `download` arms the extension's `chrome.downloads` observer for the exact lease, clicks an observed trigger, and returns the real saved filename, absolute path and byte count once Chrome reports completion; `runtime.download.v1` / `input.download.v1` negotiate the capability.

## 0.1.0-alpha.5 - 2026-10-29

- Keep npm publication on Ubuntu while requiring the exact commit's macOS Chrome/MV3 CI gate to have passed, avoiding macOS arm64 runner capacity failures without weakening release verification.

## 0.1.0-alpha.4 - 2026-10-29

- Run tagged npm release verification on the supported macOS Chrome baseline after Linux Chrome exhibited a clipped-target hit-test difference.

## 0.1.0-alpha.3 - 2026-10-29

- Redact visible foreign/opaque iframe branches inside the Chrome extension before screenshot bytes cross Native Messaging, instead of rejecting an otherwise usable viewport.
- Return bounded redaction evidence with screenshots and include the typed remote error code in user-visible transport failures.
- Exercise the redaction path against a real cross-origin iframe in the isolated MV3 Chrome smoke.
- Add `setup --browser=chrome|edge` to install the Native Messaging host for the packaged stable development extension ID, removing the manual Extension ID copy step.
- Pin the developer-preview Chrome/Edge build to one public manifest key so the unpacked extension ID remains stable across checkout and package paths.
- Run `test:chrome` in normal CI and tagged npm releases, while keeping unavailable extension redaction evidence fail-closed in the production provider.

## 0.1.0-alpha.2 - 2026-09-15

- Publish releases through a tag-bound GitHub Actions workflow and npm Trusted Publishing instead of a long-lived write token.
- Pin the release toolchain and Actions, require the exact package-version tag, rerun the complete release gates, and attach npm provenance.
- Use `latest` while no stable release exists so the default install path receives the fixed CLI; later prereleases use `next` after the first stable release.

## 0.1.0-alpha.1 - 2026-09-15

- Preserve the CLI entrypoint's executable mode so pnpm-linked DSH profile installs can run `dsh-native-browser`.
- Verify the exact packed npm artifact in an isolated pnpm consumer before release.

## 0.1.0-alpha.0 - 2026-09-15

- Add DSH bundle and npm discovery metadata.
- Add nine DSH browser tools over an authenticated local Broker, Native Messaging host and Manifest V3 Chromium extension.
- Add bounded AX observations, live page windows, semantic queries, screenshots, verified browser actions, batches, Stop and handoff.
- Add same-origin frame discovery, reads, paging and verified click foundations; cross-origin input remains denied.
- Add `per-action`, `per-lease`, exact-origin `trusted` and explicit tab-scoped `personal` approval modes.
- Add personal Broker access for an extension-consented tab across HTTP(S) root navigations, with foreground switching, expiry, handoff and Stop revocation.
- Declare HTTP/HTTPS host access in the development extension manifest so personal mode and the virtual pointer remain available after cross-site navigation.
- Add a DSH Web client bridge that releases background browser scopes when the visible conversation changes; authority is revoked rather than transferred.
- Add a presentation-only virtual pointer and click/wheel pulse after verified input dispatch.
- Hide internal lease capabilities from tool results and expose one explicit public `leaseId`.
- Add host install/uninstall/doctor commands and an `extension-path` command for packaged Chrome setup.
- Add deterministic security/lifecycle tests, real isolated-browser gates, npm tarball installation verification and benchmark evidence.
- Document the Chrome-first extensible architecture, Codex integration research, limitations and security model.
