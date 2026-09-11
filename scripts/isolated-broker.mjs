import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Owns only the child started here. Callers supply their freshly-created private test directory.
export async function startIsolatedBroker({ directory, allowedOrigins }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/dsh-native-browser.mjs', import.meta.url)),
    'broker', `--runtime-dir=${directory}`, ...allowedOrigins.map(origin => `--allow-origin=${origin}`)],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', stopResult;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ error }));
  });
  const stop = signal => {
    stopResult ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      child.kill(signal);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { return await exited; } finally { clearTimeout(timeout); }
    })();
    return stopResult;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Broker startup timeout: ${stderr}`)), 5000);
      child.stderr.on('data', data => {
        stderr = (stderr + data).slice(-8192);
        if (stderr.includes('DSH Browser Broker listening at ')) { clearTimeout(timer); resolve(); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Broker exited: ${stderr}`)); });
    });
    return { recoveredSocket: stderr.includes('; recovered stale socket'), close: () => stop('SIGTERM'), kill: () => stop('SIGKILL') };
  } catch (error) { await stop('SIGKILL'); throw error; }
}
