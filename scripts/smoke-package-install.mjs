import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dsh-native-browser-package-'))

try {
  const { stdout: packOutput } = await execFileAsync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--pack-destination', temporaryRoot],
    { cwd: root },
  )
  const archiveName = packOutput.trim().split(/\r?\n/).at(-1)
  assert.ok(archiveName, 'npm pack did not report an archive')

  const archive = path.join(temporaryRoot, archiveName)
  const consumer = path.join(temporaryRoot, 'consumer')
  await mkdir(consumer)
  await execFileAsync('pnpm', ['add', '--dir', consumer, '--ignore-scripts', archive])

  const executable = path.join(consumer, 'node_modules', '.bin', 'dsh-native-browser')
  const { stdout } = await execFileAsync(executable, ['extension-path', '--browser=chrome'])
  const extensionPath = await realpath(stdout.trim())
  const expectedPath = await realpath(path.join(
    consumer,
    'node_modules',
    'dsh-native-browser',
    'dist',
    'extension',
    'chrome',
  ))

  assert.equal(extensionPath, expectedPath)
  await access(path.join(extensionPath, 'manifest.json'))
  console.log('Packed npm artifact executes through pnpm and exposes the Chrome extension.')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
