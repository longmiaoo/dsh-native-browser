import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { startBroker } from '../../dist/packages/broker/src/server.js';
import { FakeProvider } from './fake-provider.mjs';
const [directory, mode = 'idle'] = process.argv.slice(2);
try {
  const broker = await startBroker({ directory, allowedOrigins: ['https://example.test'] });
  const provider = new FakeProvider();
  if (mode === 'interrupt-effect') provider.act = async (_lease, request, execution) => {
    execution.onDispatch();
    await appendFile(path.join(directory, 'effects'), 'effect\n');
    process.send({ type: 'effect', request });
    return new Promise(() => {}); // Parent kills this process before the acknowledgement.
  };
  broker.runtime.register(provider);
  process.send({ type: 'ready', recoveredSocket: broker.recoveredSocket });
  process.once('SIGTERM', () => { void broker.close().then(() => process.disconnect()); });
} catch (error) {
  process.send({ type: 'failed', code: error.code }); process.disconnect();
}
