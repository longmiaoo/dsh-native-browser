# Browser quality benchmark plan

The benchmark suite measures the system that creates a smooth experience, not only task completion.

## Fixture matrix

- static semantic controls;
- delayed content and navigation;
- React replacement between observation and action;
- moving target and animation;
- modal overlay covering a target;
- same-origin and out-of-process iframes;
- Shadow DOM controls;
- canvas/image fallback;
- download, dialog and file chooser;
- user click or stop during every wait phase;
- MV3 service-worker suspension and native-host restart;
- two DSH tasks with similar tab titles and URLs.

## Metrics

- connection cold start and warm reconnect latency;
- full AX snapshot and diff latency/bytes;
- action resolve, scroll, actionability, dispatch, settle and observe spans;
- correct-action, explicit-failure and wrong-action rates;
- stale-ref detection rate;
- human-stop propagation latency;
- leaked tabs, debugger attachments and child processes;
- model tokens and screenshots per completed task;
- recovery rate by failure class.

## Comparison modes

Run the same tasks through:

1. repeated screenshot plus coordinate actions;
2. full semantic snapshot after every action;
3. AX-first incremental observation;
4. AX-first with local batched actions.

Codex is a product-experience reference. The v2 plan separately requires an L3 same-machine product comparison; that comparison is not implemented by the L1 executor harness below. Public claims must not imply implementation or performance parity without reproducible data.

## Reporting

Each result records operating system, CPU, memory, Chrome version, extension/native-host/runtime versions, warm/cold state, fixture commit, sample count, median, p95 and raw failure categories. Real-site tests are supplemental because site changes make them poor regression gates.

## Implemented L1 native benchmark

Run from a development checkout with dependencies installed, an existing DSH installation, and a Chrome-for-Testing executable that supports the existing isolated native smoke. This is a developer test, not an installed npm-package command or an ordinary signed-in Chrome profile test.

```sh
DSH_CHROME_TEST_EXECUTABLE="/absolute/path/to/Google Chrome for Testing" \
  pnpm bench:native /absolute/path/to/installed/dsh \
  --samples=5 --warmups=1 --seed=1729
```

Do not run builds, functional suites or other benchmarks concurrently. The command builds first, then launches its own loopback fixture server, independent Broker CLI, isolated browser profile, Chrome-started Native Host and production MV3 extension. It uses the installed DSH ToolRuntime and attachment service, with deterministic test approval. It neither opens user login pages nor calls a model/cloud vision service.

The predeclared catalog is `scripts/benchmark/cases.mjs`: 20 tasks, one warmup and five measured repetitions per task by default. Each round uses deterministic shuffled order. Each trial reloads the fixture and claims a fresh lease; the connection stays warm. Known refs are discovered through the production observation path, including an explicit contextual query for duplicate buttons. The benchmark does not invent target refs or select the first ambiguous candidate.

Independent fixture oracles inspect final values, trusted events, click counts, lack of unintended input, or the canonical Host attachment hash. Expected safety refusals count as passed tasks only when their specific refusal and no-side-effect oracle passes. Thus `oraclePassRate` is not an action-success rate or real-site reliability estimate.

### Timing and reporting contract

- `taskMs`: task execution plus independent oracle. Excludes fixture reset, lease claim and initial discovery; those are separate `setupMs`. Overlay arming is inside that task's timed execution. This is not a complete user/model task latency.
- `calls[].durationMs` and task-level `toolMs`: actual DSH execute-call durations, including production transport and return. These are not pure RPC or per-stage spans.
- `responseBytes`: serialized tool-result JSON bytes, not actual wire traffic; excludes attachment image-file bytes. No tool-result bodies, screenshot pixels, input text, exception messages or stacks are copied into reports.
- `p50`: median; `p95`: nearest-rank percentile, which is the maximum for five samples. Group summaries pool the group's individual trials, never task medians. The all-task summary mixes unlike work and must not be advertised as one browser-speed score.
- All requested trials have rows. Timed failures/timeouts stay in latency distributions; setup failures and unstarted work remain in the denominator without invented zero latency. Warmups remain in raw rows and a separate summary, not in measured percentiles. Failures are not retried into successes. SIGINT/SIGTERM cancel current work and preserve unstarted rows where the runner has started; startup failures produce an incomplete report rather than a fabricated task population.
- Action, Host-tool, page and overall budgets are 3 seconds, 6 seconds, 6 seconds and 10 minutes respectively. Reports record safe typed failure/call outcome metadata, source and fixture fingerprints, Git HEAD/dirty status, environment versions, seed and sample counts. A changed dirty-tree fingerprint represents a different candidate even with the same Git HEAD.
- Every run writes a new `output/playwright/native-benchmark-*/report.json`; earlier failures and exploratory runs are not overwritten. Non-passing or incomplete runs return a nonzero exit status. Cleanup closes only this run's DSH context/browser/Broker/server and removes its temporary profile; cleanup success is reported separately, not asserted as a comprehensive leak/soak proof.

Seven unit tests in `test/benchmark.test.mjs` cover quantiles, deterministic order, invalid configuration, failure/timeout retention, warmup/setup separation, cancellation and error-payload redaction. The fixture intentionally includes delayed feedback, transient obstruction, open Shadow DOM and stale identity, but is still one controlled local document.


### Recorded run: 2026-09-12

[Retained raw report](benchmark-results/2026-09-12-native-l1.json), 2026-09-12 00:59:51–01:00:06 Asia/Shanghai: **100/100 measured trials and 20/20 warmups passed**, zero failed/unstarted trials; owned-resource cleanup returned complete. macOS Darwin 25.5.0, Apple M4 / 10 logical CPUs / 24 GiB, Node 22.22.3, CFT 151.0.7922.10, DSH 0.1.5-rc.1. Seed 1729; source fingerprint `25d2b7b6840c4948f4de98f891c794bc5d073a46ea3a1b40f963fb331cc90df6`; dirty checkout based on `7a875f1`, not a released version.

No functional suite/build was run concurrently with this recorded measurement. The shared machine was not otherwise isolated (starting load averages are in the report). A 20-trial exploratory run remains in local output `native-benchmark-yphz73`; an earlier 100-trial run `native-benchmark-UiNhPQ` overlapped functional tests at startup and is retained but not selected as this baseline. Both passed; neither was silently overwritten or used to improve this run's sample set.

All time columns below are milliseconds. Each row has only five measurements, so its p95 is its observed maximum. Tool p50 excludes the independent fixture oracle; response bytes are the median serialized tool-result size, not pixel/wire bytes.

| Task | Oracle passed | Task p50 | Task p95 | Tool p50 | JSON bytes p50 |
|---|---:|---:|---:|---:|---:|
| observe-full | 5/5 | 7.99 | 8.56 | 7.97 | 5068 |
| observe-delta | 5/5 | 7.90 | 8.28 | 7.87 | 1006 |
| observe-text-delta | 5/5 | 9.19 | 11.55 | 9.18 | 1160 |
| observe-subtree | 5/5 | 5.28 | 6.16 | 5.25 | 2284 |
| query-exact | 5/5 | 2.32 | 3.93 | 2.31 | 1198 |
| query-ambiguous | 5/5 | 3.84 | 5.97 | 2.81 | 1380 |
| fill-native | 5/5 | 83.85 | 87.87 | 74.73 | 5358 |
| append-textarea | 5/5 | 85.77 | 87.27 | 77.02 | 5338 |
| check-native | 5/5 | 85.49 | 88.31 | 76.72 | 5316 |
| radio-native | 5/5 | 87.49 | 91.47 | 78.41 | 5318 |
| fill-editor | 5/5 | 84.29 | 88.44 | 75.71 | 5344 |
| fill-shadow | 5/5 | 82.80 | 86.75 | 73.33 | 5336 |
| keyboard-submit | 5/5 | 76.87 | 81.68 | 75.67 | 5336 |
| delayed-click | 5/5 | 188.14 | 189.18 | 186.57 | 5332 |
| overlay-click | 5/5 | 210.58 | 211.29 | 208.34 | 5326 |
| scroll-region | 5/5 | 133.14 | 134.87 | 114.40 | 6026 |
| wheel-handler | 5/5 | 81.33 | 82.41 | 80.12 | 5336 |
| stale-rejection | 5/5 | 11.51 | 12.06 | 10.33 | 340 |
| origin-rejection | 5/5 | 8.91 | 10.33 | 8.88 | 342 |
| capture-host | 5/5 | 58.12 | 62.35 | 57.83 | 2800 |

Pooled within-family task p50/p95: observation 7.52/9.22 ms (25 trials), ordinary action 84.71/133.14 ms (45), deliberate waiting 198.06/211.29 ms (10), safety oracle 8.91/12.06 ms (15), capture 58.12/62.35 ms (5). Waiting includes the fixture's intentional 80 ms feedback or 120 ms overlay. These are L1 task-plus-oracle intervals, not interchangeable with the plan's pure-RPC or exact production-span targets. Full versus unchanged-delta response medians were 5,068 versus 1,006 JSON bytes on this fixture; the delta still reacquires its AX scope, so smaller output does not imply incremental acquisition or a guaranteed latency reduction.


### Remaining benchmark work

This establishes only an initial L1 baseline. L2 fixed-model agent turns, L3 Codex product comparison, regular-profile and real-site evidence, per-stage production spans, pure RPC RTT, cold-start/reconnect/Stop timing, OOPIF, multitab, IME, uploads/downloads/dialogs and long-running soak remain missing. The provisional v2 p95 targets are not release claims. Five observations per task cannot establish a stable tail distribution; shared-machine load remains uncontrolled even when our own test suites are stopped.
