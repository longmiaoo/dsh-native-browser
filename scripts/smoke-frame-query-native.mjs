import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';
import { applyObservationUpdate } from '../dist/packages/contracts/src/observations.js';
const hostRoot=process.argv[2],executablePath=process.env.DSH_CHROME_TEST_EXECUTABLE,brand=process.env.DSH_TEST_BROWSER_BRAND??'chrome';
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_CHROME_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(120000),passed=[];
// Only fixture setup and independent DOM/event oracles use Playwright. Query and
// click always traverse actual DSH/Broker/Native Host/MV3, never direct test CDP.
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{position:absolute;width:700px;height:600px;left:80px;top:80px}#other{left:900px;width:200px}#items{position:absolute;top:250px}#target{position:absolute;top:40px;left:40px}#feedback{position:absolute;top:100px}#nested{top:430px;left:430px;width:200px;height:100px}</style><main id="area"></main><script>
globalThis.hits=[];const area=document.querySelector('#area');
if(location.pathname==='/')area.innerHTML='<button>精确查找目标</button><iframe id="child" src="/child"></iframe><iframe id="other" src="/other"></iframe>';
else if(location.pathname==='/child'){
 const items=document.createElement('section');items.id='items';area.append(items);
 for(let i=0;i<220;i++){const b=document.createElement('button');b.textContent='Default control '+i;items.append(b);}
 for(let i=0;i<20;i++){const b=document.createElement('button');b.className='duplicate';b.textContent='重复候选';items.append(b);}
 const b=document.createElement('button');b.id='target';b.textContent='精确查找目标';items.append(b);
 const p=document.createElement('p');p.id='feedback';p.textContent='Waiting';area.append(p);
 b.addEventListener('click',event=>{hits.push({trusted:event.isTrusted});p.textContent='Query click completed';});
 const nested=document.createElement('iframe');nested.id='nested';nested.src=location.protocol+'//localhost:'+location.port+'/nested';area.append(nested);
}else area.innerHTML='<button>精确查找目标</button><p>foreign text must not leak</p>';
</script>`;
let adapter;
try{
 adapter=await nativeAdapter({hostRoot,executablePath,signal,brand,html});let h=await adapter.prepare({},'frame-query');
 await h.page.waitForFunction(()=>document.querySelector('#child')?.contentDocument?.querySelector('#target'));
 for(const child of h.page.frames())await child.waitForLoadState('load');
 const discover=()=>adapter.tool('browser_frames',{leaseId:h.lease.id});
 const inventory=await discover();assert.equal(inventory.frames.length,4);
 const main=inventory.frames.find(f=>f.isMain),foreign=inventory.frames.find(f=>f.originRelation==='cross-origin');assert.ok(foreign);
 const selected=inventory.frames.find(f=>f.id===foreign.parentId);assert.ok(selected);assert.equal(selected.parentId,main.id);
 const frame={frameId:selected.id,documentEpoch:selected.documentEpoch},query={name:'精确查找目标',role:'button'};
 const childPage=h.page.frames().find(f=>new URL(f.url()).pathname==='/child');assert.ok(childPage);
 const lookup=(query,extra={})=>h.observe({frame,query,...extra});
 const initial=await h.observe({frame});assert.equal(initial.truncated,true);assert.equal(initial.nodes.some(n=>n.name===query.name),false);
 const found=await lookup(query);assert.equal(found.nodes.length,1,JSON.stringify(found));assert.equal(found.nodes[0].name,query.name);
 assert.deepEqual(found.scope,{kind:'query',frameId:frame.frameId,query});assert.equal(found.text.length,0);assert.doesNotMatch(JSON.stringify(found),/foreign text|sessionId|contextUniqueId|backendDOMNodeId/);
 passed.push('Exact child query finds an actionable control omitted from the 220-control default view, excluding same-name root/sibling/foreign-descendant controls');

 const act={requestId:'query-click',leaseId:h.lease.id,documentEpoch:frame.documentEpoch,frame,action:{kind:'click',ref:found.nodes[0].id,expected:{kind:'text',text:'Query click completed'}}};
 const result=await adapter.tool('browser_act',act);assert.equal(result.outcome,'succeeded',JSON.stringify(result));assert.deepEqual(await childPage.evaluate(()=>hits),[{trusted:true}]);
 assert.deepEqual(await adapter.tool('browser_act',act),result);assert.equal(await childPage.evaluate(()=>hits.length),1);
 passed.push('A source-query ref drives the formal child-click path with one trusted event, child text verification and no replay');

 const duplicates={name:'重复候选',role:'button'},before=await lookup(duplicates);assert.equal(before.nodes.length,20);assert.equal(new Set(before.nodes.map(n=>n.id)).size,20);
 await childPage.locator('.duplicate').first().evaluate(el=>el.disabled=true);
 const delta=await lookup(duplicates,{cursor:before.cursor});assert.equal(delta.format,'delta');assert.equal(applyObservationUpdate(before,delta).nodes.filter(n=>n.disabled).length,1);
 passed.push('Twenty same-name child candidates remain distinct and a changed state reconstructs through the exact query delta base');
 assert.equal((await lookup(query,{cursor:before.cursor})).resyncRequired,true);
 assert.equal((await lookup(query,{cursor:initial.cursor})).resyncRequired,true);
 const rootQuery=await h.observe({query});assert.equal((await lookup(query,{cursor:rootQuery.cursor})).resyncRequired,true);
 assert.equal((await lookup({name:'精确查找',role:'button'})).nodes.length,0);
 assert.equal((await lookup({name:query.name,role:'textbox'})).nodes.length,0);
 passed.push('Root/frame/query cursor scopes never mix; name matching is literal and role constraints are preserved');

 const old=(await lookup(query)).nodes[0].id;await childPage.locator('#target').evaluate(el=>el.replaceWith(el.cloneNode(true)));
 const replacement=await lookup(query);assert.equal(replacement.nodes.length,1);assert.notEqual(replacement.nodes[0].id,old);
 const stale=await adapter.tool('browser_act',{...act,requestId:'query-old-node',action:{kind:'click',ref:old}});assert.equal(stale.dispatch,'notDispatched');assert.equal(await childPage.evaluate(()=>hits.length),1);
 passed.push('A same-name replacement gets a fresh child ref and the previous ref cannot dispatch');
 await assert.rejects(h.observe({frame:{frameId:foreign.id,documentEpoch:foreign.documentEpoch},query}));
 await assert.rejects(lookup(query,{rootRef:'unobserved-child-root'}));
 passed.push('Foreign frame authority and unobserved child query roots fail closed');
 await childPage.goto(new URL('/child?renewed',h.page.url()).href);await assert.rejects(lookup(query));
 const next=(await discover()).frames.find(f=>f.id===frame.frameId);assert.notEqual(next.documentEpoch,frame.documentEpoch);
 assert.equal((await h.observe({frame:{frameId:next.id,documentEpoch:next.documentEpoch},query})).nodes.length,1);
 passed.push('Child document reload invalidates old queries while a freshly discovered epoch permits a new lookup');
 await adapter.stop();await assert.rejects(lookup(query));await adapter.allow();h=await adapter.prepare({},'frame-query-renewed');await assert.rejects(lookup(query));
 passed.push('Actual popup Stop and later consent never revive an old frame query identity');
 const versions={browserVersion:adapter.browserVersion,dshVersion:adapter.dshVersion},cleanup=await adapter.close();adapter=undefined;assert.equal(cleanup.complete,true);
 const files=['scripts/smoke-frame-query-native.mjs','packages/contracts/src/index.ts','packages/contracts/src/validation.ts','packages/provider-chromium/src/frame-query.ts','packages/provider-chromium/src/frame-query-functions.ts','packages/provider-chromium/src/frame-sessions.ts','packages/provider-chromium/src/provider.ts','packages/runtime-core/src/runtime.ts','packages/dsh-adapter/src/index.ts','dist/extension/'+brand+'/background.js'];
 const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
 const report={checkedAt:new Date().toISOString(),brand,...versions,passed,cleanup,hashes,
  scope:'Real DSH tools -> Broker -> browser-started Native Host -> MV3 in isolated loopback-only profiles; controlled test approval service, no LLM/human approval UI/signed-in pages. Exact same-origin child document query and existing same-process click, not cross-origin access, child subtree/paging or Codex parity.'};
 await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright',brand+'-frame-query-native-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(adapter)assert.equal((await adapter.close()).complete,true);}
