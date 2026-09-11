# Contributing

The project is Chrome-only until the Chrome path meets its reliability and latency gates. Please do not add browser abstractions for Edge, Firefox or Safari yet.

## Before opening a change

1. Read [the architecture](docs/architecture.md) and the relevant decision records.
2. Keep protocol changes versioned and backward-compatible within a minor release.
3. Add deterministic tests for lifecycle, cancellation and stale-target behavior.
4. Run `pnpm check`, `pnpm test` and `pnpm pack --dry-run`.
5. Never commit Chrome profiles, cookies, native-host secrets, screenshots with user data or local absolute paths.

## Engineering bar

A browser action is not complete when CDP acknowledges the command. It is complete when the target was freshly resolved, actionability was checked, cancellation was observed, the action settled and a bounded post-action observation was produced.

Performance changes should report median and p95 latency. Reliability changes should include task fixtures and failure classification, not only happy-path demos.
