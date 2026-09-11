import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, lstat, chmod, symlink, link, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { installHost, HOST_NAME } from '../dist/packages/installer/src/install.js';
import { snapshot, commitFiles, publishInstallationFile } from '../dist/packages/installer/src/files.js';
import { acquireBrokerOwnership } from '../dist/packages/broker/src/ownership.js';
import { launcherPaths } from '../dist/packages/installer/src/launcher.js';

const origin=id=>`chrome-extension://${id.repeat(32)}/`;
async function fixture(t) {
  const root=await mkdtemp('/tmp/dsh-i-'); t.after(()=>rm(root,{recursive:true,force:true}));
  const options={directory:path.join(root,'runtime'),manifestDir:path.join(root,'chrome'),brand:'chrome',extensionId:'a'.repeat(32),cliPath:path.resolve('bin/dsh-native-browser.mjs')};
  return {root,options,install:(patch={})=>installHost({...options,...patch})};
}
async function files(options) {
  return Promise.all([path.join(options.directory,'native-host'),path.join(options.directory,'native-host.json'),
    path.join(options.manifestDir,`${HOST_NAME}.json`)].map(file=>snapshot(file)));
}
const json=async file=>JSON.parse(await readFile(file,'utf8'));

test('fresh install is private, absolute and idempotent without rotating runtime identity',async t=>{
  const f=await fixture(t), result=await f.install();
  const before=await files(f.options), token=await readFile(path.join(f.options.directory,'auth-token'));
  assert.equal(Number(before[0].stat.mode&0o777n),0o700);
  for(const file of before.slice(1)) assert.equal(Number(file.stat.mode&0o777n),0o600);
  assert.equal(launcherPaths(before[0].bytes.toString()).directory,f.options.directory);
  assert.deepEqual((await json(result.manifest)).allowed_origins,[origin('a')]);
  assert.deepEqual(await f.install(),result);
  const after=await files(f.options);
  for(let i=0;i<before.length;i++) {assert.equal(after[i].stat.ino,before[i].stat.ino);assert.deepEqual(after[i].bytes,before[i].bytes);}
  assert.deepEqual(await readFile(path.join(f.options.directory,'auth-token')),token);
});

test('brand-specific manifests stay scoped while the shared host preserves the union of caller origins',async t=>{
  const f=await fixture(t), chrome=await f.install();
  const edge=await f.install({brand:'edge',manifestDir:path.join(f.root,'edge'),extensionId:'b'.repeat(32)});
  assert.deepEqual((await json(chrome.manifest)).allowed_origins,[origin('a')]);
  assert.deepEqual((await json(edge.manifest)).allowed_origins,[origin('b')]);
  await f.install({extensionId:'c'.repeat(32)});
  assert.deepEqual((await json(chrome.manifest)).allowed_origins,[origin('a'),origin('c')]);
  assert.deepEqual((await json(edge.manifest)).allowed_origins,[origin('b')]);
  assert.deepEqual((await json(path.join(f.options.directory,'native-host.json'))).allowedOrigins,[origin('a'),origin('b'),origin('c')]);
});

test('all existing host targets are validated before updating any file',async t=>{
  for(const kind of ['launcher','config','manifest']) {
    const f=await fixture(t), r=await f.install(), before=await files(f.options);
    const target=kind==='launcher'?r.launcher:kind==='config'?path.join(f.options.directory,'native-host.json'):r.manifest;
    await writeFile(target,'foreign-or-corrupt-data');
    const broken=await files(f.options);
    await assert.rejects(f.install({extensionId:'b'.repeat(32)}),{code:'POLICY_DENIED'});
    const after=await files(f.options);
    for(let i=0;i<3;i++) {assert.deepEqual(after[i].bytes,broken[i].bytes);assert.equal(after[i].stat.ino,before[i].stat.ino);}
  }
});

test('symlink, hardlink, unsafe permissions and oversized targets are not overwritten',async t=>{
  for(const kind of ['symlink','hardlink','mode','oversize']) {
    const f=await fixture(t),r=await f.install();
    const external=path.join(f.root,'external'); await writeFile(external,'outside',{mode:0o600});
    if(kind==='symlink'||kind==='hardlink') {
      await rm(r.launcher); await (kind==='symlink'?symlink:link)(external,r.launcher);
    } else if(kind==='mode') await chmod(r.launcher,0o777);
    else await writeFile(r.launcher,'x'.repeat(16385));
    const before=await readFile(r.launcher);
    await assert.rejects(f.install(),{code:'POLICY_DENIED'});
    assert.deepEqual(await readFile(r.launcher),before); assert.equal(await readFile(external,'utf8'),'outside');
  }
});

test('another runtime cannot take over an existing browser host registration',async t=>{
  const f=await fixture(t),r=await f.install(),before=await readFile(r.manifest);
  const other=path.join(f.root,'other-runtime');
  await assert.rejects(f.install({directory:other}),{code:'POLICY_DENIED'});
  assert.deepEqual(await readFile(r.manifest),before);
  assert.equal(await snapshot(path.join(other,'native-host')),undefined);
});

test('invalid executable paths and unsafe manifest directories do not publish host files',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.install({nodePath:path.join(f.root,'missing')}),{code:'ENOENT'});
  assert.equal(await snapshot(path.join(f.options.directory,'native-host')),undefined);
  await mkdir(f.options.manifestDir,{mode:0o777}); await chmod(f.options.manifestDir,0o777);
  await assert.rejects(f.install(),{code:'POLICY_DENIED'});
  assert.equal(await snapshot(path.join(f.options.directory,'native-host')),undefined);
});

test('runtime and browser-registration locks each block a competing installation',async t=>{
  const f=await fixture(t); await f.install();
  for(const location of [path.join(f.options.directory,'.host-install-lock'),path.join(f.options.manifestDir,'.dsh-host-install-lock')]) {
    const held=await acquireBrokerOwnership(location);
    try {await assert.rejects(f.install({extensionId:'b'.repeat(32)}),{code:'INSTALLATION_BUSY'});}
    finally {held.close();}
  }
  await f.install({extensionId:'b'.repeat(32)});
  assert.deepEqual((await json(path.join(f.options.directory,'native-host.json'))).allowedOrigins,[origin('a'),origin('b')]);
});

test('an independent process holds both installation locks and SIGKILL releases them without deleting lock files',async t=>{
  const f=await fixture(t); await f.install();
  const dirs=[path.join(f.options.directory,'.host-install-lock'),path.join(f.options.manifestDir,'.dsh-host-install-lock')];
  const code=`const {acquireBrokerOwnership}=await import(process.argv[1]);
    for(const dir of process.argv.slice(2)) await acquireBrokerOwnership(dir);
    process.on('message',()=>{}); process.send('ready');`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,
    new URL('../dist/packages/broker/src/ownership.js',import.meta.url).href,...dirs],{stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  const exited=once(child,'exit'); t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const ready=await Promise.race([once(child,'message',{signal:AbortSignal.timeout(5000)}),exited.then(()=>{throw new Error(errors);})]);
  assert.equal(ready[0],'ready');
  const locks=await Promise.all(dirs.map(dir=>lstat(path.join(dir,'broker-lock.sqlite'),{bigint:true})));
  await assert.rejects(f.install({extensionId:'b'.repeat(32)}),{code:'INSTALLATION_BUSY'});
  child.kill('SIGKILL'); await exited;
  await f.install({extensionId:'b'.repeat(32)});
  for(let i=0;i<dirs.length;i++) assert.equal((await lstat(path.join(dirs[i],'broker-lock.sqlite'),{bigint:true})).ino,locks[i].ino);
});

test('ordinary mid-install failures restore previous bytes and modes, including failure after publication',async t=>{
  for(const failAfter of [1,2,3]) {
    const f=await fixture(t); await mkdir(f.options.directory,{mode:0o700});
    const changes=[];
    for(let i=0;i<3;i++) {
      const file=path.join(f.options.directory,`host-${i}`); await writeFile(file,`old-${i}`,{mode:i?0o600:0o700});
      changes.push({file,before:await snapshot(file),bytes:Buffer.from(`new-${i}`),mode:0o600});
    }
    let count=0;
    await assert.rejects(commitFiles(changes,async(change,committed)=>{
      await publishInstallationFile(change,committed);
      if(++count===failAfter) throw new Error('Injected post-publication I/O failure');
    }),e=>e.code==='INSTALLATION_FAILED'&&e.message.includes('were rolled back'));
    for(const change of changes) {
      const now=await snapshot(change.file); assert.deepEqual(now.bytes,change.before.bytes); assert.equal(now.stat.mode,change.before.stat.mode);
    }
    assert.equal((await readdir(f.options.directory)).some(n=>n.endsWith('.tmp')),false);
  }
});

test('failed first installation removes only the files it published',async t=>{
  const f=await fixture(t); await mkdir(f.options.directory,{mode:0o700});
  const keep=path.join(f.options.directory,'keep'); await writeFile(keep,'keep');
  const changes=['one','two'].map(name=>({file:path.join(f.options.directory,name),bytes:Buffer.from(name),mode:0o600}));
  let count=0;
  await assert.rejects(commitFiles(changes,async(change,committed)=>{
    if(++count===2) throw new Error('write failure'); await publishInstallationFile(change,committed);
  }),{code:'INSTALLATION_FAILED'});
  assert.deepEqual(await readdir(f.options.directory),['keep']);
});

test('rollback preserves a foreign replacement and explicitly reports incomplete recovery',async t=>{
  const f=await fixture(t); await mkdir(f.options.directory,{mode:0o700});
  const file=path.join(f.options.directory,'host'); await writeFile(file,'old',{mode:0o600});
  const change={file,before:await snapshot(file),bytes:Buffer.from('new'),mode:0o600};
  await assert.rejects(commitFiles([change],async(c,committed)=>{
    await publishInstallationFile(c,committed); await rm(file); await writeFile(file,'foreign',{mode:0o600}); throw new Error('failure');
  }),e=>e.code==='INSTALLATION_FAILED'&&e.message.includes('rollback was incomplete'));
  assert.equal(await readFile(file,'utf8'),'foreign');
});

test('a changed preflight target is preserved before publication',async t=>{
  const f=await fixture(t); await mkdir(f.options.directory,{mode:0o700});
  const file=path.join(f.options.directory,'host'); await writeFile(file,'old',{mode:0o600});
  const change={file,before:await snapshot(file),bytes:Buffer.from('new'),mode:0o600};
  await writeFile(file,'manual-change');
  await assert.rejects(commitFiles([change]),{code:'INSTALLATION_FAILED'});
  assert.equal(await readFile(file,'utf8'),'manual-change');
});
