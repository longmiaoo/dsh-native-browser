import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authorizeUploadFiles, defaultForbiddenUploadDirs, defaultUploadRoots, resolveUploadRoots } from '../dist/packages/broker/src/upload-policy.js';
import { batchRequest } from '../dist/packages/contracts/src/validation.js';

async function tree(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-upload-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const downloads = path.join(home, 'Downloads'), secrets = path.join(home, '.ssh'), runtime = path.join(downloads, 'runtime');
  await mkdir(path.join(downloads, '.hidden-dir'), { recursive: true }); await mkdir(secrets); await mkdir(runtime);
  await writeFile(path.join(downloads, 'resume.pdf'), 'ok');
  await writeFile(path.join(downloads, '.env'), 'secret');
  await writeFile(path.join(downloads, '.hidden-dir', 'a.txt'), 'secret');
  await writeFile(path.join(secrets, 'id_rsa'), 'secret');
  await writeFile(path.join(runtime, 'auth-token'), 'secret');
  await symlink(path.join(secrets, 'id_rsa'), path.join(downloads, 'innocent.pdf'));
  await symlink(downloads, path.join(home, 'link-to-downloads'));
  const roots = await resolveUploadRoots([path.join(home, 'Downloads')]);
  return { home, downloads, secrets, runtime, roots, forbidden: await resolveUploadRoots([runtime]) };
}

test('default upload root is the home folder; Library is forbidden; missing folders are skipped', async t => {
  const f = await tree(t);
  assert.deepEqual(defaultUploadRoots('/u'), ['/u']);
  assert.deepEqual(defaultForbiddenUploadDirs('/u'), ['/u/Library']);
  assert.deepEqual(f.roots, [f.downloads]);
  await assert.rejects(resolveUploadRoots(['relative/folder']), { code: 'INVALID_REQUEST' });
});

test('an ordinary file inside an allowed folder is accepted and returned canonically', async t => {
  const f = await tree(t);
  assert.deepEqual(await authorizeUploadFiles([path.join(f.home, 'link-to-downloads', 'resume.pdf')], f.roots, f.forbidden),
    [path.join(f.downloads, 'resume.pdf')]);
});

test('sensitive, hidden, linked-out, missing and non-file paths are all denied', async t => {
  const f = await tree(t);
  for (const file of [
    path.join(f.secrets, 'id_rsa'),                  // outside every allowed folder
    path.join(f.downloads, 'innocent.pdf'),          // symlink inside Downloads pointing at ~/.ssh
    path.join(f.downloads, '.env'),                  // hidden file
    path.join(f.downloads, '.hidden-dir', 'a.txt'),  // file under a hidden folder
    path.join(f.runtime, 'auth-token'),              // Broker runtime, even under an allowed root
    path.join(f.downloads, 'missing.pdf'),
    f.downloads,                                     // a directory, not a file
    path.join(f.downloads, '..', '.ssh', 'id_rsa'),
  ]) await assert.rejects(authorizeUploadFiles([file], f.roots, f.forbidden), { code: 'POLICY_DENIED' }, file);
  // One bad file rejects the whole set.
  await assert.rejects(authorizeUploadFiles([path.join(f.downloads, 'resume.pdf'), path.join(f.secrets, 'id_rsa')], f.roots, f.forbidden),
    { code: 'POLICY_DENIED' });
  await assert.rejects(authorizeUploadFiles([path.join(f.downloads, 'resume.pdf')], [], f.forbidden), { code: 'POLICY_DENIED' });
});

test('batches never carry upload, choose or download steps', () => {
  const base = { requestId: 'b', leaseId: 'l', documentEpoch: 'e' };
  for (const action of [{ kind: 'upload', ref: 'n', files: ['/tmp/a.pdf'] }, { kind: 'choose', ref: 'n', files: ['/tmp/a.pdf'] },
    { kind: 'download', ref: 'n' }]) {
    assert.throws(() => batchRequest({ ...base, steps: [{ action }] }), { code: 'INVALID_REQUEST' }, action.kind);
  }
  assert.equal(batchRequest({ ...base, steps: [{ action: { kind: 'click', ref: 'n' } }] }).steps.length, 1);
});
