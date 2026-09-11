import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';

const hostRoot=process.argv[2],executablePath=process.env.DSH_CHROME_TEST_EXECUTABLE;
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_CHROME_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(120000);
let adapter,session,setPolicy,handler=async()=> 'allowed-once';const requests=[],passed=[];
const eventual=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected isolated batch event');};
try {
  adapter=await nativeAdapter({hostRoot,executablePath,signal,html:await readFile(path.join(root,'test/fixtures/benchmark.html')),
    configureApproval:async({ctx,session:current,load})=>{
      session=current;const {ApprovalService,setApprovalPolicy}=await load('@deepseek-ai/dsh-user-approval');setPolicy=policy=>setApprovalPolicy(session,policy);
      await ctx.plugin(ApprovalService,{policy:'ask'});
      ctx.on('approval/request',req=>{requests.push(req);return handler(req);});
    }});
  const prepare=()=>adapter.prepare({},'batch-native');
  const batch=(h,id,steps,timeoutMs=3000)=>({requestId:id,leaseId:h.lease.id,documentEpoch:h.snapshot.documentEpoch,steps,timeoutMs});
  const stepFill=(h,text)=>({action:{kind:'fill',ref:h.ref('Benchmark input'),text}});
  const stepSubmit=h=>({action:{kind:'press',ref:h.ref('Benchmark input'),key:'Enter',expected:{kind:'text',text:'Form submitted'}}});
  const execute=request=>adapter.tool('browser_batch',request);
  const batchAsks=()=>requests.filter(r=>r.toolName==='browser_batch');
  const audit=()=>Array.from({length:session.seq},(_,i)=>session.eventAt(i)).filter(Boolean);

  let h=await prepare();let before=batchAsks().length;
  const good=batch(h,'batch-native-success',[stepFill(h,'批处理中文🙂'),stepSubmit(h)]);
  const result=await execute(good);assert.equal(result.outcome,'succeeded');assert.equal(result.steps.length,2);
  assert.equal(await h.page.locator('#input').inputValue(),'批处理中文🙂');assert.equal(await h.page.evaluate(()=>bench.counts.submit),1);
  assert.equal(batchAsks().length-before,2);assert.ok(batchAsks().slice(before).every(r=>r.callId===batchAsks()[before].callId));
  assert.deepEqual(await execute(good),result);assert.equal(batchAsks().length-before,2);assert.equal(await h.page.evaluate(()=>bench.counts.submit),1);
  assert.ok((await h.page.evaluate(()=>bench.events.filter(e=>e.type==='input'||e.type==='keydown'))).every(e=>e.trusted));
  passed.push('One real DSH batch performs trusted Chinese fill and Enter with two public ApprovalService grants and whole-batch deduplication');

  h=await prepare();before=batchAsks().length;
  handler=async req=>req.toolName==='browser_batch'&&req.reason.includes('step 2/')?'rejected':'allowed-once';
  const denied=batch(h,'batch-native-denied',[stepFill(h,'first retained'),stepSubmit(h),stepFill(h,'never')]);
  const partial=await execute(denied);assert.equal(partial.code,'POLICY_DENIED');assert.equal(partial.outcome,'failed');
  assert.deepEqual(partial.steps.map(s=>s.status),['attempted','attempted','notRun']);assert.equal(partial.observation,undefined);
  assert.equal(await h.page.locator('#input').inputValue(),'first retained');assert.equal(await h.page.evaluate(()=>bench.counts.submit),0);
  handler=async()=> 'allowed-once';assert.deepEqual(await execute(denied),partial);assert.equal(batchAsks().length-before,2);
  passed.push('Rejecting step two preserves the first side effect, skips later steps and cannot resume them by replaying the batch');

  h=await prepare();before=batchAsks().length;setPolicy('never');
  const never=await execute(batch(h,'batch-policy-never',[stepFill(h,'never')]));assert.equal(never.code,'POLICY_DENIED');
  assert.equal(await h.page.locator('#input').inputValue(),'');assert.equal(batchAsks().length,before);setPolicy('ask');
  passed.push('Real Session approval policy never rejects the batch step before any answerer or browser input');

  h=await prepare();before=batchAsks().length;
  const uncertain=batch(h,'batch-native-unknown',[{action:{kind:'click',ref:h.ref('Delayed feedback'),expected:{kind:'text',text:'will never appear'}},timeoutMs:180},stepFill(h,'must not run')]);
  const unknown=await execute(uncertain);assert.equal(unknown.outcome,'unknown');assert.equal(unknown.code,'DEADLINE_EXCEEDED');assert.equal(unknown.steps[1].status,'notRun');
  assert.equal(await h.page.evaluate(()=>bench.counts.delayed),1);assert.equal(await h.page.locator('#input').inputValue(),'');
  assert.deepEqual(await execute(uncertain),unknown);assert.equal(await h.page.evaluate(()=>bench.counts.delayed),1);assert.equal(batchAsks().length-before,1);
  passed.push('A real post-dispatch timeout stops the batch and never repeats the click or approves a later step');

  h=await prepare();let finish,entered=false;
  handler=req=>req.toolName==='browser_batch'&&req.reason.includes('step 2/')?new Promise(resolve=>{finish=resolve;entered=true;}):Promise.resolve('allowed-once');
  const stopRequest=batch(h,'batch-native-stop',[stepFill(h,'before Stop'),stepSubmit(h)]);
  const stopping=execute(stopRequest);await eventual(()=>entered);await adapter.stop();finish('allowed-once');
  const stopped=await stopping;assert.notEqual(stopped.outcome,'succeeded');assert.equal(await h.page.evaluate(()=>bench.counts.submit),0);
  assert.equal(await h.page.locator('#input').inputValue(),'before Stop');handler=async()=> 'allowed-once';
  assert.ok(audit().some(e=>e.type==='approval/decided'&&e.data.outcome==='cancelled'));
  passed.push('Actual extension Stop cancels a pending real ApprovalService question; a late grant cannot submit the next step');

  await adapter.allow();h=await prepare();entered=false;
  handler=req=>req.toolName==='browser_batch'&&req.reason.includes('step 2/')?new Promise(resolve=>{finish=resolve;entered=true;}):Promise.resolve('allowed-once');
  const crashRequest=batch(h,'batch-native-crash',[stepFill(h,'before crash'),stepSubmit(h)]);
  const crashing=execute(crashRequest).then(value=>({value}),error=>({error}));await eventual(()=>entered);
  const restart=await adapter.crashAndRestartBroker();assert.equal(restart.recoveredSocket,true);finish('allowed-once');
  const crashed=await crashing;assert.ok(crashed.error||crashed.value.outcome!=='succeeded');
  handler=async()=> 'allowed-once';before=batchAsks().length;
  const recovered=await execute(crashRequest);assert.equal(recovered.code,'RECOVERY_REQUIRED');assert.equal(recovered.recovery.state,'reserved');
  assert.equal(recovered.steps,undefined);assert.equal(recovered.totalSteps,2);assert.equal(batchAsks().length,before);
  assert.equal(await h.page.locator('#input').inputValue(),'before crash');assert.equal(await h.page.evaluate(()=>bench.counts.submit),0);
  passed.push('SIGKILL after the first side effect recovers the outer durable intent without restoring control, asking again or resuming the second step');

  const events=audit(),asks=events.filter(e=>e.type==='approval/asked'),decisions=events.filter(e=>e.type==='approval/decided');
  assert.equal(asks.length,decisions.length);assert.equal(new Set(asks.map(e=>e.data.id)).size,asks.length);
  for(const ask of asks)assert.equal(decisions.filter(d=>d.data.id===ask.data.id).length,1);
  assert.equal(JSON.stringify(asks).includes('批处理中文'),false);
  passed.push('Every real approval ask has exactly one matching audited decision; reasons do not duplicate entered text');
  const report={checkedAt:new Date().toISOString(),browserVersion:adapter.browserVersion,dshVersion:adapter.dshVersion,passed,
    approvalAudit:{asked:asks.length,decided:decisions.length},scope:'Real DSH ToolRuntime + public ApprovalService policy/audit with controlled local answerers -> Broker -> Chrome-started Native Host -> MV3 -> isolated CFT. No LLM, actual human UI approval or signed-in user pages.'};
  await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright/batch-native-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {if(adapter){const cleanup=await adapter.close();assert.equal(cleanup.complete,true,JSON.stringify(cleanup));}}
