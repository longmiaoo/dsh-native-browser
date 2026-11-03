import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Component integration in an isolated Chrome-for-Testing profile. Test-only
// messages exercise the packaged content script; they confer no browser lease.
export async function verifyFeedbackExtension({ context, worker }) {
  const url = 'https://dsh-feedback.test/';
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">
    <title>DSH 可视反馈验收</title><body style="font:18px system-ui;padding:60px;background:#f3f7fc">
    <h1>连续移动与操作状态</h1><p>箭头只对应真实操作位置。读取、导航和等待使用独立状态条。</p>
    <input aria-label="验收输入"><button>验收按钮</button></body>` }));
  const page = await context.newPage();
  try {
    await page.goto(url); await page.bringToFront();
    const id = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, url);
    // The normal HTTPS content script is used, including restrictive Trusted Types.
    await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['pointer.js'] }), id);
    let revision = Date.now() * 1000;
    const message = async (payload, override = {}) => {
      const m = { type: 'dsh.pointer.v2', revision: ++revision, expiresAt: Date.now() + 30000, ...payload, ...override };
      const ack = await worker.evaluate(({id,m}) => chrome.tabs.sendMessage(id,m,{frameId:0}), {id,m});
      assert.equal(ack.version, 2); return m;
    };
    const point = () => page.locator('[data-dsh-pointer="v1"]').evaluate(host => {
      const m = new DOMMatrixReadOnly(getComputedStyle(host).transform);
      return { x: m.m41 + 2, y: m.m42 + 2, moving: host.dataset.moving };
    });
    await message({action:'activity',phase:'reading'});
    assert.equal(await page.locator('[data-dsh-activity="v1"]').getAttribute('data-phase'), 'reading');
    assert.equal(await page.locator('[data-dsh-pointer="v1"]').count(), 0, 'Reading must not invent a cursor');
    await page.evaluate(() => {
      window.feedbackInputs = [];
      for (const type of ['click','pointermove','keydown','input']) document.addEventListener(type, e => window.feedbackInputs.push(e.type));
    });
    await message({action:'show',x:120,y:180,phase:'typing'});
    assert.equal((await point()).x, 120);
    await message({action:'show',x:900,y:600,phase:'move'});
    await message({action:'show',x:900,y:600,phase:'click'});
    const samples = await page.evaluate(async () => {
      const points = [], start = performance.now();
      do {
        await new Promise(requestAnimationFrame);
        const host=document.querySelector('[data-dsh-pointer="v1"]');
        const m=new DOMMatrixReadOnly(getComputedStyle(host).transform);
        points.push({x:m.m41+2,y:m.m42+2,time:performance.now()-start});
        if(host.dataset.moving==='false') return points;
      } while(performance.now()-start<1500);
      throw Error('Pointer did not settle');
    });
    assert.ok(samples.some(p=>p.x>120&&p.x<899), 'Real rendered intermediate frames, not a teleport');
    assert.ok(Math.abs(samples.at(-1).x-900)<.01 && Math.abs(samples.at(-1).y-600)<.01);
    for(let i=1;i<samples.length;i++) assert.ok(samples[i].x >= samples[i-1].x-.01, 'Press/release must not restart the trajectory');
    await message({action:'show',x:180,y:550,phase:'wheel'});
    await page.waitForFunction(()=>document.querySelector('[data-dsh-pointer="v1"]').dataset.moving==='true');
    const beforeRetarget = await point();
    assert.ok(beforeRetarget.x > 180);
    await message({action:'show',x:700,y:240,phase:'typing'});
    await page.waitForFunction(()=>document.querySelector('[data-dsh-pointer="v1"]').dataset.moving==='false');
    assert.ok(Math.abs((await point()).x-700)<.01, 'Retarget reaches the newest actual target');
    const noInput = await page.evaluate(()=>({events:window.feedbackInputs,active:document.activeElement.tagName}));
    assert.deepEqual(noInput.events, []); assert.equal(noInput.active,'BODY');
    await mkdir('output/playwright',{recursive:true});
    await page.screenshot({path:'output/playwright/feedback-smooth.png'});
    await writeFile('output/playwright/feedback-motion.json',JSON.stringify(samples,null,2)+'\n');
    await message({action:'activity',phase:'navigating',resetPointer:true});
    assert.equal(await page.locator('[data-dsh-pointer="v1"]').count(),0);
    const stale = revision-1;
    await message({action:'show',x:100,y:100,phase:'click'},{revision:stale});
    assert.equal(await page.locator('[data-dsh-pointer="v1"]').count(),0, 'Old-document target cannot restore an arrow');
    await message({action:'activity',phase:'waiting'});
    await page.waitForFunction(()=>document.querySelector('[data-dsh-activity="v1"]').dataset.phase==='waiting');
    const oldStop = revision;
    await message({action:'activity',phase:'controlled'});
    await message({action:'remove'},{revision:oldStop});
    assert.equal(await page.locator('[data-dsh-activity="v1"]').count(),1,'A delayed previous Stop cannot erase a newer control indicator');
    await page.emulateMedia({reducedMotion:'reduce'});
    await message({action:'show',x:100,y:100,phase:'move'});
    await message({action:'show',x:800,y:500,phase:'click'});
    assert.equal((await point()).moving,'false'); assert.equal((await point()).x,800);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await message({action:'show',x:100,y:100,phase:'move'});
    const late=revision;
    await message({action:'remove'});
    await message({action:'show',x:500,y:500,phase:'click'},{revision:late});
    await message({action:'activity',phase:'reading'},{revision:late});
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.locator('[data-dsh-pointer="v1"], [data-dsh-activity="v1"]').count(),0,'Stop removes both overlays and rejects delayed frames/messages');
    await message({action:'activity',phase:'controlled'},{expiresAt:Date.now()+150});
    await page.waitForFunction(()=>!document.querySelector('[data-dsh-activity="v1"]'));
    return ['Read-only activity is visible without an invented cursor', 'Real animation frames interpolate and retarget without extra page input',
      'Press/release preserves one trajectory; reduced motion snaps directly', 'Navigation drops old coordinates; Stop and expiry remove both overlays'];
  } finally { await page.close(); await context.unroute(url); }
}
