import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeAdapter } from './benchmark/native-adapter.mjs';

const hostRoot=process.argv[2],executablePath=process.env.DSH_CHROME_TEST_EXECUTABLE;
if(!hostRoot||!executablePath)throw Error('Pass installed DSH directory and set DSH_CHROME_TEST_EXECUTABLE');
const root=path.resolve(import.meta.dirname,'..'),signal=AbortSignal.timeout(180000),passed=[];
let adapter;
try {
  adapter=await nativeAdapter({hostRoot,executablePath,signal,html:await readFile(path.join(root,'test/fixtures/benchmark.html'))});
  let h=await adapter.prepare({},'page-native');
  await h.page.evaluate(()=>{
    const region=document.createElement('section');region.id='page-region';region.setAttribute('role','region');region.setAttribute('aria-label','Pagination fixture');
    for(let i=0;i<4000;i++){const button=document.createElement('button');button.textContent='Page item '+i;button.dataset.pageItem=String(i);
      button.addEventListener('click',e=>{window.pageClick={index:i,trusted:e.isTrusted};history.replaceState(null,'','#page-last');});region.append(button);}
    document.body.append(region);
  });
  const find=await h.observe({query:{name:'Pagination fixture',role:'region'}}),region=find.nodes.find(n=>n.name==='Pagination fixture');assert.ok(region);
  const read=(options={})=>adapter.tool('browser_read_page',{leaseId:h.lease.id,...options});
  const items=[],ids=new Set();let continuation,index=0,maxBytes=0,last;
  do {
    const window=await read({rootRef:region.id,...(continuation?{continuation}:{})}).catch(error=>{throw new Error('Page window failed at index '+index,{cause:error});});
    assert.equal(window.page.index,index++);assert.equal(window.page.incomplete,false);assert.equal(window.cursor,undefined);
    assert.deepEqual(window.scope,{kind:'subtree',rootRef:region.id});maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(window)));
    for(const node of window.nodes.filter(n=>n.role==='button')){assert.equal(ids.has(node.id),false);ids.add(node.id);items.push(node.name);last=node;}
    continuation=window.page.continuation;
    if(index===1){await assert.rejects(read({continuation}));} // Cannot widen a scoped token to the document.
  }while(continuation);
  assert.deepEqual(items,Array.from({length:4000},(_,i)=>'Page item '+i));assert.ok(maxBytes<40*1024);
  passed.push('All 4000 current-DOM controls are read in ordered bounded native windows without duplicates, delta cursors or scope widening');
  const result=await h.act({kind:'click',ref:last.id,expected:{kind:'url',url:new URL('#page-last',h.page.url()).href}});
  assert.equal(result.outcome,'succeeded');assert.deepEqual(await h.page.evaluate(()=>window.pageClick),{index:3999,trusted:true});
  passed.push('A last-window reference receives one verified trusted click through real DSH/Native/MV3, without re-discovering by an invented selector');

  // A fresh subtree token observes changed content only in later windows.
  const start=await read({rootRef:region.id});assert.ok(start.page.continuation);
  const token=start.page.continuation;
  await h.page.locator('[data-page-item="70"]').evaluate(el=>el.textContent='Changed upcoming item');
  const second=await read({rootRef:region.id,continuation:token});assert.ok(second.nodes.some(n=>n.name==='Changed upcoming item'));
  await assert.rejects(read({rootRef:region.id,continuation:token}));
  passed.push('Continuation re-reads upcoming content and refuses single-use token replay');
  const changed=await read({rootRef:region.id});
  await h.page.locator('#page-region').evaluate(el=>el.prepend(el.lastElementChild));
  await assert.rejects(read({rootRef:region.id,continuation:changed.page.continuation}));
  passed.push('Changing the active sibling order rejects the continuation instead of shifting offsets onto a different control');

  const beforeReplace=await read({rootRef:region.id});
  await h.page.locator('#page-region').evaluate(el=>el.replaceWith(el.cloneNode(true)));
  await assert.rejects(read({rootRef:region.id,continuation:beforeReplace.page.continuation}));
  passed.push('A same-name replacement region cannot inherit the original continuation or root reference');

  h=await adapter.prepare({},'page-stop');
  await h.page.evaluate(()=>{for(let i=0;i<180;i++){const b=document.createElement('button');b.textContent='Stop page '+i;document.body.append(b);}});
  const beforeStop=await read();assert.ok(beforeStop.page.continuation);await adapter.stop();
  await assert.rejects(read({continuation:beforeStop.page.continuation}));
  await adapter.allow();h=await adapter.prepare({},'page-after-stop');
  await assert.rejects(read({continuation:beforeStop.page.continuation}));
  passed.push('Actual extension Stop blocks continuation, and a newly approved lease cannot revive the old token');

  await h.page.evaluate(()=>{for(let i=0;i<180;i++){const b=document.createElement('button');b.textContent='Navigation page '+i;document.body.append(b);}});
  const beforeNavigation=await read();await h.page.reload();
  await assert.rejects(read({continuation:beforeNavigation.page.continuation}));
  passed.push('Same-origin full navigation invalidates document-bound continuation');
  const versions={browserVersion:adapter.browserVersion,dshVersion:adapter.dshVersion};
  const cleanup=await adapter.close();adapter=undefined;assert.equal(cleanup.complete,true);
  const report={checkedAt:new Date().toISOString(),...versions,passed,windows:index,controls:items.length,maxWindowBytes:maxBytes,cleanup,
    scope:'Real DSH ToolRuntime -> Broker -> Chrome-started Native Host -> MV3 -> isolated CFT. Loopback-only fixtures; controlled approval, no LLM/user account/atomic snapshot or latency claim.'};
  await mkdir(path.join(root,'output/playwright'),{recursive:true});await writeFile(path.join(root,'output/playwright/page-native-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{if(adapter){const cleanup=await adapter.close();assert.equal(cleanup.complete,true);}}
