import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { RpcPeer } from '../../transport-native/src/rpc.js';
import { localState } from './local-state.js';
import { acceptWelcome, clientRequirements, personalBrokerCapability, wireVersion } from '../../contracts/src/wire.js';
import { BrowserError } from '../../contracts/src/index.js';

export type BrokerConnection = RpcPeer & { readonly brokerCapabilities: readonly string[] };
export async function connectBroker(directory: string, journalKey = randomBytes(32).toString('hex'), options: { requirePersonal?: boolean } = {}): Promise<BrokerConnection> {
  const state = await localState(directory);
  const socket = net.createConnection(state.socket);
  const timer = setTimeout(() => socket.destroy(new Error('Broker connection timed out')), 3000);
  try { await once(socket, 'connect'); } finally { clearTimeout(timer); }
  const peer = new RpcPeer(socket, socket);
  try {
    const welcome = acceptWelcome(await peer.call('hello', { bootstrap: 1, versions: [wireVersion], token: state.token,
      role: 'client', journalKey, requiredCapabilities: [...clientRequirements] }), clientRequirements);
    // Reject mode mismatches before opening tabs, claiming leases or sending any
    // browser command. A reconnect must negotiate the same capability again.
    if (options.requirePersonal && !welcome.capabilities.includes(personalBrokerCapability)) {
      throw new BrowserError('POLICY_DENIED', 'Personal approval mode requires a Broker started with --access-mode=personal. Complete browser setup, or explicitly select per-action/per-lease for a restricted Broker.');
    }
    Object.defineProperty(peer, 'brokerCapabilities', { value: Object.freeze([...welcome.capabilities]) });
    return peer as BrokerConnection;
  } catch (error) { peer.close(); throw error; }
}
