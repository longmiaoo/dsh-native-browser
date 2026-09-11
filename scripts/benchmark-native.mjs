import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { benchmarkCases } from './benchmark/cases.mjs';
import { runCases, failureCode } from './benchmark/stats.mjs';
import { nativeAdapter } from './benchmark/native-adapter.mjs';

const [hostRoot, ...args] = process.argv.slice(2), executablePath = process.env.DSH_CHROME_TEST_EXECUTABLE;
if (!hostRoot || !executablePath) throw new Error('Set DSH_CHROME_TEST_EXECUTABLE and pass the installed DSH package directory');
const config = { samples: 5, warmups: 1, seed: 1729 };
for (const arg of args) {
  const match = /^--(samples|warmups|seed)=(\d+)$/.exec(arg);
  if (!match) throw new Error('Use --samples=N --warmups=N --seed=N'); config[match[1]] = Number(match[2]);
}
if (!Number.isInteger(config.samples) || config.samples < 1 || config.samples > 50 || !Number.isInteger(config.warmups) || config.warmups < 0 || config.warmups > 5
  || !Number.isInteger(config.seed) || config.seed < 1 || config.seed > 0xffffffff) throw new Error('Invalid benchmark sample/warmup/seed bounds');
const root = path.resolve(import.meta.dirname, '..');
const hash = createHash('sha256');
async function fingerprint(directory) {
  for (const entry of (await readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) await fingerprint(name);
    else if (/\.(ts|mjs|html)$/.test(name)) { hash.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0'); }
  }
}
for (const directory of ['packages', 'scripts', 'test/fixtures']) await fingerprint(directory);
for (const name of ['package.json', 'pnpm-lock.yaml', 'index.js', 'bin/dsh-native-browser.mjs', 'cordis.patch.yml']) hash.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0');
const html = await readFile(path.join(root, 'test/fixtures/benchmark.html'));
const report = { version: 1, startedAt: new Date().toISOString(), config,
  scope: { level: 'L1', path: 'DSH ToolRuntime -> Unix Broker -> Chrome-started Native Host -> MV3 -> Chrome',
    profile: 'isolated headless Chrome for Testing', connection: 'warm connection; fresh fixture document and lease per sample',
    model: null, codexComparison: false, approvals: 'deterministic allowed-once test service',
    deadlinesMs: { action: 3000, hostTool: 6000, page: 6000, run: 600000 },
    taskTiming: 'run + independent oracle; excludes fixture reset, claim and discovery/setup',
    toolTiming: 'DSH execute call through result return; does not include browser bootstrap or human/model latency',
    responseBytes: 'JSON tool result bytes; excludes image attachment file bytes and actual IPC/wire framing',
    quantiles: 'p50 median; p95 nearest rank, thus maximum for five samples; failures/timeouts retained when timed',
    limitations: ['No per-stage production spans or pure RPC RTT', 'No model, Codex, regular signed-in profile, or real-site comparison',
      'No iframe/OOPIF, multi-tab, IME, upload/download/dialog, disconnect/Stop timing or soak baseline',
      'Small sample size; shared-machine load is not controlled; advisory data, not a release/SLA gate'] },
  environment: { os: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), loadAverageAtStart: os.loadavg(), node: process.version,
    packageVersion: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    sourceSha256: hash.digest('hex'), fixtureSha256: createHash('sha256').update(html).digest('hex') },
  status: 'incomplete', fatal: null, cleanup: null, results: null };
const controller = new AbortController(), stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
let adapter;
try {
  adapter = await nativeAdapter({ hostRoot, executablePath, html, signal });
  report.environment.browserVersion = adapter.browserVersion; report.environment.dshVersion = adapter.dshVersion;
  report.results = await runCases({ cases: benchmarkCases, ...config, adapter, signal,
    progress: row => console.error(`${row.phase} ${row.round} ${row.taskId}: ${row.status}`) });
  const all = report.results.rows;
  report.status = all.some(r => r.status === 'not-run') ? 'incomplete' : all.some(r => r.status === 'failed') ? 'failed' : 'passed';
} catch (error) { report.fatal = failureCode(error); }
finally {
  report.cleanup = adapter ? await adapter.close() : { complete: false, failed: ['startup-not-completed'] };
  if (!report.cleanup.complete) report.status = 'incomplete';
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  const output = await mkdtemp(path.join(root, 'output/playwright/native-benchmark-'));
  const file = path.join(output, 'report.json'); await writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, status: report.status, measured: report.results?.measured, cleanup: report.cleanup }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
