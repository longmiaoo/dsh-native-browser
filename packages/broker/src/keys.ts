import { hkdfSync } from 'node:crypto';

/** The runtime token authenticates local peers. Anything else that must stay secret from a
 * peer holding it (such as the journal MAC key) is derived here, one purpose per key. */
export function deriveSecret(token: string, purpose: string): string {
  return Buffer.from(hkdfSync('sha256', Buffer.from(token, 'hex'), Buffer.alloc(0), `dsh-native-browser/${purpose}`, 32)).toString('hex');
}
/** v2 journals are MACed with a derived key, so a v1 file cannot be verified and is retired. */
export const journalFile = 'action-journal.v2.jsonl';
