import { createHash } from 'node:crypto';
import { BrowserError } from '../../contracts/src/index.js';

/** Derive Chromium's extension ID from the manifest's base64 SPKI public key. */
export function extensionIdFromManifestKey(encodedKey: string): string {
  if (typeof encodedKey !== 'string' || encodedKey.length < 32 || encodedKey.length > 4096
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
    throw new BrowserError('INVALID_REQUEST', 'Extension manifest key is invalid');
  }
  const der = Buffer.from(encodedKey, 'base64');
  if (!der.length || der.toString('base64').replace(/=+$/, '') !== encodedKey.replace(/=+$/, '')) {
    throw new BrowserError('INVALID_REQUEST', 'Extension manifest key is invalid');
  }
  const digest = createHash('sha256').update(der).digest().subarray(0, 16);
  return [...digest].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))).join('');
}
