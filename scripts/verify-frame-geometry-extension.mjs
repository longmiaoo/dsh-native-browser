import assert from 'node:assert/strict';

/** Isolated fixture only: exercises the production MV3 frame.geometry command.
 * Native transport belongs to the caller's declared test seam. The final input
 * below is test-only, NOT a public frame action or reusable geometry ticket. */
export async function verifyFrameGeometryExtension({page,worker,channel,lease,origin,signal}){
  const tabId=Number(lease.tab.slice(lease.instanceId.length+1));
  await page.evaluate(origin=>{
    const el=document.createElement('iframe');el.id='geometry-test-frame';el.src=origin+'/geometry-child';
    Object.assign(el.style,{position:'fixed',left:'100px',top:'70px',width:'700px',height:'500px',border:'11px solid #357',padding:'7px',
      transform:'rotate(5deg) scale(.9)',zIndex:'1000'});document.body.append(el);
  },origin);
  const handle=await page.locator('#geometry-test-frame').elementHandle(),child=await handle.contentFrame();
  await child.waitForURL(origin+'/geometry-child');await child.waitForLoadState('load');
  await child.locator('#submit').evaluate(el=>el.addEventListener('click',e=>{globalThis.geometryHit={trusted:e.isTrusted,x:e.clientX,y:e.clientY};}));
  await worker.evaluate(()=>{
    const original=chrome.debugger.sendCommand;
    globalThis.geometryProbe={original,methods:[],objects:[]};
    chrome.debugger.sendCommand=async function(target,method,params){
      geometryProbe.methods.push(method);const value=await original.call(this,target,method,params);
      if(method==='DOM.resolveNode')geometryProbe.objects.push(value.object.objectId);return value;
    };
  });
  try{
    const inventory=await channel.call('frames.list',{lease},signal);
    const root=inventory.frames.find(f=>!f.parentId),frame=inventory.frames.find(f=>f.parentId===root.frameId);assert.ok(frame.context.uniqueId);
    const binding={frameId:frame.frameId,loaderId:frame.loaderId,contextUniqueId:frame.context.uniqueId,rootFrameId:root.frameId,rootLoaderId:root.loaderId};
    const ax=await channel.call('ax.frame',{lease,binding},signal),target=ax.nodes.find(n=>n.role?.value==='button'&&n.name?.value==='提交测试');assert.ok(target);
    const request={binding,backendNodeId:target.backendDOMNodeId},read=()=>channel.call('frame.geometry',{lease,request},signal);
    await worker.evaluate(()=>{geometryProbe.methods=[];geometryProbe.objects=[];});
    const geometry=await read();assert.equal(geometry.depth,1);assert.equal(await child.evaluate(()=>fixtureClicks.submit),0);
    const trace=await worker.evaluate(()=>({methods:geometryProbe.methods,objects:geometryProbe.objects}));
    assert.ok(trace.methods.includes('Runtime.releaseObjectGroup'));assert.ok(trace.methods.every(m=>!m.startsWith('Input.')));
    assert.equal(trace.objects.length,2);
    for(const objectId of trace.objects)assert.equal(await worker.evaluate(async({tabId,objectId})=>{
      try{await chrome.debugger.sendCommand({tabId},'Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return this.isConnected}',returnByValue:true});return false;}
      catch{return true;}
    },{tabId,objectId}),true);
    await page.evaluate(p=>{const el=document.createElement('div');el.id='geometry-test-cover';Object.assign(el.style,{position:'fixed',left:(p.x-20)+'px',top:(p.y-20)+'px',width:'40px',height:'40px',zIndex:'1001',background:'red'});document.body.append(el);},geometry.point);
    await assert.rejects(read(),{code:'NOT_ACTIONABLE'});await page.locator('#geometry-test-cover').evaluate(el=>el.remove());
    const fresh=await read();
    for(const type of ['mousePressed','mouseReleased'])await channel.call('cdp',{lease,method:'Input.dispatchMouseEvent',params:{type,...fresh.point,button:'left',clickCount:1}},signal);
    const hit=await child.evaluate(()=>geometryHit);assert.equal(hit.trusted,true);assert.equal(await child.evaluate(()=>fixtureClicks.submit),1);
    assert.ok(Math.abs(hit.x-fresh.local.x)<=2&&Math.abs(hit.y-fresh.local.y)<=2);
    await child.goto(origin+'/geometry-child?next-document');await assert.rejects(read(),{code:'STALE_TARGET'});
    return {request,checks:[
      'Bound source geometry executes in real MV3 with child-local and ancestor-owner checks',
      'Real MV3 source sends no input and releases both bound object handles before returning',
      'Parent overlay rejects source geometry; fresh returned point produces one trusted child hit via test-only input',
      'Child navigation rejects the outgoing document/context binding'
    ]};
  }finally{
    await page.locator('#geometry-test-cover').evaluateAll(els=>els.forEach(el=>el.remove()));
    await page.locator('#geometry-test-frame').evaluate(el=>el.remove());
    await worker.evaluate(()=>{chrome.debugger.sendCommand=geometryProbe.original;delete globalThis.geometryProbe;});
  }
}
