import assert from 'node:assert/strict';

export async function verifyWheel({page,observe,act}) {
  assert.equal(new URL(page.url()).hostname,'127.0.0.1');
  await page.evaluate(()=>{
    const root=document.createElement('section'); root.id='wheel-fixture';
    root.style.cssText='position:fixed;top:80px;left:300px;width:500px;padding:20px;background:white;z-index:99999';
    root.innerHTML=`<div id="wheel-canvas" role="region" aria-label="画布滚轮" style="width:460px;height:130px;background:#def"><canvas width="460" height="130"></canvas></div>
      <p id="wheel-feedback">等待画布滚轮</p>
      <div id="wheel-list" role="region" aria-label="滚轮列表" style="width:460px;height:120px;overflow:auto;overscroll-behavior:contain">
        <div style="width:1200px;height:600px;background:linear-gradient(#eee,#bcd)">长列表内容</div></div>
      <p id="wheel-list-feedback">等待列表滚轮</p>
      <div id="wheel-nested" role="region" aria-label="独立控件区域" style="position:relative;width:460px;height:70px"><button style="position:absolute;inset:0;margin:0;padding:0;border-radius:0;box-sizing:border-box;width:100%;height:100%">内嵌独立控件</button></div>`;
    document.body.append(root); window.wheelFixtureEvents=[]; window.wheelSuppressFeedback=false;
    root.addEventListener('wheel',e=>window.wheelFixtureEvents.push({trusted:e.isTrusted,dx:e.deltaX,dy:e.deltaY,mode:e.deltaMode,target:e.target.id||e.target.tagName}),true);
    document.getElementById('wheel-canvas').addEventListener('wheel',e=>{
      e.preventDefault();
      if(!window.wheelSuppressFeedback) setTimeout(()=>{document.getElementById('wheel-feedback').textContent='画布已响应滚轮';},100);
    },{passive:false});
    document.getElementById('wheel-list').addEventListener('scroll',e=>{
      const status=document.getElementById('wheel-list-feedback');
      if(e.target.scrollLeft>=100) status.textContent='横向滚轮完成';
      else if(e.target.scrollTop>=100) status.textContent='纵向滚轮完成';
    });
  });
  try {
    const o=await observe();
    const ref=name=>{const n=o.nodes.find(n=>n.role==='region'&&n.name===name);assert.ok(n,`Missing ${name}`);return n.id;};
    const action={kind:'wheel',ref:ref('画布滚轮'),deltaX:0,deltaY:120,expected:{kind:'text',text:'画布已响应滚轮'}};
    const first=await act('wheel-canvas',action); assert.equal(first.outcome,'succeeded');
    assert.deepEqual(await act('wheel-canvas',action),first);
    let events=await page.evaluate(()=>window.wheelFixtureEvents);
    assert.equal(events.length,1); assert.equal(events[0].trusted,true); assert.equal(events[0].mode,0);
    assert.equal(events[0].dx,0); assert.equal(events[0].dy,120);
    assert.equal(await page.locator('#wheel-canvas').evaluate(e=>e.scrollTop),0);
    const list={kind:'wheel',ref:ref('滚轮列表'),deltaX:0,deltaY:160,expected:{kind:'text',text:'纵向滚轮完成'}};
    assert.equal((await act('wheel-list-vertical',list)).outcome,'succeeded');
    assert.ok(await page.locator('#wheel-list').evaluate(e=>e.scrollTop>=100));
    assert.equal((await act('wheel-list-horizontal',{...list,deltaX:160,deltaY:0,expected:{kind:'text',text:'横向滚轮完成'}})).outcome,'succeeded');
    assert.ok(await page.locator('#wheel-list').evaluate(e=>e.scrollLeft>=100));
    events=await page.evaluate(()=>window.wheelFixtureEvents); assert.equal(events.length,3); assert.ok(events.every(e=>e.trusted));
    // A wheel receiver can consume the event without changing the DOM. The
    // provider must neither claim completion nor send another sample on timeout.
    await page.evaluate(()=>{window.wheelSuppressFeedback=true;document.getElementById('wheel-feedback').textContent='已重置画布';});
    const absent=await act('wheel-no-feedback',action,{timeoutMs:600});
    assert.equal(absent.outcome,'unknown'); assert.equal(absent.code,'DEADLINE_EXCEEDED');
    assert.deepEqual(await act('wheel-no-feedback',action,{timeoutMs:600}),absent);
    assert.equal((await page.evaluate(()=>window.wheelFixtureEvents)).length,4);
    const nested=await act('wheel-nested',{...action,ref:ref('独立控件区域')},{timeoutMs:500});
    assert.equal((await page.evaluate(()=>window.wheelFixtureEvents)).length,4,JSON.stringify(await page.evaluate(()=>window.wheelFixtureEvents)));
    assert.equal(nested.code,'DEADLINE_EXCEEDED'); assert.equal(nested.dispatch,'notDispatched');
    assert.equal((await page.evaluate(()=>window.wheelFixtureEvents)).length,4);
    await page.locator('#wheel-canvas').evaluate(e=>e.replaceWith(e.cloneNode(true)));
    const stale=await act('wheel-replaced',action); assert.equal(stale.code,'STALE_TARGET'); assert.equal(stale.dispatch,'notDispatched');
    assert.equal((await page.evaluate(()=>window.wheelFixtureEvents)).length,4);
    return ['Trusted CSS-pixel wheel reaches a canvas handler without DOM scrolling and deduplicates requests',
      'Vertical and horizontal native wheel samples scroll a real overflow list with verified feedback',
      'Consumed wheel without feedback remains unknown and is never automatically repeated',
      'Region wheel does not silently target an independent nested control',
      'A replacement region cannot inherit an old wheel reference'];
  } finally {await page.evaluate(()=>{document.getElementById('wheel-fixture')?.remove();delete window.wheelFixtureEvents;delete window.wheelSuppressFeedback;});}
}
