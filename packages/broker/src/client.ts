import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { RpcPeer } from '../../transport-native/src/rpc.js';
import { localState } from './local-state.js';
import { acceptWelcome, clientRequirements, wireVersion } from '../../contracts/src/wire.js';

export async function connectBroker(directory: string, journalKey = randomBytes(32).toString('hex')): Promise<RpcPeer> {
  const state = await localState(directory);
  const socket = net.createConnection(state.socket);
  const timer = setTimeout(() => socket.destroy(new Error('Broker connection timed out')), 3000);
  try { await once(socket, 'connect'); } finally { clearTimeout(timer); }
  const peer = new RpcPeer(socket, socket);
  try {
    acceptWelcome(await peer.call('hello', { bootstrap: 1, versions: [wireVersion], token: state.token,
      role: 'client', journalKey, requiredCapabilities: [...clientRequirements] }), clientRequirements);
    return peer;
  } catch (error) { peer.close(); throw error; }
}
