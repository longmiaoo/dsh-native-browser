import net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { BrowserError, originOf, type BrowserInstance } from '../../contracts/src/index.js';
import { actionRequest, batchRequest, observeOptions, pageReadOptions, record, string } from '../../contracts/src/validation.js';
import { BrowserRuntime } from '../../runtime-core/src/runtime.js';
import { ChromiumProvider } from '../../provider-chromium/src/provider.js';
import { RpcPeer } from '../../transport-native/src/rpc.js';
import { localState } from './local-state.js';
import { FileActionJournal } from './action-journal.js';
import { acquireBrokerOwnership, type BrokerOwnership } from './ownership.js';
import { negotiateHello, brokerCapabilities, personalBrokerCapability, wireVersion } from '../../contracts/src/wire.js';

function authenticate(supplied: unknown, actual: string): void {
  if (typeof supplied !== 'string' || supplied.length !== actual.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(actual))) throw new BrowserError('POLICY_DENIED', 'Authentication failed');
}
function instanceOf(raw: unknown): BrowserInstance {
  const v = record(raw);
  if (v.family !== 'chromium') throw new BrowserError('UNSUPPORTED_CAPABILITY', 'This bridge supports Chromium only');
  return { id: string(v.id), family: 'chromium', brand: string(v.brand), version: string(v.version),
    profileLabel: string(v.profileLabel), capabilities: { ax: true, axSubtree: true, dom: true, screenshot: true,
      keyboard: true, keyboardShortcuts: false, domScroll: true, wheel: true, setChecked: true, contenteditableFill: true, appendText: true, stateExpectations: true, batch: true, pageWindows: true, tabScopedNavigation: true, frameDiscovery: true, sameOriginFrameRead: true, sameOriginFrameClick: true, sameOriginFrameQuery: true, sameOriginFrameSubtree: true, sameOriginFramePage: true, oopif: false } };
}

type BrokerOptions = { directory: string; allowedOrigins: string[]; accessMode?: 'restricted' | 'personal'; maxConnections?: number };
export async function startBroker(options: BrokerOptions) {
  options = { ...options, directory: path.resolve(options.directory) };
  if (options.accessMode !== undefined && options.accessMode !== 'restricted' && options.accessMode !== 'personal') {
    throw new BrowserError('INVALID_REQUEST', 'Invalid Broker access mode');
  }
  if (options.accessMode === 'personal' && options.allowedOrigins.length !== 0) {
    throw new BrowserError('INVALID_REQUEST', 'Personal access mode cannot be combined with exact origin allowlists');
  }
  const maxConnections = options.maxConnections ?? 64;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 256) {
    throw new BrowserError('INVALID_REQUEST', 'Invalid connection limit');
  }
  const allowed = new Set(options.allowedOrigins.map(originOf));
  const ownership = await acquireBrokerOwnership(options.directory);
  try { return await startOwnedBroker(options, allowed, ownership); }
  catch (error) { ownership.close(); throw error; }
}

async function startOwnedBroker(options: BrokerOptions, allowed: Set<string>, ownership: BrokerOwnership) {
  const personal = options.accessMode === 'personal';
  const state = await localState(options.directory, true);
  const recoveredSocket = await ownership.prepareSocket(state.socket);
  let runtime: BrowserRuntime;
  let journal: FileActionJournal;
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const peers = new Set<RpcPeer>();
  let stopping = false;
  const server = net.createServer(socket => {
    // Reject before allocating a decoder, timers, pending RPCs or handshake state.
    if (stopping || peers.size >= (options.maxConnections ?? 64)) { socket.destroy(); return; }
    const peer = new RpcPeer(socket, socket);
    peers.add(peer);
    const connection = randomUUID();
    let journalKey: string = connection; // Legacy peers receive connection-local recovery isolation only.
    let role: 'client' | 'provider' | undefined;
    let instanceId: string | undefined;
    let negotiating = false;
    let unsubscribeRevocations: (() => void) | undefined;
    const helloTimer = setTimeout(() => peer.close(), 3000); helloTimer.unref();
    peer.onCloseEvent(() => {
      unsubscribeRevocations?.();
      clearTimeout(helloTimer); peers.delete(peer);
      if (instanceId) void runtime?.disconnect(instanceId);
      void runtime?.releaseScope(connection);
    });
    peer.handle(async (method, params, signal) => {
      await ready;
      if (signal.aborted) throw new BrowserError('CANCELLED', 'Connection closed during Broker startup');
      const p = record(params);
      if (!role) {
        if (method !== 'hello' || negotiating) throw new BrowserError('POLICY_DENIED', 'Handshake required');
        negotiating = true;
        try {
          authenticate(p.token, state.token);
          negotiateHello(p);
          if (p.role === 'provider') {
            const instance = instanceOf(p.instance);
            runtime.register(new ChromiumProvider(instance, peer));
            instanceId = instance.id; role = 'provider';
          } else if (p.role === 'client') {
            if (p.journalKey !== undefined) {
              if (typeof p.journalKey !== 'string' || !/^[a-f0-9]{64}$/.test(p.journalKey)) throw new BrowserError('INVALID_REQUEST', 'Invalid journal recovery capability');
              journalKey = p.journalKey;
            }
            unsubscribeRevocations = runtime.onLeaseRevoked(event => {
              if (event.scope !== connection) return;
              // Owner is minted here as [connection, wire Session ID]. Neither
              // another connection nor another Session receives this metadata.
              const [ownerConnection, sessionId] = JSON.parse(event.owner) as [string, string];
              if (ownerConnection !== connection) return;
              peer.event('browser.lease-revoked', { sessionId, leaseId: event.leaseId });
            });
            role = 'client';
          }
          else throw new BrowserError('INVALID_REQUEST', 'Invalid peer role');
          clearTimeout(helloTimer);
          return { version: wireVersion, connectionEpoch: connection,
            capabilities: [...brokerCapabilities, ...(personal ? [personalBrokerCapability] : [])] };
        } finally { negotiating = false; }
      }
      if (role !== 'client') throw new BrowserError('POLICY_DENIED', 'Provider cannot issue runtime commands');
      if (method === 'browser.instances') return runtime.instances();
      const owner = JSON.stringify([connection, string(p.sessionId)]);
      if (method === 'browser.tabs') return (await runtime.listTabs(string(p.instanceId), signal))
        .filter(tab => { try { return personal || allowed.has(originOf(tab.url)); } catch { return false; } });
      if (method === 'browser.claim') {
        return runtime.claim(owner, string(p.instanceId), string(p.tab), signal, connection);
      }
      if (method === 'browser.observe') return runtime.observe(owner, string(p.leaseId), signal, observeOptions(p));
      if (method === 'browser.readPage') return runtime.readPage(owner, string(p.leaseId), pageReadOptions(p.options), signal);
      if (method === 'browser.frames') return runtime.frames(owner, string(p.leaseId), signal);
      if (method === 'browser.capture') return runtime.capture(owner, string(p.leaseId), signal);
      if (method === 'browser.validateLease') return runtime.validateLease(owner, string(p.leaseId), signal);
      if (method === 'browser.act') return runtime.act(owner, actionRequest(p.request), signal, JSON.stringify([journalKey, string(p.sessionId)]));
      if (method === 'browser.batch') {
        const request = batchRequest(p.request), approvalId = string(p.approvalId, 128);
        return runtime.batch(owner, request, signal, async (index, stepSignal) => {
          const result = await peer.call('browser.approveBatchStep', { approvalId, index }, stepSignal);
          return record(result).allowed === true;
        }, JSON.stringify([journalKey, string(p.sessionId)]));
      }
      if (method === 'browser.release') {
        const id = string(p.leaseId);
        await runtime.release(owner, id);
        return { released: true };
      }
      if (method === 'browser.releaseSession') { await runtime.releaseOwner(owner); return { released: true }; }
      throw new BrowserError('INVALID_REQUEST', 'Unknown runtime method');
    });
    peer.onEvent((event, value) => {
      if (role !== 'provider' || event !== 'lease.revoked') return;
      const id = string(record(value).leaseId);
      if (instanceId) void runtime.providerRevoked(instanceId, id).catch(() => {});
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(state.socket, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    await chmod(state.socket, 0o600);
    // Both process-lifetime ownership and a bound socket precede journal recovery or writes.
    journal = await FileActionJournal.open(options.directory, state.token);
    runtime = new BrowserRuntime(async request => personal || allowed.has(originOf(request.tab.url)), undefined, journal,
      { leaseScope: personal ? 'tab' : 'origin' });
    markReady();
  } catch (error) {
    for (const peer of peers) peer.close();
    markReady();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { socket: state.socket, runtime, recoveredSocket,
    resourceUsage: () => ({ connections: peers.size, ...runtime.resourceUsage() }), close() {
    closing ??= (async () => {
      stopping = true;
      for (const peer of peers) peer.close();
      try { await runtime.dispose(); await journal.close(); }
      finally {
        try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { ownership.close(); }
      }
    })();
    return closing;
  } };
}
