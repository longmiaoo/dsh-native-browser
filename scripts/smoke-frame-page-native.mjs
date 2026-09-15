import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';
const hostRoot=process.argv[2],executablePath=process.env.DSH_CHROME_TEST_EXECUTABLE,brand=process.env.DSH_TEST_BROWSER_BRAND??'chrome';
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_CHROME_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(300000),passed=[];
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{position:absolute;left:70px;top:70px;width:700px;height:500px}#other{left:900px}button{display:block}#last{position:fixed;top:20px;left:25px;z-index:10}#nested{left:500px;top:350px;width:100px;height:100px}</style><main id="area"></main><script>
globalThis.hits=[];const area=document.querySelector('#area');
if(location.pathname==='/')area.innerHTML='<section aria-label="Window region"><button>Root only</button></section><iframe id="child" src="/child"></iframe><iframe id="other" src="/other"></iframe>';
else if(location.pathname==='/child'){
 area.innerHTML='<section id="region" aria-label="Window region"></section><p id="feedback">Waiting</p><button>Sibling only</button>';
 const region=document.querySelector('#region');for(let i=0;i<4000;i++){const b=document.createElement('button');b.textContent='Item '+i;b.dataset.index=i;if(i===3999)b.id='last';region.append(b);}
 region.addEventListener('click',e=>{if(e.target.id==='last'){hits.push(e.isTrusted);document.querySelector('#feedback').textContent='Last page clicked';}});
 const nested=document.createElement('iframe');nested.id='nested';nested.src=location.protocol+'//localhost:'+location.port+'/nested';area.append(nested);
}else area.innerHTML='<section aria-label="Window region"><button>Foreign only</button></section>';
</script>`;
let adapter;
try{
 adapter=await nativeAdapter({hostRoot,executablePath,signal,brand,html});let h=await adapter.prepare({},'frame-page');
 await h.page.waitForFunction(()=>document.querySelector('#child')?.contentDocument?.querySelector('#last'));
 for(const f of h.page.frames())await f.waitForLoadState('load');
 let inventory=await adapter.tool('browser_frames',{leaseId:h.lease.id});
 const foreign=inventory.frames.find(f=>f.originRelation==='cross-origin');assert.ok(foreign);
 const selected=inventory.frames.find(f=>f.id===foreign.parentId);let frame={frameId:selected.id,documentEpoch:selected.documentEpoch};
 const childPage=h.page.frames().find(f=>new URL(f.url()).pathname==='/child');
 const discover=async()=>{const result=await h.observe({frame,query:{name:'Window region',role:'region'}});assert.equal(result.nodes.length,1);return result.nodes[0].id;};
 let rootRef=await discover();const read=(extra={})=>adapter.tool('browser_read_page',{leaseId:h.lease.id,frame,rootRef,...extra});
 const readWhole=(extra={})=>adapter.tool('browser_read_page',{leaseId:h.lease.id,frame,...extra});
 const queryBase=await h.observe({frame,query:{name:'Window region',role:'region'}});
 const first=await read();assert.deepEqual(first.scope,{kind:'subtree',frameId:frame.frameId,rootRef});assert.equal(first.documentEpoch,frame.documentEpoch);
 assert.equal(first.format,undefined);assert.equal(first.cursor,undefined);assert.ok(first.page.continuation);
 assert.equal((await h.observe({frame,query:{name:'Window region',role:'region'},cursor:queryBase.cursor})).resyncRequired,false);
 await assert.rejects(adapter.tool('browser_read_page',{leaseId:h.lease.id,continuation:first.page.continuation}));
 await assert.rejects(readWhole({continuation:first.page.continuation}));
 await assert.rejects(read({frame:{frameId:foreign.id,documentEpoch:foreign.documentEpoch},rootRef:undefined}));
 passed.push('Public frame-page schema and exact child/root scopes preserve query baselines and reject root/foreign token widening');
 const names=[],ids=new Set();let page=first,windows=0,maxBytes=0,last;
 while(true){windows++;maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(page)));assert.equal(page.page.index,windows-1);assert.equal(page.page.incomplete,false);
  assert.ok(page.nodes.length<=100);for(const n of page.nodes.filter(n=>n.role==='button')){assert.equal(ids.has(n.id),false);ids.add(n.id);names.push(n.name);if(n.name==='Item 3999')last=n;}
  assert.ok(!page.text.includes('Foreign only'));assert.ok(!page.nodes.some(n=>['Sibling only','Foreign only'].includes(n.name)));
  const next=page.page.continuation;if(!next){assert.equal(page.truncated,false);break;}page=await read({continuation:next});
 }
 assert.deepEqual(names,Array.from({length:4000},(_,i)=>'Item '+i));assert.ok(maxBytes<40*1024);assert.ok(last);
 passed.push('All 4000 child-region controls are read in order without duplicate refs across bounded live windows, retaining the region beyond the 2048-ref LRU');
 const action={requestId:'last-child-page',leaseId:h.lease.id,documentEpoch:frame.documentEpoch,frame,action:{kind:'click',ref:last.id,expected:{kind:'text',text:'Last page clicked'}}};
 let clicked;try{clicked=await adapter.tool('browser_act',action);}catch(error){
  // Only owned-fixture numeric/boolean diagnostics, never arbitrary Host messages.
  console.error('Last-page fixture diagnostics',await childPage.evaluate(()=>({hits,feedback:document.querySelector('#feedback').textContent==='Last page clicked',
   x:document.querySelector('#last').getBoundingClientRect().x,y:document.querySelector('#last').getBoundingClientRect().y})));throw error;
 }
 assert.equal(clicked.outcome,'succeeded');await adapter.tool('browser_act',action);assert.deepEqual(await childPage.evaluate(()=>hits),[true]);
 passed.push('The visible final-page child ref is usable for an authorized trusted click with text verification and no replay; no automatic scrolling is claimed');
 rootRef=await discover();const fresh=await read(),token=fresh.page.continuation;
 await childPage.locator('button[data-index="70"]').evaluate(el=>el.textContent='Fresh item 70');
 const next=await read({continuation:token});assert.ok(next.nodes.some(n=>n.name==='Fresh item 70'));await assert.rejects(read({continuation:token}));
 await childPage.locator('#region').evaluate(el=>el.prepend(el.lastElementChild));await assert.rejects(read({continuation:next.page.continuation}));
 passed.push('Subsequent windows refresh unvisited content; consumed tokens and reordered active child lists fail closed');
 const beforeReplace=await read();await childPage.locator('#region').evaluate(el=>el.replaceWith(el.cloneNode(true)));
 await assert.rejects(read({continuation:beforeReplace.page.continuation}));const oldRoot=rootRef;rootRef=await discover();assert.notEqual(rootRef,oldRoot);
 const beforeMove=await read();await childPage.locator('#region').evaluate(el=>{const doc=parent.document.querySelector('#other').contentDocument;doc.body.append(doc.adoptNode(el));});
 await assert.rejects(read({continuation:beforeMove.page.continuation}));
 passed.push('Same-name root replacement and adoption into a same-origin sibling document invalidate existing region continuations');
 // Whole-child traversal is also explicit and bounded, never an implicit child fallback.
 const whole=await readWhole();assert.equal(whole.scope.kind,'frame');assert.ok(!whole.nodes.some(n=>n.name==='Foreign only'));assert.equal(whole.page.incomplete,true);
 passed.push('Whole-child windows keep their own scope and mark nested-frame omissions as incomplete');
 await childPage.goto(new URL('/child',childPage.url()).href);await assert.rejects(readWhole({continuation:beforeMove.page.continuation}));
 inventory=await adapter.tool('browser_frames',{leaseId:h.lease.id});const updated=inventory.frames.find(f=>f.id===frame.frameId);assert.ok(updated);frame={frameId:updated.id,documentEpoch:updated.documentEpoch};
 rootRef=await discover();const beforeStop=await read();await adapter.stop();await assert.rejects(read({continuation:beforeStop.page.continuation}));
 await adapter.allow();h=await adapter.prepare({},'frame-page-renewed');await assert.rejects(read({continuation:beforeStop.page.continuation}));
 passed.push('Child navigation, actual popup Stop and reconsent cannot revive old documents, refs or page tokens');
 const versions={browserVersion:adapter.browserVersion,dshVersion:adapter.dshVersion},cleanup=await adapter.close();adapter=undefined;assert.equal(cleanup.complete,true);
 const files=['scripts/smoke-frame-page-native.mjs','packages/provider-chromium/src/ax-pager.ts','packages/provider-chromium/src/frame-page.ts','packages/provider-chromium/src/frame-node-scope.ts','packages/provider-chromium/src/frame-sessions.ts','packages/provider-chromium/src/frame-text.ts','packages/provider-chromium/src/provider.ts','packages/extension-core/src/background.ts','packages/runtime-core/src/runtime.ts','packages/contracts/src/validation.ts','packages/contracts/src/wire.ts','packages/dsh-adapter/src/index.ts','dist/extension/'+brand+'/background.js'];
 const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
 const report={checkedAt:new Date().toISOString(),brand,...versions,controls:names.length,windows,maxBytes,passed,cleanup,hashes,
  scope:'Actual DSH/Broker/Native Host/MV3 with owned loopback fixtures, fresh profiles and controlled approvals. No daily accounts, LLM, visual fallback, child autoscroll, cross-origin authorization or Codex parity claim.'};
 await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright',brand+'-frame-page-native-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(adapter)assert.equal((await adapter.close()).complete,true);}
