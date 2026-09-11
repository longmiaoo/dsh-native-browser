import { BrowserError, checkAbort } from '../../dist/packages/contracts/src/index.js';

export class FakeProvider {
  instance = { id: 'fake-1', family: 'other', brand: 'fake', version: '1', profileLabel: 'test', capabilities: { ax: true } };
  tab = { id: 'tab-1', instanceId: 'fake-1', url: 'https://example.test/form', title: 'Fixture' };
  nodes = [{ id: 'node-1', role: 'textbox', name: 'Name', value: '' }];
  epoch = 'doc-1';
  revision = 1;
  grants = new Map();
  calls = [];
  delay = 0;
  failAfterDispatch = false;
  postcondition = 'passed';
  async listTabs(signal) { checkAbort(signal); return [structuredClone(this.tab)]; }
  async grant(lease, signal) { checkAbort(signal); this.grants.set(lease.tab, lease.token); }
  async revoke(lease) { if (this.grants.get(lease.tab) === lease.token) this.grants.delete(lease.tab); }
  async observe(lease, signal) {
    checkAbort(signal);
    if (this.grants.get(lease.tab) !== lease.token) throw new BrowserError('LEASE_REVOKED', 'stale');
    return { tab: lease.tab, url: this.tab.url, title: this.tab.title, documentEpoch: this.epoch,
      revision: this.revision++, nodes: structuredClone(this.nodes), text: ['Fixture'], truncated: false };
  }
  async act(lease, request, execution) {
    if (this.delay) await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(execution.signal.reason); };
      const timer = setTimeout(() => { execution.signal.removeEventListener('abort', abort); resolve(); }, this.delay);
      execution.signal.addEventListener('abort', abort, { once: true });
      if (execution.signal.aborted) abort();
    });
    checkAbort(execution.signal);
    if (this.epoch !== request.documentEpoch) throw new BrowserError('STALE_TARGET', 'stale document');
    if (this.grants.get(lease.tab) !== lease.token) throw new BrowserError('LEASE_REVOKED', 'stale lease');
    execution.onDispatch();
    this.calls.push(structuredClone(request.action));
    if (this.failAfterDispatch) throw new BrowserError('CONNECTION_LOST', 'ack lost');
    if (request.action.kind === 'fill') this.nodes[0].value = request.action.text;
    return { observation: await this.observe(lease, execution.signal), postcondition: this.postcondition };
  }
}
