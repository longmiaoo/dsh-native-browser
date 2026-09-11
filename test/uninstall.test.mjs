import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, lstat, chmod, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { installHost, HOST_NAME } from '../dist/packages/installer/src/install.js';
import { uninstallHost } from '../dist/packages/installer/src/uninstall.js';
import { snapshot, removeInstallationFile } from '../dist/packages/installer/src/files.js';
import { acquireBrokerOwnership } from '../dist/packages/broker/src/ownership.js';

const run=promisify(execFile), origin=id=>`chrome-extension://${id.repeat(32)}/`;
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function fixture(t) {
  const root=await mkdtemp('/tmp/dsh-u-');t.after(()=>rm(root,{recursive:true,force:true}));
  const options={directory:path.join(root,'runtime'),manifestDir:path.join(root,'chrome'),brand:'chrome',extensionId:'a'.repeat(32)};
  return {root,options,install:(patch={})=>installHost({...options,cliPath:path.resolve('bin/dsh-native-browser.mjs'),...patch})};
}
async function runtimeFiles(directory) {
  return Promise.all(['native-host','native-host.json','auth-token','actions.fixture'].map(async name=>{
    const file=path.join(directory,name);return {name,bytes:await readFile(file),ino:(await lstat(file,{bigint:true})).ino};
  }));
}

test('unregister removes only one browser origin and preserves shared runtime and other browser registration',async t=>{
  const f=await fixture(t),chrome=await f.install(); await f.install({extensionId:'c'.repeat(32)});
  const edge=await f.install({brand:'edge',manifestDir:path.join(f.root,'edge')});
  await writeFile(path.join(f.options.directory,'actions.fixture'),'preserved recovery sentinel',{mode:0o600});
  const before=await runtimeFiles(f.options.directory), old=await readFile(chrome.manifest), edgeBefore=await readFile(edge.manifest);
  const result=await uninstallHost(f.options);
  assert.equal(result.status,'removed');assert.equal(result.manifestRemoved,false);assert.equal(result.remainingOrigins,1);
  assert.equal(result.runningConnectionsStopped,false);assert.equal(result.runtimeStatePreserved,true);
  assert.deepEqual((await json(chrome.manifest)).allowed_origins,[origin('c')]);
  assert.deepEqual(await readFile(edge.manifest),edgeBefore);
  assert.deepEqual(await runtimeFiles(f.options.directory),before);
  assert.deepEqual(await readFile(result.backup),old);assert.equal((await lstat(result.backup)).mode&0o777,0o600);
  assert.ok(result.backup.endsWith('.disabled'));
});

test('last origin removes its manifest with a durable backup; repeat is a no-op and explicit reinstall works',async t=>{
  const f=await fixture(t),installed=await f.install();
  const old=await readFile(installed.manifest),token=await readFile(path.join(f.options.directory,'auth-token'));
  const result=await uninstallHost(f.options);assert.equal(result.manifestRemoved,true);assert.equal(result.remainingOrigins,0);
  assert.equal(await snapshot(installed.manifest),undefined);assert.deepEqual(await readFile(result.backup),old);
  const entries=await readdir(f.options.manifestDir);
  const again=await uninstallHost(f.options);assert.equal(again.status,'not-registered');assert.equal(again.backup,undefined);
  assert.deepEqual(await readdir(f.options.manifestDir),entries);
  await f.install();assert.deepEqual(await readFile(installed.manifest),old);
  assert.ok((await readFile(path.join(f.options.directory,'auth-token'))).equals(token));
});

test('absent registration does not create directories or runtime identity',async t=>{
  const f=await fixture(t);assert.equal((await uninstallHost(f.options)).status,'not-registered');
  assert.deepEqual(await readdir(f.root),[]);
});

test('an unregistered extension ID leaves the manifest unchanged without a backup',async t=>{
  const f=await fixture(t),r=await f.install();const before=await snapshot(r.manifest),entries=await readdir(f.options.manifestDir);
  const result=await uninstallHost({...f.options,extensionId:'b'.repeat(32)});
  assert.equal(result.status,'not-registered');assert.equal(result.remainingOrigins,1);assert.equal(result.backup,undefined);
  assert.equal((await snapshot(r.manifest)).stat.ino,before.stat.ino);assert.deepEqual(await readdir(f.options.manifestDir),entries);
});

test('malformed, foreign-runtime and linked manifests are preserved rather than removed',async t=>{
  for(const mode of ['malformed','foreign','symlink']) {
    const f=await fixture(t),r=await f.install();
    if(mode==='malformed') await writeFile(r.manifest,'unrecognized');
    if(mode==='foreign') {const m=await json(r.manifest);m.path=path.join(f.root,'other','native-host');await writeFile(r.manifest,JSON.stringify(m));}
    if(mode==='symlink') {const backup=path.join(f.root,'foreign.json');await writeFile(backup,await readFile(r.manifest),{mode:0o600});await rm(r.manifest);await symlink(backup,r.manifest);}
    const before=await readFile(r.manifest);
    await assert.rejects(uninstallHost(f.options),{code:'POLICY_DENIED'});
    assert.deepEqual(await readFile(r.manifest),before);
    assert.equal((await readdir(f.options.manifestDir)).some(n=>n.endsWith('.disabled')),false);
  }
});

test('partial installation can unregister a matching manifest without recreating a missing runtime',async t=>{
  const f=await fixture(t);await mkdir(f.options.manifestDir);
  const manifest=path.join(f.options.manifestDir,`${HOST_NAME}.json`);
  await writeFile(manifest,JSON.stringify({name:HOST_NAME,type:'stdio',path:path.join(f.options.directory,'native-host'),allowed_origins:[origin('a')]}),{mode:0o600});
  assert.equal((await uninstallHost(f.options)).manifestRemoved,true);
  await assert.rejects(lstat(f.options.directory),{code:'ENOENT'});
});

test('unsafe runtime or manifest directory blocks removal',async t=>{
  const f=await fixture(t),r=await f.install();const before=await readFile(r.manifest);
  await chmod(f.options.directory,0o777);
  await assert.rejects(uninstallHost(f.options),{code:'POLICY_DENIED'});
  await chmod(f.options.directory,0o700);await chmod(f.options.manifestDir,0o777);
  await assert.rejects(uninstallHost(f.options),{code:'POLICY_DENIED'});
  assert.deepEqual(await readFile(r.manifest),before);
});

test('uninstall cooperates with installer ownership locks',async t=>{
  const f=await fixture(t),r=await f.install(),old=await readFile(r.manifest);
  const lock=await acquireBrokerOwnership(path.join(f.options.manifestDir,'.dsh-host-install-lock'));
  try {await assert.rejects(uninstallHost(f.options),{code:'INSTALLATION_BUSY'});assert.deepEqual(await readFile(r.manifest),old);}
  finally {lock.close();}
  assert.equal((await uninstallHost(f.options)).status,'removed');
});

test('removal compares the exact file snapshot and preserves an intervening edit',async t=>{
  const f=await fixture(t),r=await f.install(),before=await snapshot(r.manifest);
  await writeFile(r.manifest,'manual edit');
  await assert.rejects(removeInstallationFile(r.manifest,before),{code:'POLICY_DENIED'});
  assert.equal(await readFile(r.manifest,'utf8'),'manual edit');
});

test('a real backup-write failure leaves the registration untouched',async t=>{
  if(process.getuid?.()===0) {t.skip('Root bypasses ordinary directory write permissions');return;}
  const f=await fixture(t),r=await f.install(),before=await readFile(r.manifest),entries=await readdir(f.options.manifestDir);
  await chmod(f.options.manifestDir,0o500);
  try {await assert.rejects(uninstallHost(f.options),{code:'INSTALLATION_FAILED'});}
  finally {await chmod(f.options.manifestDir,0o700);}
  assert.deepEqual(await readFile(r.manifest),before);assert.deepEqual(await readdir(f.options.manifestDir),entries);
});

test('CLI installs and unregisters only an explicit temporary registration directory',async t=>{
  const f=await fixture(t),base=['bin/dsh-native-browser.mjs'];
  const options=[`--runtime-dir=${f.options.directory}`,`--manifest-dir=${f.options.manifestDir}`,'--browser=chrome',`--extension-id=${f.options.extensionId}`];
  const installed=JSON.parse((await run(process.execPath,[...base,'install-host',...options])).stdout);
  const before=await readFile(installed.manifest);
  await assert.rejects(run(process.execPath,[...base,'doctor',...options]),error=>{
    const report=JSON.parse(error.stdout);
    assert.equal(report.checks.find(c=>c.id==='browser-manifest').status,'ok');
    return error.code===1; // Broker intentionally absent; the explicit registration path is valid.
  });
  const removed=JSON.parse((await run(process.execPath,[...base,'uninstall-host',...options])).stdout);
  assert.equal(removed.status,'removed');assert.equal(removed.manifestRemoved,true);
  assert.deepEqual(await readFile(removed.backup),before);
  assert.equal(JSON.parse((await run(process.execPath,[...base,'uninstall-host',...options])).stdout).status,'not-registered');
});
