# Contributing

Chrome is the first production target. Browser-independent contracts are required from day one; Chrome and Edge share the Chromium engine. Follow the [v2 plan](docs/plans/browser-runtime-plan-v2.zh-CN.md), which supersedes the earlier decision to defer browser abstractions.

## Before opening a change

1. Read the [current plan](docs/plans/browser-runtime-plan-v2.zh-CN.md) and [implementation progress](docs/implementation-progress.md).
2. Keep protocol changes versioned and backward-compatible within a minor release.
3. Add deterministic tests for lifecycle, cancellation and stale-target behavior.
4. Run `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm test:chrome` (with local Chrome), and inspect `pnpm pack` output.
5. Never commit Chrome profiles, cookies, native-host secrets, screenshots with user data or local absolute paths.

## Engineering bar

A browser action is not complete when CDP acknowledges the command. It is complete when the target was freshly resolved, actionability was checked, cancellation was observed, the action settled and a bounded post-action observation was produced.

Performance changes should report median and p95 latency. Reliability changes should include task fixtures and failure classification, not only happy-path demos.

## Releasing to npm

Production npm writes use GitHub Actions trusted publishing. The npm package must trust only the `longmiaoo/dsh-native-browser` repository and `.github/workflows/release.yml`; do not add a long-lived `NODE_AUTH_TOKEN` secret.

1. Update `package.json` and `CHANGELOG.md`, commit the reviewed release, and ensure the normal CI workflow passes.
2. Create an annotated `v<package-version>` tag at that exact commit and push the tag only after reviewing the release plan.
3. The release workflow checks out the tag without persisted Git credentials, installs pinned Node/npm/pnpm versions without a dependency cache, runs metadata, type, deterministic and exact packed-consumer tests, and refuses an existing npm version or mismatched tag.
4. npm receives a short-lived GitHub OIDC identity and publishes with provenance. Until the first stable version exists, prereleases use `latest` so the default install path remains usable. After that point, prereleases use `next` and stable versions use `latest`.

The npm Trusted Publisher is a persistent security boundary. Its repository owner, repository name and workflow filename must match exactly; leave its optional GitHub environment unset unless the workflow is deliberately updated to use one.
