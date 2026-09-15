import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

const requiredKeywords = [
  'dsh-plugin',
  'deepseek-harness',
  'browser-automation',
  'computer-use',
  'chrome',
]

const failures = []

if (pkg.name !== 'dsh-native-browser') failures.push('package name must be dsh-native-browser')
if (pkg.license !== 'MIT') failures.push('license metadata must be MIT')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') failures.push('dsh.bundle.patch must point to ./cordis.patch.yml')
if (pkg.exports?.['./client'] !== './client.js') failures.push('package exports must expose ./client')
if (pkg.dsh?.client?.platform !== 'web') failures.push('dsh.client.platform must be web')
for (const service of ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-connection']) {
  if (!pkg.dsh?.client?.inject?.includes(service)) failures.push(`missing DSH client injection: ${service}`)
}
if (!pkg.repository?.url?.includes('longmiaoo/dsh-native-browser')) failures.push('repository URL must target longmiaoo/dsh-native-browser')

for (const keyword of requiredKeywords) {
  if (!pkg.keywords?.includes(keyword)) failures.push(`missing discovery keyword: ${keyword}`)
}

for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'LICENSE']) {
  try {
    await access(path.join(root, file))
  } catch {
    failures.push(`missing package file: ${file}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`)
  process.exitCode = 1
} else {
  console.log('Metadata is internally consistent and DSH-discoverable.')
}
