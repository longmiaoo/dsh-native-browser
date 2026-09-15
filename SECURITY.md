# Security policy

Browser automation operates inside authenticated user sessions and therefore has access to high-value state. Treat all vulnerabilities that cross tab ownership, origin boundaries, approval policy or the local control plane as security issues.

## Reporting

Until a private GitHub security-advisory channel is enabled, contact the maintainer privately through the address associated with the `longmiaoo` GitHub account. Do not include cookies, session tokens, page contents, native-host logs containing secrets or a working exploit in a public issue.

Public issues are appropriate for non-sensitive reliability defects after removing personal data and credentials.

The release threat model, trust boundaries and residual risks are documented in [docs/security-model.md](docs/security-model.md). This alpha must not be used for payments, destructive business actions, password entry or unattended operation.

## Security boundaries

The intended design follows these boundaries:

- local transport binds to loopback or Native Messaging only;
- the extension accepts only the registered native host and authenticated protocol peers;
- existing tabs require an explicit, freshness-checked claim before control;
- model-facing actions are narrow typed capabilities, not arbitrary CDP access;
- web content is untrusted data and cannot grant permissions or redefine policy;
- sensitive writes, transmissions and account actions go through DSH approval policy;
- screenshots, accessibility trees and logs receive size limits and secret-aware retention;
- a human stop or direct interaction cancels active automation immediately;
- uninstall removes native-host registration and local credentials.

The public alpha keeps the conservative defaults above. Any future relaxation of origin, approval, native-host or action-verification boundaries requires a security review and new compatibility evidence.
