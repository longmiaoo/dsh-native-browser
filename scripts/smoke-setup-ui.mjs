// Isolated setup-page test: real DSH SlotCore + shared React, real installer
// with temporary manifests and no LaunchAgent changes; no daily Chrome profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createSetupController, verifySetupRuntime } from '../dist/packages/dsh-adapter/src/setup.js';
import { diagnose } from '../dist/packages/installer/src/doctor.js';
import { quickInstall } from '../dist/packages/installer/src/quick-install.js';

const hostRoot = process.argv[2], executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE;
if (!hostRoot || !executablePath) throw new Error('Provide an installed DSH directory and DSH_CHROME_TEST_EXECUTABLE');
const hostRequire = createRequire(path.join(path.resolve(hostRoot), 'package.json'));
const rendererRequire = process.argv[3] ? createRequire(path.join(path.resolve(process.argv[3]), 'package.json')) : hostRequire;
const root = await mkdtemp('/tmp/dsh-setup-ui-'), directory = path.join(root, 'runtime'), manifestDir = path.join(root, 'manifests');
const calls = [], errors = [];
let installs = 0, opened = 0, browser, statusPreview, taskStatusPreview;
const setup = createSetupController(directory, {
  platform: 'darwin', verifyRuntime: verifySetupRuntime,
  diagnose: options => diagnose({ ...options, manifestDir }),
  quickInstall: async options => { installs++; return quickInstall({ ...options, manifestDir, service: false, open: false }); },
  openSetup: async () => { opened++; return { openedBrowser: true, revealedExtension: true }; },
});
const entry = `
import React from ${JSON.stringify(hostRequire.resolve('react'))};
import { createRoot } from ${JSON.stringify(rendererRequire.resolve('react-dom/client'))};
import { SlotCore } from ${JSON.stringify(hostRequire.resolve('@deepseek-ai/dsh-client-ui-slots'))};
const core = new SlotCore(), effects=[], selectionListeners=new Set();
let current;
window.selectTestChat=value=>{current=value;for(const listener of selectionListeners)listener()};
const legacy=new URLSearchParams(location.search).has('legacy');
const children={'settings.section':{kind:'list',scope:'root'},'tool.call.toolview':{kind:'keyed',scope:'session'}};
if(!legacy) Object.assign(children,{'main':{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'},
  'plugins.bundle.config':{kind:'keyed',scope:'root'},'plugins.row.config':{kind:'keyed',scope:'root'},
  'plugins.bundle.activation':{kind:'keyed',scope:'root'},'plugins.detail.actions':{kind:'list',scope:'root'}});
core.register({name:'root',children},()=>null);
const root=createRoot(document.getElementById('app'));
const layout={selectPanel(id){
  window.selectedPanel=id;
  if(id===null){root.render(React.createElement('p',null,'Conversation preserved'));return;}
  const entry=core.entriesOfSlot('main').find(e=>e.options.key===id);
  if(!entry)throw Error('Unknown main panel '+id);
  root.render(React.createElement(entry.component,{key:'main'}));
}};
const entryFor=(slot,key)=>core.entriesOfSlot(slot).find(e=>e.options.key===key);
const render=(slot,key,props={})=>root.render(React.createElement(entryFor(slot,key).component,{...props,key:slot}));
window.__ModuleLoader__ = { load(definition) {
  const plugin=definition.factory(name=>{if(name==='react') return React; throw Error(name)});
  plugin.apply({
    slots:{inject:(name,callback)=>{if(legacy&&!['settings.section','tool.call.toolview'].includes(name))return ()=>{};const dispose=callback();effects.push(dispose);return dispose;},register:(options,component)=>core.register(options,component)},
    get:name=>name==='layout'&&!legacy?layout:undefined,
    sessions:{list:{getSnapshot:()=>({phase:current===undefined?'pending':'ready',ids:current?[current]:[],byId:current?{[current]:{id:current,retainedBy:{mainView:1}}}: {}}),subscribe:listener=>{selectionListeners.add(listener);return ()=>selectionListeners.delete(listener)}}},
    connection:{rpc:{call:async(channel,endpoint,payload,signal)=>{
      const response=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint:endpoint.split('/').at(-1),payload}),signal});
      return response.json();
    }}}, on:()=>()=>{}, effect:callback=>effects.push(callback())
  });
  const entries=core.entriesOfSlot('settings.section');
  window.taskToolView=core.entriesOfSlot('tool.call.toolview').find(e=>e.options.key==='native_browser_task')?.component;
  if(entries.length!==1||entries[0].options.id!=='dsh-native-browser') throw Error('Missing settings slot');
  window.slotLabel=entries[0].options.label;
  window.openBundle=()=>{
    const subject={kind:'bundle',pkg:{name:'dsh-native-browser'}};
    root.render(React.createElement(React.Fragment,null,
      ...core.entriesOfSlot('plugins.detail.actions').map((entry,i)=>React.createElement(entry.component,{subject,key:'action-'+i})),
      React.createElement(entryFor('plugins.bundle.config','dsh-native-browser').component,{view:'page',key:'bundle'})));
  };
  window.openSettings=()=>root.render(React.createElement(entries[0].component,{key:'settings'}));
  window.openRow=()=>render('plugins.row.config','dsh-native-browser#native-browser',{view:'page'});
  window.openWelcome=()=>render('plugins.bundle.activation','dsh-native-browser',{packageName:'dsh-native-browser',onOpenDetails:window.openBundle,onDismiss:()=>root.render(null)});
  window.openOtherDetail=()=>root.render(React.createElement(core.entriesOfSlot('plugins.detail.actions')[0].component,{subject:{kind:'bundle',pkg:{name:'other-plugin'}}}));
  window.panelEntries=core.entriesOfSlot('sidebar.panellist').map(e=>({id:e.options.id,label:e.options.label}));
  window.openSidebar=id=>layout.selectPanel(id);
  if(legacy) window.openSettings(); else window.openWelcome();
  window.previewTaskCard=()=>root.render(React.createElement(window.taskToolView,{toolName:'native_browser_task',callId:'ui-test',phase:'result',block:{content:[{type:'text',text:JSON.stringify({closed:2,retained:1,skipped:0})}]}}));
  window.disposeSetup=()=>{root.unmount();for(const dispose of effects)dispose?.()};
}};
`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false,
  platform: 'browser', format: 'iife', alias: { react: hostRequire.resolve('react') }, define: { 'process.env.NODE_ENV': '"development"' } });
const client = await readFile(new URL('../client.js', import.meta.url));
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/harness.js') { res.setHeader('content-type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); }
    else if (req.url === '/client.js') { res.setHeader('content-type', 'application/javascript'); res.end(client); }
    else if (req.url === '/rpc' && req.method === 'POST') {
      let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 4096) throw new Error('request too big'); }
      const { endpoint, payload } = JSON.parse(data); calls.push(endpoint);
      const result = endpoint === 'task.status' ? {ok:true,value:taskStatusPreview === undefined ? {phase:'ready',action:'observe',pages:[],pending:0} : taskStatusPreview}
        : endpoint === 'task.stop' ? {ok:true,value:{phase:'handed-off'}}
        : endpoint === 'task.finish' ? {ok:true,value:{closed:2,retained:1,skipped:0}}
        : endpoint === 'setup.status' && statusPreview ? { ok: true, value: statusPreview }
        : endpoint === 'foreground' ? { ok: true, value: { accepted: true } }
        : await setup(endpoint, payload, new AbortController().signal);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH setup component acceptance</title><style>body{background:#191b20;color:#ebecf0;font:15px system-ui;margin:30px auto;max-width:760px}button,input{color:inherit;background:#292d35;border:1px solid #666;border-radius:7px;padding:8px}button:disabled{opacity:.45}h2{color:#8acaff}details{margin-top:20px}</style><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script></html>');
    }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: { message: String(error) } })); }
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', colorScheme: 'dark', viewport: { width: 1050, height: 1100 } });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading',{name:'已启用：下一步连接 Chrome',exact:true}).waitFor({timeout:5000});
  assert.equal(installs,0); assert.equal(opened,0); assert.deepEqual(await readdir(root),[]);
  assert.equal(calls.includes('setup.install'),false,'Showing activation guidance must not install anything');
  await page.getByRole('button',{name:'现在连接 Chrome',exact:true}).click();
  await page.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  await page.getByRole('button',{name:'配置浏览器',exact:true}).waitFor();
  const panels=await page.evaluate(()=>window.panelEntries);
  assert.deepEqual(panels,[{id:'dsh-native-browser.setup',label:'浏览器'}]);
  await page.getByRole('button',{name:'配置浏览器',exact:true}).click();
  await page.getByRole('button',{name:'返回对话',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.selectedPanel),'dsh-native-browser.setup');
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await page.getByText('Conversation preserved',{exact:true}).waitFor();
  await page.evaluate(()=>window.openRow());
  await page.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  await page.evaluate(()=>window.openSettings());
  await page.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  assert.equal(installs,0); assert.equal(opened,0);
  // Settings can open before Desktop has selected or hydrated a conversation.
  await page.evaluate(() => window.selectTestChat(null));
  await page.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  let invalidIndex = 0;
  for (const invalidStatus of [null, {}, {phase:'ready',pages:null}]) {
    taskStatusPreview = invalidStatus;
    const id = `invalid-status-chat-${++invalidIndex}`;
    const response = page.waitForResponse(response => response.url().endsWith('/rpc')
      && response.request().postDataJSON()?.endpoint.split('/').at(-1) === 'task.status'
      && response.request().postDataJSON()?.payload?.sessionId === id);
    await page.evaluate(id => window.selectTestChat(id), id);
    assert.deepEqual((await (await response).json()).value, invalidStatus);
    await page.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  }
  taskStatusPreview = {phase:'attention', action:'act', pages:[], pending:0, attention:'verify-result',
    lastResult:{outcome:'unknown',dispatch:'dispatched',postcondition:'unverified'}};
  await page.evaluate(() => window.selectTestChat('unverified-result-chat'));
  await page.getByRole('alert').filter({hasText:'操作结果尚需核实'}).waitFor();
  assert.ok(await page.getByText('需要检查', {exact:false}).count());
  taskStatusPreview = {phase:'attention', action:'act', pages:[], pending:0, attention:'refresh-target', error:'STALE_TARGET'};
  await page.evaluate(() => window.selectTestChat('stale-target-chat'));
  await page.getByRole('alert').filter({hasText:'页面或目标可能已变化'}).waitFor();
  taskStatusPreview = undefined;
  await page.evaluate(() => window.selectTestChat('test-chat'));
  const install = page.getByRole('button', { name: '完成浏览器配置', exact: true });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '完成浏览器配置')?.disabled);
  assert.equal(await page.evaluate(() => window.slotLabel), '浏览器配置');
  assert.equal(installs, 0); assert.deepEqual(await readdir(root), []);
  await mkdir('output/playwright',{recursive:true});
  await page.screenshot({path:'output/playwright/setup-first-run.png',fullPage:true});
  await install.click();
  await page.getByText('本机组件已配置。请完成下方 Chrome 扩展加载步骤，再检查连接。', { exact: true }).waitFor();
  assert.equal(installs, 1);
  const token = await readFile(path.join(directory, 'auth-token'), 'utf8');
  assert.equal(await page.getByRole('textbox', { name: '扩展目录' }).inputValue(), path.join(directory, 'extension/chrome'));
  await install.click();
  await page.getByText('本机组件已配置。请完成下方 Chrome 扩展加载步骤，再检查连接。', { exact: true }).waitFor();
  assert.equal(installs, 2); assert.equal(await readFile(path.join(directory, 'auth-token'), 'utf8'), token);
  await page.getByRole('button', { name: '打开扩展管理页', exact: true }).click();
  await page.getByText('已打开扩展管理页和扩展文件夹。', { exact: true }).waitFor(); assert.equal(opened, 1);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '检查连接')?.disabled);
  assert.equal(installs, 2);
  await page.getByText('连接诊断', { exact: true }).click();
  // Presentation-only scenarios: never change the real service or Host policy.
  const actualStatus = (await setup('setup.status', {}, new AbortController().signal)).value;
  const preview = async (access, approval, message) => {
    statusPreview = { ...actualStatus, policy: { browserAccessMode: access, approvalMode: approval },
      report: { ...actualStatus.report, status: 'ready' } };
    await page.getByRole('button', { name: '检查连接', exact: true }).click();
    await page.getByText(message, { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Chrome 最后一步' }).count(), 0);
  };
  // Loading Chrome and returning to this window performs only a status check.
  statusPreview = { ...actualStatus, policy: { browserAccessMode: 'personal', approvalMode: 'personal' },
    report: { ...actualStatus.report, status: 'ready' } };
  const statusReadsBefore=calls.filter(endpoint=>endpoint==='setup.status').length;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByText('Chrome 已连接。个人模式无需逐页授权，可以回到聊天开始使用。',{exact:true}).waitFor();
  assert.ok(calls.filter(endpoint=>endpoint==='setup.status').length>statusReadsBefore);
  assert.equal(installs,2);assert.equal(opened,1);
  await preview('personal', 'personal', 'Chrome 已连接。个人模式无需逐页授权，可以回到聊天开始使用。');
  await page.getByText('插件审批：个人模式，不额外逐次询问；仍遵循 DSH 的权限设置。', { exact: true }).waitFor();
  await preview('personal', 'per-action', '插件审批：逐次审批。当前显式配置会在操作时请求确认。');
  await preview('restricted', 'per-lease', 'Chrome 已连接，当前为受限模式。请在扩展弹窗中允许目标标签页。');
  await preview('restricted', 'personal', '插件为个人模式，但后台为受限模式。请点击“完成浏览器配置”启用匹配的个人后台，或显式选择受限审批配置。');
  await preview('unknown', 'personal', 'Chrome 已连接。尚未确认页面访问模式，请重新检查连接。');
  await preview('personal', 'personal', 'Chrome 已连接。个人模式无需逐页授权，可以回到聊天开始使用。');
  assert.equal(installs, 2);
  assert.equal(await page.getByRole('textbox',{name:'扩展目录'}).isVisible(),false,'Connected users see the first-task prompt before advanced extension details');
  await mkdir('output/playwright', { recursive: true });
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'复制试用指令',exact:true}).click();
  assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes('native_browser'));
  await page.screenshot({ path: 'output/playwright/setup-ui.png', fullPage: true });
  await page.evaluate(()=>window.openBundle());
  await page.getByRole('button',{name:'配置浏览器',exact:true}).waitFor();
  await page.getByText('Chrome 已连接。个人模式无需逐页授权，可以回到聊天开始使用。',{exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/plugin-detail-setup.png',fullPage:true});
  await page.getByRole('button',{name:'配置浏览器',exact:true}).click();
  await page.getByRole('button',{name:'返回对话',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/browser-panel-setup.png',fullPage:true});
  await page.getByRole('heading',{name:'当前对话的浏览器任务'}).waitFor();
  await page.getByRole('button',{name:'完成并清理临时页'}).click();
  await page.getByText('收尾返回：关闭 2 页；失效或失败的页面不会强行关闭。',{exact:true}).waitFor();
  await page.evaluate(() => window.selectTestChat(undefined));
  await page.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/setup-without-conversation.png',fullPage:true});
  assert.equal(await page.getByRole('button', {name:'回到聊天，开始使用',exact:true}).count(),1);
  await page.getByRole('link',{name:'☆ Star',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Setup must fit a narrow window');
  await page.screenshot({path:'output/playwright/setup-mobile.png',fullPage:true});
  await page.setViewportSize({width:1050,height:1100});
  await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
  await page.evaluate(()=>{document.body.style.background='#f3f5f8';document.body.style.color='#1e293b'});
  await page.screenshot({path:'output/playwright/setup-light.png',fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});
  await page.evaluate(()=>{document.body.style.background='#191b20';document.body.style.color='#ebecf0'});

  await page.evaluate(() => window.previewTaskCard());
  await page.getByText('关闭 2 页，保留 1 页，待处理 0 页',{exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/task-card.png'});
  await page.evaluate(()=>window.openOtherDetail());
  assert.equal(await page.getByRole('button',{name:'配置浏览器',exact:true}).count(),0,'Other plugins must not get our configuration button');
  await page.evaluate(() => window.disposeSetup());
  const legacyPage=await context.newPage();legacyPage.on('pageerror',e=>errors.push(e.message));
  await legacyPage.goto('http://127.0.0.1:'+server.address().port+'/?legacy=1');
  await legacyPage.getByRole('heading',{name:'DSH Native Browser',exact:true}).waitFor();
  assert.equal(await legacyPage.getByRole('button',{name:'返回对话',exact:true}).count(),0);
  assert.equal(installs,2);assert.equal(opened,1);
  await legacyPage.evaluate(()=>window.disposeSetup());await legacyPage.close();
  const english = await browser.newContext({locale:'en-US',colorScheme:'light',viewport:{width:1050,height:1100}});
  const englishPage = await english.newPage();englishPage.on('pageerror',e=>errors.push(e.message));
  await englishPage.goto(`http://127.0.0.1:${server.address().port}`);
  await englishPage.getByRole('button',{name:'Connect Chrome now',exact:true}).click();
  await englishPage.getByRole('heading',{name:'Chrome is ready',exact:true}).waitFor();
  await englishPage.getByRole('link',{name:'Contribute ↗',exact:true}).waitFor();
  // Host theme tokens must win even when the system color scheme is light.
  await englishPage.evaluate(()=>{document.body.style.setProperty('--dsw-alias-label-primary','#eeeeee');document.body.style.setProperty('--dsw-specific-input-major','#1a1b20')});
  assert.equal(await englishPage.locator('.nb-card').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(26, 27, 32)');
  assert.equal(installs,2);assert.equal(opened,1,'Appearance and language changes only read status');
  await english.close();
  assert.deepEqual(errors, []);
  const report = { passed: true, scope: 'Real DSH SlotCore and React component; isolated installer without LaunchAgent; not full Desktop shell',
    installs, opened, rpcCalls: calls, browser: browser.version(), noConversation: true, malformedTaskStatuses: invalidIndex, pluginDetails: true, rowConfiguration: true, sidebarPanel: true, activationGuidance: true, legacyFallback: true };
  await writeFile('output/playwright/setup-ui.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
