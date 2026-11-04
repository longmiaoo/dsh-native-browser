# Changelog

All notable changes will be documented here. The project follows semantic versioning after the first stable release.

## Unreleased

- **Smoother by default:** the model can now open and navigate to any HTTP(S) address, including localhost and private-network addresses; the previous private-address blocking is removed. Page-driven access to local or intranet services is therefore no longer mitigated by the plugin.
- The default lease is now five minutes (personal mode still renews it automatically). **Upgrade note:** reload the extension and restart the Broker together; an old extension rejects deadlines more than five minutes ahead.
- Downloads no longer ask for approval. Uploads and file choosers still ask for every call.
- The default upload folder is now the user's home folder. Hidden files and folders and `~/Library` stay excluded, as does the Broker's runtime directory.
- Click, fill, append, press, check, wheel and visual-click on a tab in the background now fail immediately with `NOT_ACTIONABLE` and tell the model to call `native_browser_activate`, instead of being silently dropped and timing out. Nothing is activated automatically.

## 0.2.0 - 2026-11-04

- Rewrite the package and marketplace descriptions to include 浏览器 / Browser / Codex so the plugin ranks higher for those searches; add `codex`, `browser` and `浏览器` keywords.
- The Browser setup page now shows the plugin version next to the title.
- Fix rich-text (`contenteditable`) fill and append being denied with `POLICY_DENIED` by the extension: the page function embedded `editableText.toString()`, which differs between the Broker's tsc output and the extension's esbuild bundle, so the extension's exact-match allowlist rejected it. The reader is now one fixed source string shared by both builds.
- **Internal:** shorten the public tool schemas without dropping any validation rule: `act` and `batch` now share one action/expectation schema via `$defs`, and several tool descriptions are condensed (total schema text about 39k → 24k characters). Accepted and rejected inputs are unchanged.
- **Internal:** split large modules without behavior change: the extension's CDP command guard (`cdp-guard.ts`) and pointer/activity feedback (`presenter.ts`) leave `background.ts`; upload, file chooser, download, dialog and visual-click actions move to `interactive-actions.ts`; Broker/extension inbound request tracking is shared in `request-tracker.ts`; adapter approval rules are centralized in `approval-policy.ts`.
- **Docs:** `architecture.md` now states that the MV3 service worker keeps no state in `chrome.storage`; a worker restart drops leases and fails closed.
- **Security:** the tab inventory hides query strings and fragments, and the model can no longer open or navigate a public page to local or private-network addresses.
- **Security:** page-state checks run in an isolated world so a page cannot forge their results, and the extension runs only a fixed, reviewed set of page functions in the root session.
- **Security:** only downloads attributed to an armed lease are reported.
- Fix: a Broker whose startup fails now refuses peers that connect in the meantime.
- **Security:** file upload, file chooser and download now ask the user for each call in every approval mode, including the default personal mode; the prompt lists the exact local paths. Without a DSH approval service they are refused. Batches no longer accept these actions.
- **Security:** the Broker only uploads existing, non-hidden regular files inside allowed folders (default `~/Downloads`, `~/Desktop`, `~/Documents`). Symlinks are resolved first, and the Broker's runtime directory is always excluded. Add folders with `--upload-root=/absolute/path` on `broker` or `install`.
- **Security:** the action journal is now authenticated with a key derived (HKDF-SHA256) from the local token rather than the token itself, so the credential that peers present no longer doubles as the journal's integrity key. **Upgrade note:** the existing `action-journal.jsonl` cannot be verified under the new key and is deleted on first start; its up-to-24-hour replay protection is lost once, and the new journal is `action-journal.v2.jsonl`.
- Fix a long-lived Broker or extension connection closing at its 10,000th request; replay protection now keeps a bounded window of recent request IDs.
- Fix a long-running Broker failing every action with `JOURNAL_FULL` after 10,000 actions; identity fences of released leases are retired, while the durable journal keeps cross-lease replay protection.

## 0.1.9 - 2026-11-03

- Refresh the setup page with clearer connection progress, a return-to-chat action, light/dark themes and narrow-window support. Keep setup and permissions accessible from the same authenticated component.
- Keep personal-mode control alive during active browser work instead of unconditionally expiring after two minutes. Renew the existing owner/token through the authenticated Broker and live extension gate; recheck current origin, policy, expiry and cancellation. Stop maintenance at turn end, handoff, conversation change, disconnect or disposal, and after ten minutes without browser-tool activity. Never resurrect expired control or retry a failed renewal.
- Negotiate renewal as an optional capability. Old Brokers/extensions keep the previous fixed deadline; restricted approval modes do not receive automatic renewal. Renewal refreshes the page activity/pointer deadline without extra input or debugger reattachment.
- Preserve bounded action outcome metadata in task status. Unknown outcomes and failed postconditions request verification; stale targets, control loss and connection problems receive distinct recovery guidance. A successful read alone does not clear an uncertain action receipt, and no input is automatically replayed.
- Add lifecycle, policy, socket-negotiation and Stop-race regressions, plus real isolated Chrome MV3 renewal/feedback checks. See [continuity implementation notes](docs/browser-continuity.zh-CN.md) for scope and upgrade requirements.

## 0.1.8 - 2026-11-03

- Fix the Browser sidebar entry disappearing after reload: register its main panel from the slot declaration, without requiring optional Layout lookup while the provider fiber is still loading. Resolve navigation at click time instead.
- Add a CI regression using pinned real Cordis and SlotRegistry SDKs for cold boot, warm boot, Layout reactivation and plugin disposal; the previous direct SlotCore fixture did not model provider activation.

## 0.1.7 - 2026-11-03

- Put browser setup directly in the plugin bundle and component details, add native post-enable guidance and a sidebar Browser panel, and retain Settings as the fallback on older clients. Opening guidance only reads status; installation and browser opening still require the user's setup click.
- Bring beginner installation steps, the exact More → Settings fallback, Chrome's folder-picker shortcut and a first-task prompt to the top of both READMEs. Add setup instructions to package metadata and copyable first-task guidance in the setup page.
- Refresh connection diagnostics when returning to the setup window after loading the Chrome extension. Share the same authenticated setup component across every entry.

## 0.1.6 - 2026-11-02

- Animate the virtual cursor between actual dispatched targets with distance-based 160–420 ms transitions, continuous retargeting and arrival feedback for clicks, wheel and typing. Rendering never dispatches extra input or delays browser commands; reduced-motion users receive immediate placement.
- Show a separate, metadata-only control/activity indicator for reads, navigation, capture and waiting. Restore the indicator in new documents without inventing cursor coordinates; remove presentation on Stop, handoff and lease expiry, rejecting late feedback.
- Use a versioned content-script acknowledgement with deduplicated on-demand injection. Build the overlay without HTML string injection for Trusted Types compatibility, and fence animation/status updates by monotonic revisions.
- Exercise actual rendered intermediate frames, retargeting, no synthetic input, reduced motion, navigation reset, Stop and expiry in isolated Chrome MV3. Give the multi-action Chrome smoke suite a 60-second total budget; per-request deadlines and product action timeouts are unchanged.

## 0.1.5 - 2026-11-02

- Fix foreground selection on current DSH Session Controller catalogs: derive the selected session from unique local `retainedBy.mainView` ownership instead of the removed `list.current` field. Use the same selection projection for task settings; preserve explicit-current compatibility for older hosts and avoid guessing from cached/sidebar rows.
- Do not cache a failed foreground notification as synchronized. Distinguish missing foreground synchronization from a busy Chrome lease so recovery does not ask users to close unrelated tabs.

## 0.1.4 - 2026-11-02

- Fix a 0.1.3 settings crash before Desktop selects or hydrates a conversation: an undefined selected ID must not match a nonexistent task snapshot. Browser setup remains available without an active chat.
- Ignore malformed task-status payloads, and extend the real React/SlotCore smoke test to start with no conversation and cover cleared selections.

## 0.1.3 - 2026-11-02

- Add `native_browser_task` for task status, explicit page-purpose marks and finish. In personal mode, a Host turn explicitly ending as completed cleans still-controlled temporary pages and releases control. Retain deliverable/handoff pages and all user-created pages; interrupted, unknown and background endings never close pages.
- Fence cleanup before asynchronous connection work and through final release acknowledgement. Skip revoked/expired pages, report incomplete cleanup, and never automatically reclaim or replay a failed close.
- Add metadata-only task status and explicit Stop/finish controls in browser settings, plus optional conversation tool cards for running actions, unverified outcomes and cleanup counts. Screenshots retain the Host's image-capable rendering.
- This is in-memory task bookkeeping for the loaded plugin. Restarts do not recover authority or clean historical tabs. New UI endpoints use the existing authenticated owner routes; no additional browser-provider protocol is required.

## 0.1.2 - 2026-11-02

- Render focused-target pointer feedback for fill, append and keyboard input, without synthesizing mouse clicks. Acknowledge pointer messages and suppress late reinjection feedback after Stop.
- Fence new browser calls from a conversation after it loses foreground ownership; return an explicit handoff explanation instead of allowing repeated background reclaims. Selecting that conversation again permits a fresh lease.
- Ignore foreground notifications from visible but unfocused DSH windows; reassert the selected conversation on window focus. Explain that user-visible browsing should activate the controlled Chrome tab.
- Align the default adapter approval mode with the installer's personal Broker. Ordinary browser actions and batch steps no longer add plugin-owned per-action prompts; explicit approval configurations and DSH host permissions remain in force.
- Require the personal capability during every Broker connection/reconnection before issuing browser commands. A restricted Broker cannot receive an unapproved tab-open request from a personal adapter.
- Report the live Broker access mode and effective plugin approval mode separately in setup. Remove incorrect per-tab consent instructions in personal mode, retain restricted-mode guidance, and flag mode mismatches.
- Hide completed loading steps once Chrome connects, and explain the macOS hidden-folder picker shortcut in words.
- Verify default-mode packed installation with real Chrome/Native Messaging without per-tab popup approval; keep a no-service acceptance path for machines with an active user Broker.

- Keep task-created tabs open after completion in this release. Automatic temporary-tab cleanup is planned for a later version.

## 0.1.1 - 2026-10-30

- Add a DSH settings page for explicit Chrome setup, connection diagnostics, extension path copying and reopening the extension manager. Use the running plugin's package and runtime directory without asking users for a Profile name.
- Fix activation on DSH 0.2.1-rc.3 by using authenticated owner-only shared routes; retain the legacy RPC route on older hosts. Keep setup outside model-facing browser tools. Validate fixed request shapes, deduplicate concurrent installs, retain read-only status checks and reject unsupported automatic platforms before writes.
- Verify Desktop's Electron Node mode and persist it in Native Messaging launchers and LaunchAgents; retain compatibility with existing standalone Node registrations.
- Correct documentation that previously suggested substituting `desktop` into the public DSH CLI. Chrome Web Store distribution is still pending.

## 0.1.0 - 2026-10-30

First stable release, scoped to macOS + Google Chrome. DSH host-component validation covers 0.1.5-rc.1 and 0.2.1-rc.3; Edge and complete Linux/Windows installation remain experimental.

- Ship the one-command installer: stable extension staging, Native Messaging registration, background LaunchAgent Broker readiness checks, and Chrome/Finder setup guidance including Command+Shift+G.
- Check service ownership before installation/removal, reject competing manual Brokers, and fail unsupported automatic installs before writing files. Keep DSH approval configuration explicit.
- Copy legitimate pnpm hard-linked package files into independent private staged files; give slow new-tab navigation the bounded action budget without repeating tab creation. Accept verified close acknowledgments even when Chrome removal revokes the lease first.
- Register 13 `native_browser_*` tools by default. Legacy `browser_*` aliases are opt-in and occupied aliases are skipped.
- Include semantic reads, verified browser input, local batches, screenshots/guarded visual clicks, uploads/downloads/dialogs, multi-tab grouping and close, visible pointer feedback, Stop/handoff and foreground-conversation revocation.
- Verify fresh packed installation, repeated installation, migration from published alpha.10, stable extension ID/path, runtime identity preservation and scoped host uninstall/reinstall.
- Add an installed-tarball macOS LaunchAgent/Native Messaging/DSH acceptance harness and unify English/Chinese installation, upgrade, approval and troubleshooting documentation.
- Keep Ubuntu package checks and macOS Chrome/MV3 CI gates ahead of tag-bound npm Trusted Publishing; create the GitHub Release after successful npm publication.

The alpha.11 tag is preserved but its npm publication was blocked by a platform-dependent test, now fixed. Alpha.12 was prepared in source and is superseded by 0.1.0 without publishing an npm prerelease.

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
