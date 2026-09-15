# Changelog

All notable changes will be documented here. The project follows semantic versioning after the first stable release.

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
