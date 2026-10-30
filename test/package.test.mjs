import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { projectStatus, name, apply } from '../index.js'
import { applyObservationUpdate } from 'dsh-native-browser/observations'
import { extensionIdFromManifestKey } from '../dist/packages/installer/src/extension.js'

const execFileAsync = promisify(execFile)

test('publishes a browser-independent observation reducer with TypeScript declarations', async () => {
  assert.equal(typeof applyObservationUpdate, 'function')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const declaration = await readFile(new URL(`../${manifest.exports['./observations'].types}`, import.meta.url), 'utf8')
  assert.match(declaration, /export declare function applyObservationUpdate/)
})

test('exports a loadable development-preview Cordis plugin', () => {
  assert.equal(name, 'dsh-native-browser')
  assert.equal(typeof apply, 'function')
  assert.deepEqual(projectStatus, {
    phase: 'development-preview',
    browser: 'chrome',
    toolsRegistered: true,
    toolNamespace: 'native_browser',
  })
  const tools = []
  const connection = { rpc: { handle: () => () => {} } }
  assert.doesNotThrow(() => apply({ tools: { register: tool => tools.push(tool) }, on() {}, effect() {}, get: name => name === 'connection' ? connection : undefined }))
  assert.equal(tools.length, 13)
  assert.ok(tools.every(tool => tool.name.startsWith('native_browser_')))
  assert.ok(tools.every(tool => !tool.name.startsWith('browser_')))
  for (const name of ['native_browser_open', 'native_browser_activate', 'native_browser_close', 'native_browser_release_all']) {
    assert.ok(tools.some(tool => tool.name === name), name)
  }
})

test('canonical tools avoid browser_* and optional aliases skip occupied names', () => {
  const registered = new Map([['browser_claim', { name: 'browser_claim', owner: 'other-plugin' }]])
  const hooks = new Map(), services = new Map([['connection', { rpc: { handle: () => () => {} } }]])
  const ctx = {
    tools: { register(tool) {
      if (registered.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`)
      registered.set(tool.name, tool)
    } },
    on: (event, handler) => hooks.set(event, handler), effect() {}, get: service => services.get(service),
  }
  assert.doesNotThrow(() => apply(ctx, { legacyToolNames: true }))
  assert.equal(registered.get('browser_claim').owner, 'other-plugin')
  for (const shortName of ['list', 'claim', 'open', 'activate', 'close', 'release_all', 'observe', 'read_page', 'frames', 'act', 'batch', 'handoff', 'screenshot']) {
    assert.ok(registered.has(`native_browser_${shortName}`), shortName)
  }
  assert.ok(registered.has('browser_open'))
  assert.equal(registered.has('browser_claim'), true)
  assert.equal(registered.get('browser_claim').owner, 'other-plugin')
})

test('bundle patch mounts the published package name', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: native-browser/)
  assert.match(patch, /name: dsh-native-browser/)
})

test('CLI prints the packaged extension directory for Chrome setup', async () => {
  const bin = fileURLToPath(new URL('../bin/dsh-native-browser.mjs', import.meta.url))
  const expected = fileURLToPath(new URL('../dist/extension/chrome', import.meta.url))
  const { stdout } = await execFileAsync(process.execPath, [bin, 'extension-path', '--browser=chrome'])
  assert.equal(stdout.trim(), expected)
})

test('setup installs the host for the packaged stable extension ID', async (t) => {
  const root = await mkdtemp('/tmp/dsh-native-browser-setup-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = fileURLToPath(new URL('../bin/dsh-native-browser.mjs', import.meta.url))
  for (const brand of ['chrome', 'edge']) {
    const manifest = JSON.parse(await readFile(new URL(`../dist/extension/${brand}/manifest.json`, import.meta.url), 'utf8'))
    const { stdout } = await execFileAsync(process.execPath, [bin, 'setup', `--browser=${brand}`,
      `--runtime-dir=${path.join(root, 'runtime')}`, `--manifest-dir=${path.join(root, brand)}`])
    const result = JSON.parse(stdout)
    assert.match(result.extensionId, /^[a-p]{32}$/)
    assert.equal(result.extensionId, extensionIdFromManifestKey(manifest.key))
    assert.equal(result.extensionPath, fileURLToPath(new URL(`../dist/extension/${brand}`, import.meta.url)))
    assert.equal(result.host.browser, brand)
  }
})

test('CLI entrypoint remains executable for pnpm symlink installs', async () => {
  const bin = fileURLToPath(new URL('../bin/dsh-native-browser.mjs', import.meta.url))
  const metadata = await stat(bin)
  assert.notEqual(metadata.mode & 0o111, 0, 'bin/dsh-native-browser.mjs must retain an executable mode')
})
