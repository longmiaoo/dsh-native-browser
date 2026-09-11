import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { verifyLiveProvider } from './verify-live-provider.mjs';
const html = await readFile(new URL('../test/fixtures/form.html', import.meta.url));
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: process.env.DSH_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await verifyLiveProvider(page);
  const report = { ...result, browserVersion: browser.version(), checkedAt: new Date().toISOString(),
    scope: 'Live ChromiumProvider and BrowserRuntime through CDP; extension/native-host/DSH model not part of this test' };
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/chrome-smoke.png' });
  await writeFile('output/playwright/chrome-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
