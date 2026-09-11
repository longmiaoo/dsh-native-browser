import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';

const hostRoot=process.argv[2],executablePath=process.env.DSH_CHROME_TEST_EXECUTABLE,brand=process.env.DSH_TEST_BROWSER_BRAND??'chrome';
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_CHROME_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(180000),passed=[],requests=[];
// Owned fixture/oracles only. Every action under test goes through public DSH;
// Playwright mutates fixtures and reads independent event evidence, never clicks.
const html=`<!doctype html><meta charset="utf-8"><title>Nested child click</title><style>
body{margin:0}iframe{position:absolute;transform-origin:0 0}#outer{left:120px;top:90px;width:760px;height:560px;border:11px solid teal;padding:7px;transform:rotate(5deg) scale(.9)}
#inner{left:70px;top:80px;width:450px;height:320px;border:9px solid navy;padding:5px;transform:perspective(700px) rotateY(15deg) scale(.9)}
#target{position:absolute;left:80px;top:70px;width:160px;height:55px}#result{position:absolute;top:170px}
</style><main id="fixture"></main><script>
const area=document.querySelector('#fixture');globalThis.hits=[];
if(location.pathname==='/'){
 area.innerHTML='<p>root-only-result</p><iframe id="outer" src="/parent"></iframe>';
 const remote=document.createElement('iframe');remote.id='remote';remote.src=location.protocol+'//localhost:'+location.port+'/foreign';remote.style.cssText='left:1000px;top:600px;width:180px;height:140px';area.append(remote);
}else if(location.pathname==='/parent')area.innerHTML='<iframe id="inner" src="/leaf"></iframe>';
else if(location.pathname==='/leaf'){
 area.innerHTML='<button id="target">子帧提交</button><p id="result">等待子帧</p>';
 document.querySelector('#target').addEventListener('click',event=>{hits.push({trusted:event.isTrusted,x:event.clientX,y:event.clientY});document.querySelector('#result').textContent='子帧已完成 '+hits.length;});
}else area.innerHTML='<button>Foreign private button</button>';
</script>`;
let adapter,session,handler=async()=> 'allowed-once',sequence=0;
const eventual=async check=>{for(let i=0;i<150;i++){signal.throwIfAborted();if(await check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected isolated child-click event');};
try{
 adapter=await nativeAdapter({hostRoot,executablePath,signal,brand,html,configureApproval:async({ctx,session:current,load})=>{
  session=current;const {ApprovalService}=await load('@deepseek-ai/dsh-user-approval');await ctx.plugin(ApprovalService,{policy:'ask'});
  ctx.on('approval/request',request=>{requests.push(request);return handler(request);});
 }});
 let h,leaf,target,view,foreign,leafPage;
 const discover=async()=>{
  for(const frame of h.page.frames())await frame.waitForLoadState('load');
  const inventory=await adapter.tool('browser_frames',{leaseId:h.lease.id});
  assert.equal(inventory.truncated,false);assert.equal(inventory.frames.length,4);
  const main=inventory.frames.find(f=>f.isMain),parent=inventory.frames.find(f=>f.parentId===main.id&&f.originRelation==='same-origin');assert.ok(parent);
  leaf=inventory.frames.find(f=>f.parentId===parent.id);assert.ok(leaf);
  foreign=inventory.frames.find(f=>f.originRelation==='cross-origin');assert.ok(foreign);
  target={frameId:leaf.id,documentEpoch:leaf.documentEpoch};
  view=await h.observe({frame:target});assert.deepEqual(view.scope,{kind:'frame',frameId:leaf.id});
  leafPage=h.page.frames().find(f=>new URL(f.url()).pathname==='/leaf');assert.ok(leafPage);
 };
 const prepare=async()=>{h=await adapter.prepare({},'frame-click-native');await h.page.waitForFunction(()=>document.querySelector('#outer')?.contentDocument?.querySelector('#inner')?.contentDocument?.querySelector('#target'));await discover();};
 const request=(expected,timeoutMs=3000)=>{
  const nodes=view.nodes.filter(n=>n.name==='子帧提交');assert.equal(nodes.length,1);
  return {requestId:'frame-click-'+(++sequence),leaseId:h.lease.id,documentEpoch:target.documentEpoch,frame:{...target},
   action:{kind:'click',ref:nodes[0].id,...(expected===undefined?{}:{expected:{kind:'text',text:expected}})},timeoutMs};
 };
 const execute=request=>adapter.tool('browser_act',request);
 const hits=()=>leafPage.evaluate(()=>hits);
 const refused=async request=>{const before=(await hits()).length,result=await execute(request);assert.equal(result.dispatch,'notDispatched',JSON.stringify(result));assert.notEqual(result.outcome,'succeeded');assert.equal((await hits()).length,before);return result;};
 await prepare();
 const good=request('子帧已完成 1'),result=await execute(good);assert.equal(result.outcome,'succeeded',JSON.stringify(result));
 assert.deepEqual(result.observation.scope,{kind:'frame',frameId:leaf.id});assert.ok(!result.observation.text.includes('root-only-result'));
 assert.equal((await hits()).length,1);assert.equal((await hits())[0].trusted,true);
 assert.deepEqual(await execute(good),result);assert.equal((await hits()).length,1);
 passed.push('Public DSH click crosses two transformed bordered/padded same-origin frames beside a foreign sibling, produces one trusted event and child-only verified observation; replay does not click again');

 view=await h.observe({frame:target});const noExpected=request(),unverified=await execute(noExpected);
 assert.equal(unverified.outcome,'unknown');assert.equal((await hits()).length,2);assert.deepEqual(await execute(noExpected),unverified);assert.equal((await hits()).length,2);
 passed.push('A child click without a postcondition remains unknown and is never replayed');

 view=await h.observe({frame:target});const rootOnly=request('root-only-result',1500),timeout=await execute(rootOnly);
 assert.equal(timeout.outcome,'unknown');assert.equal(timeout.code,'DEADLINE_EXCEEDED');assert.equal((await hits()).length,3);
 assert.deepEqual(await execute(rootOnly),timeout);assert.equal((await hits()).length,3);
 passed.push('Root text cannot satisfy a child expectation; a real post-dispatch timeout has no input replay');

 view=await h.observe({frame:target});const covered=request('never');
 await h.page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='overlay';overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(overlay);});
 await refused(covered);await h.page.locator('#overlay').evaluate(el=>el.remove());
 passed.push('A root overlay blocks child dispatch during source-bound preflight');
 await leafPage.locator('#target').evaluate(el=>el.textContent='Renamed child');await refused(request('never'));
 await leafPage.locator('#target').evaluate(el=>el.textContent='子帧提交');view=await h.observe({frame:target});const replaced=request('never');
 await leafPage.locator('#target').evaluate(el=>el.replaceWith(el.cloneNode(true)));await refused(replaced);
 passed.push('Renamed and same-name replacement child controls cannot reuse an observed reference');

 const foreignRequest={...request('never'),documentEpoch:foreign.documentEpoch,frame:{frameId:foreign.id,documentEpoch:foreign.documentEpoch}};
 assert.equal((await refused(foreignRequest)).code,'POLICY_DENIED');
 passed.push('Foreign sibling metadata and a valid local node reference do not grant cross-origin input');
 const old=request('never');await leafPage.goto(new URL('/leaf?new-document',h.page.url()).href);await refused(old);await discover();
 assert.notEqual(target.documentEpoch,old.frame.documentEpoch);
 passed.push('Child reload invalidates the old document epoch before any input');

 handler=async req=>req.toolName==='browser_act'?'rejected':'allowed-once';
 await assert.rejects(execute(request('never')),{code:'HOST_TOOL_ERROR'});assert.equal((await hits()).length,0);handler=async()=> 'allowed-once';
 passed.push('The real DSH public ApprovalService can reject child input before dispatch');

 let finish,entered=false;handler=req=>req.toolName==='browser_act'?new Promise(resolve=>{entered=true;finish=resolve;}):Promise.resolve('allowed-once');
 const stopping=execute(request('never')).then(value=>({value}),error=>({error}));await eventual(()=>entered);await adapter.stop();finish('allowed-once');
 const stopped=await stopping;assert.ok(stopped.error||stopped.value.outcome!=='succeeded');assert.equal((await hits()).length,0);handler=async()=> 'allowed-once';
 passed.push('Actual extension Stop during pending public approval prevents a late grant from clicking');

 await adapter.allow();await prepare();const crashRequest=request('never-after-crash',5000);
 const crashing=execute(crashRequest).then(value=>({value}),error=>({error}));await eventual(async()=> (await hits()).length===1);
 const restart=await adapter.crashAndRestartBroker();assert.equal(restart.recoveredSocket,true);
 const crashed=await crashing;assert.ok(crashed.error||crashed.value.outcome!=='succeeded');
 const recovery=await execute(crashRequest);assert.equal(recovery.code,'RECOVERY_REQUIRED',JSON.stringify(recovery));assert.equal((await hits()).length,1);
 passed.push('SIGKILL after the trusted child click recovers durable intent without restoring control or repeating input');

 const events=Array.from({length:session.seq},(_,i)=>session.eventAt(i)).filter(Boolean),asks=events.filter(e=>e.type==='approval/asked'),decisions=events.filter(e=>e.type==='approval/decided');
 assert.equal(asks.length,decisions.length);for(const ask of asks)assert.equal(decisions.filter(d=>d.data.id===ask.data.id).length,1);
 passed.push('Each real public approval request has exactly one audited decision');
 const versions={browserVersion:adapter.browserVersion,dshVersion:adapter.dshVersion},cleanup=await adapter.close();adapter=undefined;assert.equal(cleanup.complete,true);
 const files=['scripts/smoke-frame-click-native.mjs','packages/provider-chromium/src/frame-click.ts','packages/provider-chromium/src/frame-geometry-read.ts','packages/provider-chromium/src/frame-sessions.ts','packages/provider-chromium/src/provider.ts','packages/runtime-core/src/runtime.ts','packages/dsh-adapter/src/index.ts','dist/extension/'+brand+'/background.js'];
 const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
 const report={checkedAt:new Date().toISOString(),brand,...versions,passed,approvalAudit:{asked:asks.length,decided:decisions.length},cleanup,hashes,
  scope:'Real DSH ToolRuntime and public ApprovalService with controlled local answerers -> Broker -> Native Host -> MV3 -> isolated browser, owned loopback fixture. Nested same-origin same-process child clicks only; no LLM, actual human approval UI, signed-in pages, cross-origin input, OOPIF geometry or Codex parity claim.'};
 await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright',brand+'-frame-click-native-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(adapter)assert.equal((await adapter.close()).complete,true);}
