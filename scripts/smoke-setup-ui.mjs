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
let installs = 0, opened = 0, browser;
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
const core = new SlotCore(), effects=[];
core.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'}}},()=>null);
window.__ModuleLoader__ = { load(definition) {
  const plugin=definition.factory(name=>{if(name==='react') return React; throw Error(name)});
  plugin.apply({
    slots:{inject:(name,callback)=>effects.push(callback()),register:(options,component)=>core.register(options,component)},
    sessions:{list:{getSnapshot:()=>({current:'test-chat'}),subscribe:()=>()=>{}}},
    connection:{rpc:{call:async(channel,endpoint,payload,signal)=>{
      const response=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint:endpoint.split('/').at(-1),payload}),signal});
      return response.json();
    }}}, on:()=>()=>{}, effect:callback=>effects.push(callback())
  });
  const entries=core.entriesOfSlot('settings.section');
  if(entries.length!==1||entries[0].options.id!=='dsh-native-browser') throw Error('Missing settings slot');
  window.slotLabel=entries[0].options.label;
  const root=createRoot(document.getElementById('app'));
  root.render(React.createElement(entries[0].component));
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
      const result = endpoint === 'foreground' ? { ok: true, value: { accepted: true } }
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
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1050, height: 1100 } });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const install = page.getByRole('button', { name: '完成浏览器配置', exact: true });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '完成浏览器配置')?.disabled);
  assert.equal(await page.evaluate(() => window.slotLabel), '浏览器配置');
  assert.equal(installs, 0); assert.deepEqual(await readdir(root), []);
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
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/setup-ui.png', fullPage: true });
  await page.evaluate(() => window.disposeSetup());
  assert.deepEqual(errors, []);
  const report = { passed: true, scope: 'Real DSH SlotCore and React component; isolated installer without LaunchAgent; not full Desktop shell',
    installs, opened, rpcCalls: calls, browser: browser.version() };
  await writeFile('output/playwright/setup-ui.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
