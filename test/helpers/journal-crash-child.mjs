import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { FileActionJournal } from '../../dist/packages/broker/src/action-journal.js';
import { BrowserRuntime } from '../../dist/packages/runtime-core/src/runtime.js';
import { FakeProvider } from './fake-provider.mjs';
const [directory, secret] = process.argv.slice(2);
const journal = await FileActionJournal.open(directory, secret);
const runtime = new BrowserRuntime(async () => true, undefined, journal), provider = new FakeProvider();
runtime.register(provider);
const lease = await runtime.claim('old-owner', 'fake-1', 'tab-1', new AbortController().signal);
const request = { requestId: 'crash-once', leaseId: lease.id, documentEpoch: 'doc-1', action: { kind: 'fill', ref: 'node-1', text: 'private input' } };
provider.act = async (_lease, _request, execution) => {
  execution.onDispatch();
  await appendFile(path.join(directory, 'effects'), 'effect\n');
  process.send({ type: 'effect', request });
  return new Promise(() => {}); // Killed by the parent before a terminal journal record can be written.
};
await runtime.act('old-owner', request, new AbortController().signal, 'private-recovery-scope');
