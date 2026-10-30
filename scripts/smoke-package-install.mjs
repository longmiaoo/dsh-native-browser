import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
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

  const install = async (bin, runtime, native) => {
    const { stdout } = await execFileAsync(bin, ['install', '--browser=chrome', '--no-service', '--no-open', '--json',
      `--runtime-dir=${runtime}`, `--manifest-dir=${native}`])
    const result = JSON.parse(stdout)
    assert.equal(result.manualActionRequired, 'load-unpacked')
    assert.equal(result.extensionId, setup.extensionId)
    assert.equal(result.extensionPath, path.join(runtime, 'extension', 'chrome'))
    const manifest = JSON.parse(await readFile(path.join(result.extensionPath, 'manifest.json'), 'utf8'))
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.version, pkg.version)
    await access(result.host.manifest)
    await access(result.host.launcher)
    return result
  }
  const first = await install(executable, runtimeDirectory, manifestDirectory)
  const token = await readFile(path.join(runtimeDirectory, 'auth-token'))
  const repeated = await install(executable, runtimeDirectory, manifestDirectory)
  assert.equal(repeated.extensionPath, first.extensionPath)
  assert.deepEqual(await readFile(path.join(runtimeDirectory, 'auth-token')), token)

  // Reproduce the actual old-user route: registry alpha.10 setup, package-manager
  // replacement, then the new install command into the same private runtime.
  const upgradeConsumer = path.join(temporaryRoot, 'upgrade-consumer')
  await mkdir(upgradeConsumer)
  await execFileAsync('pnpm', ['add', '--dir', upgradeConsumer, '--ignore-scripts', 'dsh-native-browser@0.1.0-alpha.10'])
  const upgradeBin = path.join(upgradeConsumer, 'node_modules', '.bin', 'dsh-native-browser')
  const upgradeRuntime = path.join(temporaryRoot, 'upgraded'), upgradeNative = path.join(temporaryRoot, 'upgrade-native')
  const old = JSON.parse((await execFileAsync(upgradeBin, ['setup', '--browser=chrome',
    `--runtime-dir=${upgradeRuntime}`, `--manifest-dir=${upgradeNative}`])).stdout)
  const oldToken = await readFile(path.join(upgradeRuntime, 'auth-token'))
  await execFileAsync('pnpm', ['add', '--dir', upgradeConsumer, '--ignore-scripts', archive])
  const upgraded = await install(upgradeBin, upgradeRuntime, upgradeNative)
  assert.equal(upgraded.extensionId, old.extensionId)
  assert.deepEqual(await readFile(path.join(upgradeRuntime, 'auth-token')), oldToken)
  const host = JSON.parse(await readFile(upgraded.host.manifest, 'utf8'))
  assert.equal(host.path, path.join(upgradeRuntime, 'native-host'))
  assert.deepEqual(host.allowed_origins, [`chrome-extension://${upgraded.extensionId}/`])
  await execFileAsync(upgradeBin, ['uninstall-host', '--browser=chrome',
    `--runtime-dir=${upgradeRuntime}`, `--manifest-dir=${upgradeNative}`])
  await assert.rejects(access(upgraded.host.manifest), { code: 'ENOENT' })
  await access(path.join(upgraded.extensionPath, 'manifest.json'))
  await install(upgradeBin, upgradeRuntime, upgradeNative)
  console.log('Packed npm consumer: fresh install, repeat install, alpha.10 upgrade, host uninstall/reinstall, stable extension ID/path and preserved runtime identity passed. Desktop service/browser consent are tested separately.')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
