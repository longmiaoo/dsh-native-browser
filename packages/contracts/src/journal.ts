import type { Action, ActionResult } from './index.js';

/** No page contents, input values, URLs, tokens, or observations cross this seam. */
export interface RecoveryRecord {
  state: 'reserved' | 'settled';
  recordedAt: number;
  dispatch: 'notDispatched' | 'dispatched';
  priorOutcome?: ActionResult['outcome'];
}
export interface ActionJournal {
  lookup(key: string, payloadHash: string): RecoveryRecord | undefined;
  /** Resolve true only after a new conservative intent has reached durable storage. */
  reserve(key: string, payloadHash: string, kind: Action['kind']): Promise<boolean>;
  settle(key: string, result: Pick<ActionResult, 'outcome' | 'dispatch'>): Promise<void>;
}
export function recoveredAction(requestId: string, record: RecoveryRecord): ActionResult {
  return { requestId, outcome: 'unknown', dispatch: record.dispatch, postcondition: 'unverified',
    code: 'RECOVERY_REQUIRED', recovery: record };
}
