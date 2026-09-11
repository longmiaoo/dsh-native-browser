import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { projectStatus, name, apply } from '../index.js'

test('exports a loadable pre-alpha Cordis plugin', () => {
  assert.equal(name, 'dsh-native-browser')
  assert.equal(typeof apply, 'function')
  assert.deepEqual(projectStatus, {
    phase: 'pre-alpha',
    browser: 'chrome',
    toolsRegistered: false,
  })
  assert.doesNotThrow(() => apply())
})

test('bundle patch mounts the published package name', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: native-browser/)
  assert.match(patch, /name: dsh-native-browser/)
})
