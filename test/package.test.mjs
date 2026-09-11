import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { projectStatus, name, apply } from '../index.js'
import { applyObservationUpdate } from 'dsh-native-browser/observations'

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
  })
  const tools = []
  assert.doesNotThrow(() => apply({ tools: { register: tool => tools.push(tool) }, on() {}, effect() {} }))
  assert.equal(tools.length, 9)
})

test('bundle patch mounts the published package name', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: native-browser/)
  assert.match(patch, /name: dsh-native-browser/)
})
