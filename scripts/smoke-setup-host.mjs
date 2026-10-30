// Read-only acceptance against a running, isolated DSH Web profile. Supply its
// temporary launch log, which contains the bootstrap URL; never print that URL.
// This does not install a LaunchAgent or change the daily DSH/Chrome profiles.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const logPath = process.argv[2], executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE;
if (!logPath || !executablePath) throw Error('Provide isolated DSH launch log and DSH_CHROME_TEST_EXECUTABLE');
const log = await readFile(logPath, 'utf8');
assert.doesNotMatch(log, /native-browser.*Error|cannot get property .* without inject/);
const bootstrap = log.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s\x1b]*/)?.[0];
assert.ok(bootstrap, 'Missing loopback bootstrap URL');
const base = new URL(bootstrap).origin;
const envelope = (endpoint, payload = {}) => ({ type: 'client-request', rpcId: 'setup-host-smoke',
  method: `dsh-native-browser/${endpoint}`, payload });
for (const endpoint of ['setup.status', 'setup.install', 'foreground']) {
  const response = await fetch(`${base}/api/dsh-native-browser/${endpoint}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope(endpoint)) });
  assert.equal(response.status, 401, `${endpoint} must reject unauthenticated callers`);
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/dsh-native-browser/'))
    calls.push({ endpoint: new URL(response.url()).pathname.split('/').at(-1), status: response.status() }); });
  await page.goto(bootstrap);
  // Fresh host onboarding: dismiss its description and account prompt, without
  // entering any credentials or altering model configuration.
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  const close = page.getByRole('button', { name: '关闭', exact: true });
  await Promise.race([welcome.waitFor(), close.waitFor()]);
  if (await welcome.isVisible()) await welcome.click();
  await close.click();
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await page.getByText('设置', { exact: true }).click();
  await page.getByText('浏览器配置', { exact: true }).click();
  const section = page.locator('section[aria-label="DSH Native Browser"]');
  await section.getByText('尚未就绪：请完成配置、加载扩展，再检查连接。', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button', { name: '完成浏览器配置', exact: true }).isEnabled(), process.platform === 'darwin');
  const response = page.waitForResponse(r => r.url().endsWith('/api/dsh-native-browser/setup.status'));
  await section.getByRole('button', { name: '检查连接', exact: true }).click();
  const status = await (await response).json(); assert.equal(status.result.ok, true);
  assert.equal(status.result.value.extensionStaged, false, 'Use a fresh isolated runtime');
  assert.equal(status.result.value.version, JSON.parse(await readFile('package.json', 'utf8')).version);
  // Actual authenticated carrier, but intentionally no confirmation: no writes.
  const rejected = await page.evaluate(async body => {
    const r = await fetch('/api/dsh-native-browser/setup.install', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json();
  }, envelope('setup.install'));
  assert.equal(rejected.result.ok, false); assert.equal(rejected.result.error.code, 'gateway/bad-request');
  const crossOrigin = await page.context().request.post(`${base}/api/dsh-native-browser/setup.status`, {
    headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, data: envelope('setup.status') });
  assert.equal(crossOrigin.status(), 403);
  assert.deepEqual(errors, []);
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/setup-host.png' });
  const report = { passed: true, browser: browser.version(), version: status.result.value.version,
    scope: 'Full DSH Web settings shell and authenticated shared routes; no install click, model calls or daily profile changes',
    anonymousRejected: true, crossOriginRejected: true, unconfirmedInstallRejected: true, calls, errors };
  await writeFile('output/playwright/setup-host.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
