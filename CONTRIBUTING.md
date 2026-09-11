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
