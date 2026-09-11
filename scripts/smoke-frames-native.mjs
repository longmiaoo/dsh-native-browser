import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';
import { applyObservationUpdate } from '../dist/packages/contracts/src/observations.js';

const hostRoot=process.argv[2],executablePath=process.env.DSH_CHROME_TEST_EXECUTABLE,brand=process.env.DSH_TEST_BROWSER_BRAND??'chrome';
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_CHROME_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(180000),passed=[];
// All hosts resolve to the same owned loopback HTTP server; different sites force
// real OOPIF boundaries. Fixture mutations/oracles are test-only, not public tools.
const html=`<!doctype html><meta charset="utf-8"><title>Frame fixture</title><main id="fixture"></main><script>
const area=document.querySelector('#fixture');
function child(id,host,path){const el=document.createElement('iframe');el.id=id;el.src=location.protocol+'//'+host+':'+location.port+path+'?secret=never-return';area.append(el);}
if(location.pathname==='/'){
  area.innerHTML='<button id="root-button">Root control</button>';
  child('same','127.0.0.1','/same');child('remote','localhost','/b');
  const opaque=document.createElement('iframe');opaque.id='opaque';opaque.sandbox='';opaque.srcdoc='<button>Opaque private content</button>';area.append(opaque);
}else if(location.pathname==='/b'){area.innerHTML='<button>Remote private content</button>';child('nested','127.0.0.1','/c');}
else {area.innerHTML='<p id="child-text">子页面正文 🙂</p><input type="password" value="never-return-password"><button>Child private content</button>';
  for(let i=0;i<20;i++){const button=document.createElement('button');button.textContent='Child control '+i;area.append(button);}}
</script>`;
let adapter;
try{
  adapter=await nativeAdapter({hostRoot,executablePath,signal,brand,html});
  let h=await adapter.prepare({},'frames-native');
  await h.page.waitForFunction(()=>document.querySelector('#same')?.contentDocument?.readyState==='complete');
  for(const frame of h.page.frames())await frame.waitForLoadState('load');
  // Observe extension-owned attachment events, not Playwright's own CDP sessions.
  await adapter.worker.evaluate(()=>{
    globalThis.frameProbe=[];
    chrome.debugger.onEvent.addListener((source,method,p)=>{
      if(method==='Target.attachedToTarget'&&p.targetInfo?.type==='iframe')
        globalThis.frameProbe.push({parent:source.sessionId??'',child:p.sessionId,tabId:source.tabId});
    });
  });
  const read=()=>adapter.tool('browser_frames',{leaseId:h.lease.id});
  // A live topology is allowed to reject a raced read. Retries are bounded and
  // metadata-only; successful but incomplete/wrong graphs are never accepted.
  let readRetries=0;
  const settled=async()=>{for(let i=0;i<5;i++){try{return await read();}catch(error){if(i===4)throw error;readRetries++;await new Promise(r=>setTimeout(r,50));}}};
  const first=await settled();assert.equal(first.truncated,false);assert.equal(first.frames.length,5);
  assert.equal(first.frames.filter(f=>f.isMain).length,1);
  assert.equal(first.frames.filter(f=>f.contextStatus==='known').length,5);
  const main=first.frames.find(f=>f.isMain),remote=first.frames.find(f=>f.originRelation==='cross-origin');
  assert.ok(remote);const nested=first.frames.find(f=>f.parentId===remote.id);assert.ok(nested);
  assert.equal(nested.originRelation,'same-origin');assert.ok(first.frames.some(f=>f.originRelation==='opaque'));
  assert.doesNotMatch(JSON.stringify(first),/private|secret|sessionId|uniqueId|\/b|\/same|srcdoc/);
  const attachments=await adapter.worker.evaluate(()=>globalThis.frameProbe);
  assert.ok(attachments.some(event=>event.parent&&attachments.some(parent=>parent.child===event.parent)), 'Nested extension-owned flat session must be attached recursively');
  assert.ok(attachments.length>=2);
  passed.push('Real extension-owned recursive OOPIF sessions and same-process/opaque frames produce a five-frame, origin-only tree');
  assert.deepEqual(await settled(),first);
  passed.push('Unchanged frame and document identities survive repeat discovery without touching AX delta baselines');
  assert.ok(!(await h.observe()).text.some(text=>/private content/.test(text)));
  const refused=await h.act({kind:'click',ref:remote.id});assert.notEqual(refused.outcome,'succeeded');assert.equal(refused.dispatch,'notDispatched');
  await assert.rejects(h.capture());
  passed.push('Discovery does not expose child AX text, turn frame IDs into input refs, or authorize cross-origin screenshots');
  const same=first.frames.find(f=>f.parentId===main.id&&f.originRelation==='same-origin');assert.ok(same);
  const sameFrame=h.page.frames().find(f=>new URL(f.url()).pathname==='/same');assert.ok(sameFrame);
  const observeFrame=(frame,cursor)=>h.observe({frame:{frameId:frame.id,documentEpoch:frame.documentEpoch},...(cursor?{cursor}:{})});
  const rootBefore=await h.observe(),childView=await observeFrame(same);
  assert.equal(childView.format,'full');assert.deepEqual(childView.scope,{kind:'frame',frameId:same.id});
  assert.ok(childView.text.includes('子页面正文 🙂'));assert.ok(childView.nodes.some(n=>n.name==='Child private content'));
  assert.ok(!childView.nodes.some(n=>n.name==='Root control'));assert.doesNotMatch(JSON.stringify(childView),/never-return-password|sessionId|uniqueId/);
  await sameFrame.locator('#child-text').evaluate(el=>el.textContent='更新后的子页面正文');
  const childDelta=await observeFrame(same,childView.cursor);assert.equal(childDelta.format,'delta');
  assert.ok(applyObservationUpdate(childView,childDelta).text.includes('更新后的子页面正文'));
  assert.equal((await h.observe({cursor:rootBefore.cursor})).resyncRequired,false);
  assert.equal((await observeFrame(same,rootBefore.cursor)).resyncRequired,true);
  const childNode=childView.nodes.find(n=>n.name==='Child private content');
  assert.equal((await h.act({kind:'click',ref:childNode.id})).dispatch,'notDispatched');
  passed.push('Explicit same-origin child AX reads Chinese text and controls, preserves independent deltas, omits password values and cannot masquerade as root input');
  for(const denied of [remote,nested,first.frames.find(f=>f.originRelation==='opaque')])await assert.rejects(observeFrame(denied));
  passed.push('Foreign and opaque children and same-origin descendants behind a foreign ancestor receive no content read');
  await sameFrame.goto(new URL('/same-next',h.page.url()).href);const afterNavigation=await settled();
  const changed=afterNavigation.frames.find(f=>f.id===same.id);assert.ok(changed);assert.notEqual(changed.documentEpoch,same.documentEpoch);
  assert.deepEqual(afterNavigation.frames.find(f=>f.id===main.id),main);
  await assert.rejects(observeFrame(same));assert.ok((await observeFrame(changed)).text.includes('子页面正文 🙂'));
  passed.push('Same-process child navigation changes its document epoch while preserving unrelated root identity');
  const swap=async url=>{
    const navigation=h.page.waitForEvent('framenavigated',{predicate:frame=>frame.url()===url});
    await h.page.locator('#remote').evaluate((el,url)=>el.src=url,url);
    const frame=await navigation;await frame.waitForLoadState('load');return frame;
  };
  await swap(new URL('/remote-now-local',h.page.url()).href);const localSwap=await settled();
  const localVersion=localSwap.frames.find(f=>f.id===remote.id);assert.ok(localVersion);
  assert.equal(localVersion.originRelation,'same-origin');assert.equal(localVersion.contextStatus,'known');
  assert.notEqual(localVersion.documentEpoch,remote.documentEpoch);assert.equal(localSwap.frames.length,4);
  assert.ok((await observeFrame(localVersion)).nodes.some(n=>n.name==='Child private content'));
  const remoteFrame=await swap(remote.origin+'/b');await remoteFrame.childFrames()[0].waitForLoadState('load');
  const remoteSwap=await settled(),remoteAgain=remoteSwap.frames.find(f=>f.id===remote.id);assert.ok(remoteAgain);
  assert.equal(remoteAgain.originRelation,'cross-origin');assert.equal(remoteAgain.contextStatus,'known');
  assert.notEqual(remoteAgain.documentEpoch,localVersion.documentEpoch);assert.equal(remoteSwap.frames.length,5);
  assert.notEqual(remoteSwap.frames.find(f=>f.parentId===remote.id).id,nested.id);
  await assert.rejects(observeFrame(localVersion));await assert.rejects(observeFrame(remoteAgain));
  passed.push('Cross-site to same-process and back preserves the frame handle, renews its document/context epoch and never revives removed descendant handles');
  await h.page.locator('#remote').evaluate(el=>el.remove());const removed=await settled();
  assert.equal(removed.frames.length,3);assert.ok(!removed.frames.some(f=>[remote.id,nested.id].includes(f.id)));
  passed.push('Removing a remote parent removes its recursively attached descendant from the next inventory');
  await adapter.stop();await assert.rejects(read());await assert.rejects(observeFrame(changed));await adapter.allow();h=await adapter.prepare({},'frames-after-stop');
  const renewed=await settled();assert.ok(renewed.frames.every(f=>!first.frames.some(old=>old.id===f.id)));
  await assert.rejects(observeFrame(changed));
  passed.push('Actual extension Stop revokes discovery; new consent cannot resurrect old frame handles');
  await adapter.tool('browser_handoff',{leaseId:h.lease.id});assert.equal(h.page.isClosed(),false);
  const detached=await adapter.worker.evaluate(async tabId=>{
    try{await chrome.debugger.sendCommand({tabId},'Page.getFrameTree');return false;}catch{return true;}
  },attachments[0].tabId);assert.equal(detached,true);
  passed.push('Handoff releases recursive debugging sessions and preserves the user-visible test page');
  const versions={browserVersion:adapter.browserVersion,dshVersion:adapter.dshVersion};
  const cleanup=await adapter.close();adapter=undefined;assert.equal(cleanup.complete,true);
  const report={checkedAt:new Date().toISOString(),brand,...versions,passed,frames:first.frames.length,
    attachmentCount:attachments.length,recursiveAttachment:true,readRetries,cleanup,
    scope:'Real DSH -> Broker -> Native Host -> MV3 flat sessions, isolated loopback-only profile. Metadata and explicit same-origin ancestor-chain AX reads/deltas; this gate does not exercise child input, cross-origin approval or bound geometry. No model or Codex parity claim.'};
  await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright',brand+'-frames-native-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{if(adapter)assert.equal((await adapter.close()).complete,true);}
