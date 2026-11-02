export type ApprovalMode = 'per-action' | 'per-lease' | 'trusted' | 'personal';

// Match the personal Broker created by the standard installer. Explicit
// operator choices still take precedence; host-wide approvals are untouched.
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'personal';
