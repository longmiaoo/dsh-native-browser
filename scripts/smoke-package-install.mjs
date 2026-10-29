import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Keep the fixture below the Unix-domain socket path limit. The production
// installer intentionally validates the eventual Broker socket path.
const temporaryRoot = await mkdtemp('/tmp/dsh-native-browser-package-')

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
  const runtimeDirectory = path.join(temporaryRoot, 'runtime')
  const manifestDirectory = path.join(temporaryRoot, 'native')
  const { stdout: setupOutput } = await execFileAsync(executable, ['setup', '--browser=chrome',
    `--runtime-dir=${runtimeDirectory}`, `--manifest-dir=${manifestDirectory}`])
  const setup = JSON.parse(setupOutput)
  assert.match(setup.extensionId, /^[a-p]{32}$/)
  assert.equal(setup.extensionPath, extensionPath)
  await access(setup.host.manifest)
  await access(setup.host.launcher)
  console.log('Packed npm artifact executes through pnpm and exposes the Chrome extension.')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
