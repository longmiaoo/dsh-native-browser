# Contributing

Help make browser work in DSH feel fluid and continuous. A useful contribution can be a task report, a clearer installation step, a small reproducible page, or a focused code change.

## Choose a starting point

| What you can help with | A useful first step |
|---|---|
| Try a browser task | Describe your goal, the step that felt rough, and what you expected. |
| Compare the experience with Codex | Identify a concrete gap in response, pauses between actions, feedback or handoff. |
| Improve docs or translations | Correct a command, explain a confusing error, or improve a task example in both README languages. |
| Reproduce a failure | Provide a public test page and minimal steps without private account data. |
| Improve implementation | Pick one connection, observation, action, installation or compatibility issue and define how to verify it. |

Start with [existing issues](https://github.com/longmiaoo/dsh-native-browser/issues), or open an issue describing your task and proposed scope. Discuss protocol, permission and broad architecture changes before implementation. Do not assume a new capability has been agreed merely because it appears in a roadmap.

## Report an experience problem

Include the task goal, OS/Chrome/DSH/plugin versions, model, web or desktop profile, approval mode, reproduction steps, expected behavior and actual behavior. A redacted recording or timing trace helps when a pause is hard to describe. Follow [SECURITY.md](SECURITY.md) for vulnerabilities; keep tokens, cookies, account data and private page content out of public reports.

## Match verification to the change

For documentation-only changes, verify commands against the version they install, check links, keep [English](README.md) and [Chinese](README.zh-CN.md) instructions aligned, and run the existing documentation checks if their covered text changes. Task reports and reproductions do not require the full development suite.

For code changes, follow the engineering requirements below. Add tests for changed behavior and run the relevant real-browser checks for affected paths. Performance changes should retain failure cases and distinguish model time, setup time and browser execution time.

## Architecture scope

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
