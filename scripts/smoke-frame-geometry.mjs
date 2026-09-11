import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {verifyFramePoint,parentPointToFrame,frameOwnerHitFunction,cdpQuadToRootViewport} from '../dist/packages/provider-chromium/src/frame-geometry.js';
import {FrameSessions} from '../dist/packages/provider-chromium/src/frame-sessions.js';
import {readFrameGeometry} from '../dist/packages/provider-chromium/src/frame-geometry-read.js';
import {frameBoundOwnerHitFunction} from '../dist/packages/provider-chromium/src/frame-geometry-functions.js';

const brand=process.env.DSH_TEST_BROWSER_BRAND??'chrome';
const sourceMode=process.argv.includes('--source');
assert.ok(['chrome','edge'].includes(brand),'Unsupported test browser brand');
const fingerprint=async()=>Object.fromEntries(await Promise.all([
  'packages/provider-chromium/src/frame-geometry.ts','packages/provider-chromium/src/actionability.ts',
  'dist/packages/provider-chromium/src/frame-geometry.js','dist/packages/provider-chromium/src/actionability.js',
  'scripts/smoke-frame-geometry.mjs',
  ...(sourceMode?['frame-sessions','frame-read','frame-geometry-read','frame-geometry-functions'].flatMap(name=>[
    'packages/provider-chromium/src/'+name+'.ts','dist/packages/provider-chromium/src/'+name+'.js']):[])
].map(async file=>[file,createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex')])));
const sourceHashes=await fingerprint(),samples=[];

const pages={
  '/':`<!doctype html><style>body{margin:0;height:2000px}#outer{position:absolute;left:180px;top:420px;width:600px;height:420px;border:13px solid #357;padding:9px;transform-origin:70px 80px}</style><iframe id="outer" src="/parent"></iframe>`,
  '/parent':`<!doctype html><style>body{margin:0;height:1600px}#inner{position:absolute;left:80px;top:410px;width:250px;height:160px;border:11px solid #573;padding:7px;transform-origin:19px 28px}</style><iframe id="inner" src="/leaf"></iframe>`,
  '/leaf':`<!doctype html><style>body{margin:0}button{position:absolute;left:70px;top:50px;width:80px;height:40px}</style><button id="target">目标</button><script>globalThis.hits=[];globalThis.allClicks=[];document.addEventListener('click',e=>allClicks.push({tag:e.target.tagName,x:e.clientX,y:e.clientY}));document.querySelector('button').addEventListener('click',e=>hits.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY}));</script>`
};
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(pages[new URL(req.url,'http://local').pathname]??'');});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,passed=[],signal=AbortSignal.timeout(120000);let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.DSH_CHROME_TEST_EXECUTABLE?{executablePath:process.env.DSH_CHROME_TEST_EXECUTABLE}:{channel:'chrome'})});
  for(const scenario of [
    {name:'borders-padding-and-nested-scroll',dpr:1,outer:'none',inner:'none'},
    {name:'rotated-nonuniform-scaled-ancestors',dpr:1,outer:'rotate(11deg) scale(.92,.85)',inner:'rotate(-9deg) scale(.85,1.1)'},
    {name:'perspective-and-rotation',dpr:1,outer:'perspective(900px) rotateY(24deg) rotateZ(6deg)',inner:'perspective(500px) rotateX(15deg)'},
    {name:'high-dpr',dpr:2,outer:'rotate(7deg) scale(.8)',inner:'skewX(10deg)'},
    {name:'high-dpr-and-css-zoom',dpr:2,outer:'rotate(7deg) scale(.8)',inner:'skewX(10deg)',zoom:1.15},
    {name:'nested-css-zoom',dpr:1.5,outer:'rotate(7deg) scale(.8)',inner:'skewX(10deg)',zoom:1.1,parentZoom:1.15},
    {name:'zoom-out-and-reflection',dpr:1.5,outer:'scaleX(-1)',inner:'rotate(9deg)',zoom:.8,parentZoom:.9}
  ]){
    const context=await browser.newContext({viewport:{width:1280,height:1000},deviceScaleFactor:scenario.dpr});
    try{
      const page=await context.newPage();await page.goto(origin);const parent=page.frames().find(f=>f.url()===origin+'/parent'),leaf=page.frames().find(f=>f.url()===origin+'/leaf');
      assert.ok(parent&&leaf);await leaf.waitForLoadState('load');
      await page.locator('#outer').evaluate((el,options)=>{el.style.transform=options.outer;if(options.zoom)document.body.style.zoom=String(options.zoom);},scenario);
      await parent.locator('#inner').evaluate((el,options)=>{el.style.transform=options.inner;if(options.parentZoom)document.body.style.zoom=String(options.parentZoom);},scenario);
      await page.evaluate(()=>scrollTo(0,200));await parent.evaluate(()=>scrollTo(0,330));
      const session=await context.newCDPSession(page),tree=(await session.send('Page.getFrameTree')).frameTree;
      const rootFrame=tree.frame,parentFrame=tree.childFrames[0].frame,leafFrame=tree.childFrames[0].childFrames[0].frame;
      let graph,sourceRequest,measureBound,sourceMutation;const sourceObjects=[],sourceCommands=[];
      if(sourceMode){
        graph=new FrameSessions(async(sessionId,method,params,currentSignal,gate)=>{
          assert.equal(sessionId,'');await sourceMutation?.(method,params);currentSignal.throwIfAborted();gate?.();
          sourceCommands.push(method);const result=await session.send(method,params);
          if(method==='DOM.resolveNode')sourceObjects.push(result.object.objectId);return result;
        });
        for(const name of ['Runtime.executionContextCreated','Runtime.executionContextDestroyed','Runtime.executionContextsCleared',
          'Page.frameAttached','Page.frameDetached','Page.frameNavigated','Target.attachedToTarget','Target.detachedFromTarget'])
          session.on(name,params=>graph.event('',name,params));
        await session.send('Page.enable');await graph.start(signal);
        const inventory=await graph.snapshot(signal),frame=inventory.frames.find(f=>f.frameId===leafFrame.id);assert.ok(frame.context.uniqueId);
        const ax=await session.send('Accessibility.getFullAXTree',{frameId:leafFrame.id});
        const target=ax.nodes.find(n=>n.role?.value==='button'&&n.name?.value==='目标');assert.ok(target.backendDOMNodeId);
        sourceRequest={binding:{frameId:leafFrame.id,loaderId:leafFrame.loaderId,contextUniqueId:frame.context.uniqueId,
          rootFrameId:rootFrame.id,rootLoaderId:rootFrame.loaderId},backendNodeId:target.backendDOMNodeId};
        measureBound=()=>readFrameGeometry(graph,sourceRequest,origin,signal);
      }
      const owners=[];
      for(const frame of [leafFrame,parentFrame]){
        const {backendNodeId}=await session.send('DOM.getFrameOwner',{frameId:frame.id});
        const {object}=await session.send('DOM.resolveNode',{backendNodeId});assert.ok(object.objectId);owners.push(object.objectId);
      }
      const call=async(index,fn,args=[])=>{
        const result=await session.send('Runtime.callFunctionOn',{objectId:owners[index],functionDeclaration:fn,returnByValue:true,arguments:args.map(value=>({value}))});
        assert.equal(result.exceptionDetails,undefined);return result.result.value;
      };
      const viewport=async index=>call(index,'function(){return {width:this.contentWindow.innerWidth,height:this.contentWindow.innerHeight}}');
      const readBoundary=async index=>{
        const current=(await session.send('Page.getFrameTree')).frameTree;
        const root=current.frame,outer=current.childFrames[0].frame,inner=current.childFrames[0].childFrames[0].frame;
        const outerQuad=(await session.send('DOM.getBoxModel',{objectId:owners[1]})).model.content;
        const outerViewport=await viewport(1),rootViewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
        if(index===1)return {frameId:outer.id,documentEpoch:outer.loaderId,parentId:root.id,parentDocumentEpoch:root.loaderId,
          viewport:outerViewport,parentViewport:rootViewport,contentQuad:outerQuad};
        const rawQuad=(await session.send('DOM.getBoxModel',{objectId:owners[0]})).model.content;
        const ownerScale=await call(0,'function(){return this.ownerDocument.defaultView.devicePixelRatio}');
        const rootScale=await page.evaluate(()=>devicePixelRatio);
        const globalQuad=cdpQuadToRootViewport(rawQuad,ownerScale,rootScale);
        // Same-process DOM quads here are root-viewport-relative. Normalize them
        // explicitly into the immediate parent's viewport; do not double-offset.
        const localQuad=[];for(let i=0;i<8;i+=2){const p=parentPointToFrame({x:globalQuad[i],y:globalQuad[i+1]},outerViewport,outerQuad);localQuad.push(p.x,p.y);}
        return {frameId:inner.id,documentEpoch:inner.loaderId,parentId:outer.id,parentDocumentEpoch:outer.loaderId,
          viewport:await viewport(0),parentViewport:outerViewport,contentQuad:localQuad};
      };
      const binding={frameId:leafFrame.id,documentEpoch:leafFrame.loaderId,rootId:rootFrame.id,rootDocumentEpoch:rootFrame.loaderId,depth:2};
      const source={readBoundary,hitOwner:async(index,p)=>call(index,frameOwnerHitFunction,[p])};
      const local=await leaf.locator('#target').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
      const proof=await verifyFramePoint(local,binding,source,signal);
      const selected=sourceMode?await measureBound():proof;
      assert.ok(Math.abs(selected.point.x-proof.point.x)<1e-5&&Math.abs(selected.point.y-proof.point.y)<1e-5);
      await session.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...selected.point});
      await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...selected.point});
      const hits=await leaf.evaluate(()=>hits);
      if(hits.length!==1)console.error(JSON.stringify({scenario:scenario.name,proof,
        leaf:await leaf.evaluate(()=>({allClicks,innerWidth,innerHeight,dpr:devicePixelRatio,rect:document.querySelector('#target').getBoundingClientRect().toJSON()})),
        rootHit:await session.send('DOM.getNodeForLocation',{x:Math.round(proof.point.x),y:Math.round(proof.point.y)})},null,2));
      assert.equal(hits.length,1,scenario.name);assert.equal(hits[0].trusted,true);
      assert.ok(Math.abs(hits[0].x-local.x)<=2&&Math.abs(hits[0].y-local.y)<=2,scenario.name+' local hit');
      const positions=[{local,root:proof.point,received:hits[0]}];
      passed.push(scenario.name+': computed root point produces one trusted hit at the expected child-local position');
      // Independent event-coordinate oracles at all four child viewport corners:
      // a center-only success could hide an incorrect scale or affine-only map.
      for(const target of [{x:14,y:14},{x:236,y:14},{x:236,y:146},{x:14,y:146}]){
        await leaf.locator('#target').evaluate((el,p)=>Object.assign(el.style,{left:(p.x-6)+'px',top:(p.y-6)+'px',width:'12px',height:'12px',padding:'0',border:'0'}),target);
        // CSS zoom can quantize an ideal CSS position slightly. Source selects
        // the actual rendered center, so compare it with an independent rect
        // read rather than requiring that center to equal the requested style.
        const actual=sourceMode?await leaf.locator('#target').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}):target;
        const corner=await verifyFramePoint(actual,binding,source,signal),before=(await leaf.evaluate(()=>hits)).length;
        const selected=sourceMode?await measureBound():corner;
        assert.ok(Math.abs(selected.point.x-corner.point.x)<1e-5&&Math.abs(selected.point.y-corner.point.y)<1e-5);
        await session.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...selected.point});
        await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...selected.point});
        const received=await leaf.evaluate(()=>hits);assert.equal(received.length,before+1,scenario.name+' corner');
        assert.equal(received.at(-1).trusted,true);
        assert.ok(Math.abs(received.at(-1).x-target.x)<=2&&Math.abs(received.at(-1).y-target.y)<=2,scenario.name+' corner-local coordinates');
        positions.push({local:actual,root:corner.point,received:received.at(-1)});
      }
      await leaf.locator('#target').evaluate(el=>el.removeAttribute('style'));
      passed.push(scenario.name+': four near-corner points each produce exactly one trusted child-local hit');
      await page.evaluate(p=>{const el=document.createElement('div');el.id='cover';Object.assign(el.style,{position:'fixed',left:(p.x-12)+'px',top:(p.y-12)+'px',width:'24px',height:'24px',background:'red',zIndex:1000});document.documentElement.append(el);},proof.point);
      await assert.rejects(verifyFramePoint(local,binding,source,signal),{code:'NOT_ACTIONABLE'});
      if(sourceMode)await assert.rejects(measureBound(),{code:'NOT_ACTIONABLE'});
      assert.equal((await leaf.evaluate(()=>hits)).length,5);await page.locator('#cover').evaluate(el=>el.remove());
      passed.push(scenario.name+': parent overlay rejects the unchanged child point without dispatching input');
      await parent.evaluate(p=>{const el=document.createElement('div');el.id='cover';Object.assign(el.style,{position:'fixed',left:(p.x-12)+'px',top:(p.y-12)+'px',width:'24px',height:'24px',background:'red',zIndex:1000});document.documentElement.append(el);},proof.points[0]);
      await assert.rejects(verifyFramePoint(local,binding,source,signal),{code:'NOT_ACTIONABLE'});
      if(sourceMode)await assert.rejects(measureBound(),{code:'NOT_ACTIONABLE'});
      assert.equal((await leaf.evaluate(()=>hits)).length,5);await parent.locator('#cover').evaluate(el=>el.remove());
      passed.push(scenario.name+': intermediate-document overlay rejects the point before input');
      await parent.locator('#inner').evaluate(el=>el.style.pointerEvents='none');
      await assert.rejects(verifyFramePoint(local,binding,source,signal),{code:'NOT_ACTIONABLE'});
      if(sourceMode)await assert.rejects(measureBound(),{code:'NOT_ACTIONABLE'});
      await parent.locator('#inner').evaluate(el=>el.style.removeProperty('pointer-events'));
      passed.push(scenario.name+': pointer-disabled iframe owner cannot pass the parent hit test');
      if(sourceMode){
        await leaf.evaluate(()=>{const el=document.createElement('div');el.id='leaf-cover';Object.assign(el.style,{position:'fixed',inset:'0',zIndex:1000});document.body.append(el);});
        await assert.rejects(measureBound(),{code:'NOT_ACTIONABLE'});await leaf.locator('#leaf-cover').evaluate(el=>el.remove());
        passed.push(scenario.name+': a covered leaf target fails its own local hit check');
      }
      let reads=0;
      await assert.rejects(verifyFramePoint(local,binding,{...source,readBoundary:async index=>{
        if(++reads===3)await page.locator('#outer').evaluate(el=>el.style.left='181px');return readBoundary(index);
      }},signal),{code:'STALE_TARGET'});
      if(sourceMode){
        await page.locator('#outer').evaluate(el=>el.style.left='180px');
        sourceMutation=async(method,params)=>{
          if(method==='Runtime.callFunctionOn'&&params.functionDeclaration===frameBoundOwnerHitFunction){
            sourceMutation=undefined;await page.locator('#outer').evaluate(el=>el.style.left='181px');
          }
        };
        await assert.rejects(measureBound(),{code:'STALE_TARGET'});assert.equal(sourceMutation,undefined);
      }
      passed.push(scenario.name+': movement between verification rounds invalidates the point');
      if(sourceMode){
        // Reading a parent iframe element as though it were a leaf-document
        // target must fail even though the backend ID resolves in the process.
        const wrong=await session.send('DOM.getFrameOwner',{frameId:leafFrame.id});
        await assert.rejects(readFrameGeometry(graph,{...sourceRequest,backendNodeId:wrong.backendNodeId},origin,signal),{code:'NOT_ACTIONABLE'});
        passed.push(scenario.name+': source rejects a backend node owned by the wrong document');
        assert.ok(sourceObjects.length>=24);assert.ok(sourceCommands.every(method=>!method.startsWith('Input.')));
        for(const objectId of sourceObjects)await assert.rejects(session.send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return this.isConnected}',returnByValue:true}));
        passed.push(scenario.name+': all source-bound object handles are released, and source sends no input');
        await leaf.goto(origin+'/leaf?new-document');
        await assert.rejects(measureBound(),{code:'STALE_TARGET'});
        passed.push(scenario.name+': child navigation refuses the old document/context binding');
        graph.dispose();
      }
      samples.push({scenario,positions});
      for(const objectId of owners)await session.send('Runtime.releaseObject',{objectId});await session.detach();
    }finally{await context.close();}
  }
  const browserVersion=browser.version();await browser.close();browser=undefined;
  assert.deepEqual(await fingerprint(),sourceHashes,'Sources/build changed during the live run');
  const report={checkedAt:new Date().toISOString(),brand,browserVersion,sourceMode,sourceHashes,passed,samples,
    scope:(sourceMode?'Production source-bound frame geometry acquisition':'Read-only frame geometry primitive')+' plus test-only trusted CDP input on isolated loopback fixtures. Same-process nested frames, not production frame input, Native/DSH permission integration or OOPIF coordinate certification.'};
  await mkdir('output/playwright',{recursive:true});await writeFile('output/playwright/'+brand+'-frame-geometry'+(sourceMode?'-source':'')+'-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
