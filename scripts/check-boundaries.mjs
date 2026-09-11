import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const failures = [];
async function walk(dir) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, file.name);
    if (file.isDirectory()) await walk(full);
    else if (file.name.endsWith('.ts')) {
      const text = await readFile(full, 'utf8');
      if (/\bchrome\s*\./.test(text)) failures.push(`${full}: browser global in portable core`);
      for (const match of text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('node:') && !match[1].includes('/contracts/') && !match[1].startsWith('./')) {
          failures.push(`${full}: forbidden dependency ${match[1]}`);
        }
      }
    }
  }
}
await walk('packages/contracts'); await walk('packages/runtime-core'); await walk('packages/vision-adapter');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Portable core and vision adapter have no browser/provider/DSH dependencies.');
