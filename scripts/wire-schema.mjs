import { readFile, writeFile } from 'node:fs/promises';
import { wireSchema } from '../dist/packages/contracts/src/wire.js';

// Run after build. Generation is explicit; tests never silently repair a stale published contract.
const target = new URL('../protocol/v1.schema.json', import.meta.url);
const expected = `${JSON.stringify(wireSchema, null, 2)}\n`;
if (process.argv.includes('--write')) {
  await writeFile(target, expected);
} else if (await readFile(target, 'utf8') !== expected) {
  throw new Error('Stale wire schema: run pnpm build && node scripts/wire-schema.mjs --write');
} else console.log('Published wire schema matches the shared runtime contract.');
