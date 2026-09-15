# Security model

Status: public-alpha baseline, 2026-09-15. This document describes the implemented security boundaries and known residual risk. It is not a claim that arbitrary websites or sensitive business workflows are safe.

## Assets and trust boundaries

The protected assets are the user's authenticated Chrome session, page contents, screenshots, form data, downloads, local runtime credentials and the ability to dispatch trusted browser input. DSH, the plugin process, the local Broker, the Native Messaging host and the installed extension are trusted code. Web pages, model output, tool arguments, page accessibility/DOM data and remote visual-model output are untrusted.

The control path is DSH tool adapter → authenticated Unix-domain Broker → Chrome-started Native Messaging host → an explicitly installed MV3 extension → `chrome.debugger`/CDP. The browser extension does not expose a TCP listener. The Broker uses a private runtime directory, token-authenticated clients, bounded framed messages and connection-scoped ownership.

## Authorization invariants

- The user must load the extension, register the host for its exact extension ID and approve each controlled tab in the extension UI.
- The Broker allowlists exact origins, including scheme and port. A navigation or frame-origin change is rechecked before data or input is returned.
- A DSH turn receives a short-lived exclusive lease. Turn end, handoff, expiry, disconnect or the extension Stop action revokes it.
- The default `per-action` mode asks through DSH for claim, action and screenshot operations. `per-lease` asks once when claiming. `trusted` is accepted only with a non-empty exact-origin list and does not bypass extension consent, leases, Stop or origin checks.
- Model-facing tools expose typed actions and opaque refs, never raw CDP sessions, JavaScript evaluation or internal lease tokens.
- Mutating actions re-resolve identity, actionability, geometry and hit targets immediately before input. Results are checked against explicit postconditions when available.
- Durable request IDs fence replay. Unknown outcomes are not retried automatically, including after Broker failure.
- Child-frame reads and input require current frame/document evidence and a same-origin ancestor chain. Cross-origin child input is denied in this release.

## Primary threats and mitigations

| Threat | Implemented mitigation | Residual risk |
|---|---|---|
| Prompt injection from a page | Page content is returned as untrusted data; it cannot grant permissions or alter policy. Actions remain typed and approval-gated. | A model may still make a poor decision after reading hostile content; human review remains necessary. |
| Control of the wrong tab/site | Explicit extension tab consent, exact-origin Broker allowlist, instance/tab lease and document/origin rechecks. | Misconfigured allowlists or approving the wrong tab remain user errors. |
| Stale or replaced element click | Document epochs, semantic identity, backend-node binding, actionability, geometry stability and hit testing immediately before dispatch. | Highly dynamic or adversarial renderer behavior can still create races; outcomes may be reported unknown. |
| Duplicate input after timeout/crash | Durable request/payload fencing, intent journal and no blind replay of unknown outcomes. | The system cannot undo already-dispatched browser input. |
| Cross-origin frame data/input leak | Bounded frame metadata, same-origin ancestor checks, conservative screenshot coverage checks and denied cross-origin input. | Browser/renderer bugs and unsupported frame topologies are outside the guarantee. |
| Local process impersonation | Private per-user runtime directory, restrictive file/socket modes, local token authentication, safe path/type/link checks and Broker ownership lock. | Malicious code running as the same OS user remains largely in the trusted computing base. |
| Native Messaging host substitution | Host manifest is registered for one exact extension ID; launcher and manifest are checked by `doctor`. | The alpha uses a Node launcher and unpacked extension rather than signed, self-contained installers. |
| Screenshot/data exfiltration | Screenshot capture is approval/origin/lease gated and stored through DSH attachments; the plugin does not itself call a cloud vision service. | A separately configured model or vision plugin may transmit content under its own policy. |
| User loses control | Visible extension state, immediate local Stop, short leases and explicit handoff. | Input already delivered to Chrome cannot be rolled back. |
| Resource exhaustion | Message, observation, page, frame, queue, lease, action and attachment limits; bounded traversals and deadlines. | Local filesystem stalls and extreme browser behavior can still delay diagnosis or cleanup. |

## Unsupported high-risk use

The alpha is not approved for payments, account deletion, irreversible business changes, password entry, file upload, CAPTCHA bypass, unattended operation or arbitrary cross-origin automation. It does not claim protection against a malicious same-user process, compromised DSH/plugin installation, compromised browser, operating-system compromise, Chrome zero-days, hostile enterprise policy or a malicious dependency installed outside this package.

## Release and incident expectations

Release artifacts must be built from a clean reviewed commit, pass the full deterministic suite, install from the exact packed tarball in a fresh DSH profile, and use an npm prerelease tag until the production gates are met. Security reports should follow [the repository policy](../SECURITY.md). If a boundary failure is discovered, stop the Broker, use `uninstall-host` for the exact extension ID, remove the unpacked extension from Chrome and rotate any affected website credentials or sessions.
