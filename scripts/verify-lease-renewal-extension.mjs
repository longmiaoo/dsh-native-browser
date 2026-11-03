import assert from 'node:assert/strict';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';

// Accelerated lease lifetime; real production MV3 grant, renew, input and Stop.
export async function verifyLeaseRenewalExtension({ provider, channel, page, popup }) {
  const runtime = new BrowserRuntime(async () => true, { leaseMs: 2000 });
  runtime.register(provider);
  const unsubscribe = channel.onEvent((event, value) => {
    if (event === 'lease.revoked') void runtime.providerRevoked(provider.instance.id, value.leaseId).catch(() => {});
  });
  const owner = 'renewal-smoke', signal = AbortSignal.timeout(15000);
  try {
    const [tab] = await runtime.listTabs(provider.instance.id, signal);
    let lease = await runtime.claim(owner, provider.instance.id, tab.id, signal);
    const firstDeadline = lease.expiresAt;
    const before = await runtime.observe(owner, lease.id, signal);
    const field = before.nodes.find(n => n.name === '搜索词'); assert.ok(field);
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const next = await runtime.renew(owner, lease.id, signal);
      assert.equal(next.token, lease.token); assert.equal(next.id, lease.id);
      assert.ok(next.expiresAt > lease.expiresAt); lease = next;
    }
    assert.ok(Date.now() > firstDeadline, 'Cross the real original deadline');
    assert.equal(await page.locator('[data-dsh-activity="v1"]').count(), 1, 'Feedback survives the original deadline');
    const result = await runtime.act(owner, { requestId: 'after-renewal', leaseId: lease.id,
      documentEpoch: before.documentEpoch, action: { kind: 'fill', ref: field.id, text: '续期后只输入一次' } }, signal);
    assert.equal(result.outcome, 'succeeded'); assert.equal(await page.locator('#query').inputValue(), '续期后只输入一次');
    await page.waitForFunction(() => document.querySelector('[data-dsh-pointer="v1"]'));
    await popup.evaluate(() => chrome.runtime.sendMessage({ command: 'stop' }));
    const stoppedBy = Date.now() + 2000;
    while (runtime.resourceUsage().leases && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(runtime.renew(owner, lease.id, signal), { code: 'LEASE_REVOKED' });
    await page.waitForFunction(() => !document.querySelector('[data-dsh-pointer="v1"], [data-dsh-activity="v1"]'));
    await popup.evaluate(() => chrome.runtime.sendMessage({ command: 'allow' }));
    return ['Renewal keeps original token and refs beyond an accelerated real deadline',
      'Activity and pointer survive renewal; Stop removes both and cannot be renewed'];
  } finally { unsubscribe(); await runtime.dispose(); }
}
