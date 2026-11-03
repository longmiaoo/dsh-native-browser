export type ApprovalMode = 'per-action' | 'per-lease' | 'trusted' | 'personal';

// Match the personal Broker created by the standard installer. Explicit
// operator choices still take precedence; host-wide approvals are untouched.
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'personal';

/** Tools whose call is gated by a Host prompt before it runs, per approval mode. */
const askBefore: Readonly<Record<ApprovalMode, ReadonlySet<string>>> = {
  'per-action': new Set(['claim', 'open', 'close', 'act', 'screenshot', 'task']),
  'per-lease': new Set(['claim', 'open']),
  trusted: new Set(),
  personal: new Set(),
};
export const toolNeedsPrompt = (mode: ApprovalMode, shortName: string): boolean => askBefore[mode].has(shortName);

/** Each batch step is prompted only in per-action mode; other modes rely on the lease grant. */
export const batchStepNeedsPrompt = (mode: ApprovalMode): boolean => mode === 'per-action';

/** Upload, choose and download are prompted in EVERY mode. per-action already asked for the
 * enclosing `act` call in tools/pre-execute, so only the other modes need the extra prompt. */
export const fileActionKinds: ReadonlySet<string> = new Set(['upload', 'choose', 'download']);
export const fileActionNeedsExtraPrompt = (mode: ApprovalMode): boolean => mode !== 'per-action';
