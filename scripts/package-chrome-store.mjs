// Prepare an uploadable draft to obtain a store item ID. This never publishes
// and never changes the stable key/ID in the npm-distributed unpacked build.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const source = path.join(root, 'dist/extension/chrome');
const original = await readFile(path.join(source, 'manifest.json'), 'utf8');
const manifest = JSON.parse(original);
assert.equal(manifest.version, pkg.version, 'Build the matching stable version before packaging');
assert.equal(manifest.manifest_version, 3);
const files = ['background.js', 'popup.js', 'pointer.js', 'popup.html', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'];
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-store-draft-'));
const output = path.join(root, 'output/chrome-web-store');
await mkdir(output, { recursive: true });
const archive = path.join(output, `dsh-native-browser-${pkg.version}-store-draft.zip`);
try {
  for (const file of files) await copyFile(path.join(source, file), path.join(temporary, file));
  // The dashboard allocates its own item ID/public key. Retaining our local
  // development key here would misleadingly imply that the IDs already match.
  delete manifest.key;
  await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyFile(path.join(root, 'PRIVACY.md'), path.join(temporary, 'PRIVACY.md'));
  const entries = (await readdir(temporary)).sort();
  await rm(archive, { force: true });
  await exec('zip', ['-X', '-q', archive, ...entries], { cwd: temporary });
  const packed = (await exec('unzip', ['-Z1', archive])).stdout.trim().split('\n').sort();
  assert.deepEqual(packed, entries);
  const archivedManifest = JSON.parse((await exec('unzip', ['-p', archive, 'manifest.json'])).stdout);
  assert.equal(archivedManifest.version, pkg.version); assert.equal('key' in archivedManifest, false);
  assert.equal(await readFile(path.join(source, 'manifest.json'), 'utf8'), original);
  const report = { version: pkg.version, archive: path.basename(archive), stage: 'draft-upload-only',
    sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    permissions: manifest.permissions, hostPermissions: manifest.host_permissions,
    optionalHostPermissions: manifest.optional_host_permissions, entries,
    reviewReady: false, blockers: ['Obtain store ID/public key and verify native-host registration/migration',
      'Complete publisher registration, privacy declarations, asset rights and final reviewer acceptance'] };
  await writeFile(path.join(output, 'draft-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  await copyFile(path.join(root, 'docs/chrome-web-store/submission.md'), path.join(output, 'submission.md'));
  await copyFile(path.join(root, 'assets/icon-128.png'), path.join(output, 'store-icon-128.png'));
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
