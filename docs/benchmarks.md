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

Codex is a product-experience reference, not a black-box benchmark target. Public claims should compare measurable behaviors in our own harness and avoid implying implementation or performance parity without reproducible data.

## Reporting

Each result records operating system, CPU, memory, Chrome version, extension/native-host/runtime versions, warm/cold state, fixture commit, sample count, median, p95 and raw failure categories. Real-site tests are supplemental because site changes make them poor regression gates.
