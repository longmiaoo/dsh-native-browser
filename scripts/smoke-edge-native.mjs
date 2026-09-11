import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';
import { benchmarkCases } from './benchmark/cases.mjs';

const hostRoot=process.argv[2],executablePath=process.env.DSH_EDGE_TEST_EXECUTABLE;
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_EDGE_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(180000),passed=[],casesPassed=[],asks=[];
const coreFingerprint=async()=>Object.fromEntries(await Promise.all((await readdir(path.join(root,'packages/runtime-core/src'))).sort()
  .filter(file=>file.endsWith('.ts')).map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,'packages/runtime-core/src',file))).digest('hex')])));
const coreBefore=await coreFingerprint();let adapter,session;
const eventual=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected isolated Edge event');};
try {
  adapter=await nativeAdapter({hostRoot,executablePath,brand:'edge',signal,html:await readFile(path.join(root,'test/fixtures/benchmark.html')),
    configureApproval:async({ctx,session:current,load})=>{
      session=current;const {ApprovalService}=await load('@deepseek-ai/dsh-user-approval');await ctx.plugin(ApprovalService,{policy:'ask'});
      ctx.on('approval/request',req=>{asks.push(req);return 'allowed-once';});
    }});
  assert.equal(adapter.instance.brand,'edge');assert.equal(adapter.instance.family,'chromium');
  const userAgent=await adapter.page.evaluate(()=>navigator.userAgent);assert.match(userAgent,/Edg\//);assert.match(adapter.instance.version,/Edg\//);
  passed.push('Real Microsoft Edge loads the Edge MV3 bundle and starts the isolated Native Host; DSH discovers the Chromium-family Edge instance');

  for(const task of benchmarkCases){const h=await adapter.prepare(task,'edge-'+task.id);const result=await task.run(h);await task.verify(h,result);casesPassed.push(task.id);}
  assert.equal(casesPassed.length,20);
  passed.push('All 20 existing Chrome L1 executor fixture oracles pass unchanged on Edge, including AX/deltas/query, Chinese/editor input, scrolling/wheel, stale/origin refusal and Host image hashing');

  let h=await adapter.prepare({},'edge-batch');const before=asks.filter(a=>a.toolName==='browser_batch').length;
  const batch={requestId:'edge-batch',leaseId:h.lease.id,documentEpoch:h.snapshot.documentEpoch,steps:[
    {action:{kind:'fill',ref:h.ref('Benchmark input'),text:'Edge 中文🙂'}},
    {action:{kind:'press',ref:h.ref('Benchmark input'),key:'Enter',expected:{kind:'text',text:'Form submitted'}}}]};
  const complete=await adapter.tool('browser_batch',batch);assert.equal(complete.outcome,'succeeded');
  assert.equal(await h.page.locator('#input').inputValue(),'Edge 中文🙂');assert.equal(await h.page.evaluate(()=>bench.counts.submit),1);
  assert.equal(asks.filter(a=>a.toolName==='browser_batch').length-before,2);
  assert.deepEqual(await adapter.tool('browser_batch',batch),complete);assert.equal(await h.page.evaluate(()=>bench.counts.submit),1);
  passed.push('Edge executes a Chinese fill/Enter batch with separate real ApprovalService grants and no whole-batch replay');

  h=await adapter.prepare({},'edge-pages');
  await h.page.evaluate(()=>{const region=document.createElement('section');region.setAttribute('aria-label','Edge paging region');
    for(let i=0;i<220;i++){const button=document.createElement('button');button.textContent='Edge page '+i;region.append(button);}document.body.append(region);});
  const roots=await h.observe({query:{name:'Edge paging region',role:'region'}});const rootRef=roots.nodes.find(n=>n.name==='Edge paging region').id;
  const names=[];let continuation,windows=0;
  do{const page=await adapter.tool('browser_read_page',{leaseId:h.lease.id,rootRef,...(continuation?{continuation}:{})});
    assert.equal(page.page.index,windows++);assert.equal(page.page.incomplete,false);names.push(...page.nodes.filter(n=>n.role==='button').map(n=>n.name));continuation=page.page.continuation;
  }while(continuation);
  assert.deepEqual(names,Array.from({length:220},(_,i)=>'Edge page '+i));
  passed.push('The shared source-side pager traverses all 220 Edge controls in bounded scoped windows');

  h=await adapter.prepare({},'edge-navigation');const old=h.ref('Benchmark input'),destination=new URL('/after-navigation',h.page.url()).href;
  const navigation=await h.act({kind:'navigate',url:destination,expected:{kind:'url',url:destination}});assert.equal(navigation.outcome,'succeeded');
  const stale=await h.act({kind:'fill',ref:old,text:'must not type'});assert.equal(stale.dispatch,'notDispatched');assert.equal(stale.code,'STALE_TARGET');
  assert.equal(await h.page.locator('#input').inputValue(),'');
  passed.push('Same-origin Edge navigation verifies its destination and refuses old-document input references');

  h=await adapter.prepare({},'edge-stop');await h.page.locator('#cover').evaluate(el=>el.style.display='block');
  const askCount=asks.length,stopping=h.act({kind:'fill',ref:h.ref('Benchmark input'),text:'must not appear'}).then(value=>({value}),error=>({error}));
  await eventual(()=>asks.length>askCount);await adapter.stop();const stopped=await stopping;
  assert.ok(stopped.error||stopped.value.outcome!=='succeeded');assert.equal(await h.page.locator('#input').inputValue(),'');
  await assert.rejects(h.observe());
  passed.push('The real Edge extension Stop blocks pending covered input and subsequent reads on the revoked lease');

  await adapter.allow();h=await adapter.prepare({},'edge-handoff');assert.equal((await h.act({kind:'fill',ref:h.ref('Benchmark input'),text:'new approved lease'})).outcome,'succeeded');
  await adapter.tool('browser_handoff',{leaseId:h.lease.id});await assert.rejects(h.observe());assert.equal(h.page.isClosed(),false);
  passed.push('Explicit Edge re-consent establishes fresh authority; handoff releases it and leaves the page open');
  const events=Array.from({length:session.seq},(_,i)=>session.eventAt(i)).filter(Boolean),asked=events.filter(e=>e.type==='approval/asked'),decided=events.filter(e=>e.type==='approval/decided');
  assert.equal(asked.length,decided.length);for(const ask of asked)assert.equal(decided.filter(d=>d.data.id===ask.data.id).length,1);
  assert.deepEqual(await coreFingerprint(),coreBefore);
  passed.push('All approval requests have one audited decision and runtime-core source hashes remain unchanged during Edge verification');
  const versions={browserVersion:adapter.browserVersion,userAgentEdgeVersion:/Edg\/([^ ]+)/.exec(userAgent)[1],dshVersion:adapter.dshVersion};
  const cleanup=await adapter.close();adapter=undefined;assert.equal(cleanup.complete,true);
  const report={checkedAt:new Date().toISOString(),...versions,passed,casesPassed,pageWindows:windows,approvalAudit:{asked:asked.length,decided:decided.length},coreSourceSha256:coreBefore,cleanup,
    scope:'Early P2 Edge compatibility gate: installed Edge executable with a fresh temporary headless profile, production Edge bundle/native host/Broker and real DSH ToolRuntime/ApprovalService with controlled answers. No runtime-core edits, regular user profile, LLM, performance baseline, store distribution or full P5 Edge certification.'};
  await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright/edge-native-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(adapter){const cleanup=await adapter.close();assert.equal(cleanup.complete,true);}}
