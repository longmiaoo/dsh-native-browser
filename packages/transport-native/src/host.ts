import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserError } from '../../contracts/src/index.js';
import { record } from '../../contracts/src/validation.js';
import { localState } from '../../broker/src/local-state.js';
import { FrameDecoder, encodeFrame } from './framing.js';
import { helloSchema, matchesWireSchema, wireMessage } from '../../contracts/src/wire.js';

/** Chrome owns process startup; this process forwards only, never writes logs to stdout. */
export async function runNativeHost(directory: string, callerOrigin: string): Promise<void> {
  const state = await localState(directory);
  const config = JSON.parse(await readFile(path.join(directory, 'native-host.json'), 'utf8'));
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.includes(callerOrigin)) {
    throw new BrowserError('POLICY_DENIED', 'Native host caller is not installed');
  }
  const socket = net.createConnection(state.socket);
  const timeout = setTimeout(() => socket.destroy(new Error('Broker unavailable')), 3000);
  try { await once(socket, 'connect'); } finally { clearTimeout(timeout); }
  let first = true;
  const decoder = new FrameDecoder(raw => {
    const message = wireMessage(raw);
    if (first) {
      if (message.type !== 'request' || message.method !== 'hello') {
        throw new BrowserError('POLICY_DENIED', 'Provider handshake required');
      }
      const params = record(message.params);
      if (!matchesWireSchema(helloSchema, params) || params.role !== 'provider') throw new BrowserError('POLICY_DENIED', 'Provider handshake required');
      first = false;
      params.token = state.token; // Token stays in local IPC, never in the extension package.
    }
    if (!socket.write(encodeFrame(message))) process.stdin.pause();
  });
  socket.on('drain', () => process.stdin.resume());
  socket.pipe(process.stdout);
  const input = (chunk: Buffer) => { try { decoder.push(chunk); } catch { socket.destroy(); } };
  process.stdin.on('data', input);
  process.stdin.once('end', () => socket.end());
  process.stdin.once('error', () => socket.destroy());
  await new Promise<void>(resolve => { socket.once('close', resolve); socket.on('error', () => {}); });
  process.stdin.removeListener('data', input);
  process.stdin.pause();
}
