import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// The actual host SDK, not a fake ctx.get()/SlotCore fixture. In real cold boot,
// main is declared before the Layout provider becomes visible to optional lookup.
test('browser setup survives real Cordis cold boot, warm boot and Layout reactivation', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/verify-setup-lifecycle.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'), timeout: 15000, maxBuffer: 64000,
  });
  assert.match(stdout, /Actual Cordis \+ SlotRegistry: cold\/warm boot, Layout reactivation and plugin disposal passed/);
});
