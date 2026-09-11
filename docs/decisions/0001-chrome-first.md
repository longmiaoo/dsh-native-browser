# ADR 0001: Make Chrome excellent before adding browsers

- Status: accepted
- Date: 2026-09-11

## Context

The DSH ecosystem already contains broad Playwright, Electron and Chrome/Edge wrappers. This project's differentiator is the quality of the real-profile Chrome experience: authenticated state, precise ownership, low-latency semantic observation and human handoff.

Premature browser abstraction would force the protocol toward the least common denominator and multiply installation, lifecycle and evaluation matrices before the core interaction model is proven.

## Decision

Support only Google Chrome stable for the first production release. Use Chrome-native concepts where they improve correctness: Manifest V3 service workers, Native Messaging, `chrome.debugger`, tab groups and Chrome policy diagnostics.

Keep internal boundaries clean enough to admit another provider later, but do not expose or test a generic public browser interface yet.

## Consequences

Positive:

- one browser/extension lifecycle to harden;
- benchmark effort concentrates on latency and correctness;
- real Chrome profiles and user-visible controls are first-class;
- documentation and support remain precise.

Negative:

- Edge and Chromium users wait longer;
- some protocol details may require adaptation later;
- Chrome Web Store review becomes part of the release path.

## Revisit condition

Revisit after Chrome beta satisfies the published gates for two consecutive releases and the protocol has a stable compatibility policy.
