import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const cli = process.argv[2];
if (!cli) throw Error('Pass the absolute path of an installed DSH lib/bin.js entry');
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp('/tmp/dsh-profile-');
try {
  const env = { ...process.env, DSH_HOME: path.join(temporary, 'home') };
  const archive = (await exec('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', temporary], { cwd: root })).stdout.trim().split('\n').at(-1);
  await exec(process.execPath, [cli, 'plugin', '--profile', 'browser-check', 'add', path.join(temporary, archive)], { env });
  const result = JSON.parse((await exec(process.execPath, [cli, 'plugin', '--profile', 'browser-check', 'exec',
    'dsh-native-browser', 'install', '--browser=chrome', '--no-service', '--no-open', '--json',
    `--runtime-dir=${temporary}/runtime`, `--manifest-dir=${temporary}/native`], { env })).stdout);
  assert.equal(result.extensionPath, path.join(temporary, 'runtime/extension/chrome'));
  const pkg = JSON.parse(await readFile(path.join(temporary, 'home/profiles/browser-check/node_modules/dsh-native-browser/package.json')));
  const candidate = JSON.parse(await readFile(path.join(root, 'package.json')));
  assert.equal(pkg.version, candidate.version);
  console.log('Actual DSH CLI profile add and exec install passed in an isolated DSH_HOME. No daily profile, desktop service or browser changed.');
} finally { await rm(temporary, { recursive: true, force: true }); }
