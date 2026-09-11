import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { BrowserError, checkAbort, errorCode } from '../../contracts/src/index.js';
import { wireMessage } from '../../contracts/src/wire.js';
import { encodeFrame, FrameDecoder } from './framing.js';

type Pending = { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };
export type Handler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;

export class RpcPeer {
  private readonly pending = new Map<string, Pending>();
  private readonly executing = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(event: string, value: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private handler?: Handler;
  private readonly decoder: FrameDecoder;

  constructor(private readonly input: Readable, private readonly output: Writable,
    private readonly maxPending = 32) {
    this.decoder = new FrameDecoder(value => this.receive(value));
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('close', this.onClose);
    input.once('error', this.onClose);
    output.once('error', this.onClose);
  }
  private readonly onData = (data: Buffer) => { try { this.decoder.push(data); } catch { this.close(); } };
  private readonly onEnd = () => { try { this.decoder.finish(); } catch { /* partial frame closes the peer */ } finally { this.close(); } };
  private readonly onClose = () => { this.close(); };

  handle(handler: Handler): void { this.handler = handler; }
  onEvent(listener: (event: string, value: unknown) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  onCloseEvent(listener: () => void): () => void {
    this.closeListeners.add(listener); return () => this.closeListeners.delete(listener);
  }

  private send(message: unknown): void {
    if (this.closed) throw new BrowserError('CONNECTION_LOST', 'Peer is closed');
    // Bound buffered writes. No unlimited screenshot queue on the control pipe.
    if (this.output.writableLength > 2 * 1024 * 1024) {
      this.close(); throw new BrowserError('QUEUE_FULL', 'Transport write budget exceeded');
    }
    this.output.write(encodeFrame(wireMessage(message)));
  }
  event(event: string, value: unknown): void { this.send({ type: 'event', event, value: value ?? null }); }

  call(method: string, params: unknown, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<unknown> {
    checkAbort(signal);
    if (this.closed) return Promise.reject(new BrowserError('CONNECTION_LOST', 'Peer is closed'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new BrowserError('QUEUE_FULL', 'Too many in-flight requests'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id); cleanup();
        try { this.send({ type: 'cancel', id }); } catch { /* close already rejects other pending calls */ }
        reject(signal.reason instanceof BrowserError ? signal.reason :
          new BrowserError('CANCELLED', 'RPC cancelled; a dispatched side effect may already have occurred'));
      };
      const cleanup = () => signal.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      try { this.send({ type: 'request', id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  private receive(raw: unknown): void {
    const m = wireMessage(raw);
    if (m.type === 'event') {
      for (const listener of this.listeners) listener(m.event, m.value);
      return;
    }
    if (m.type === 'response') {
      const pending = this.pending.get(m.id);
      if (!pending) return; // Late response after cancellation: never resurrect its caller.
      this.pending.delete(m.id); pending.cleanup();
      if (m.ok === true) pending.resolve(m.value);
      else pending.reject(new BrowserError(m.code, 'Remote operation failed'));
    } else if (m.type === 'cancel') {
      this.executing.get(m.id)?.abort(new BrowserError('CANCELLED', 'Peer cancelled operation'));
    } else if (m.type === 'request') {
      if (this.seen.has(m.id)) throw new Error('Duplicate transport request ID');
      if (this.seen.size >= 10_000) { this.close(); return; }
      this.seen.add(m.id);
      if (this.executing.size >= this.maxPending) {
        this.send({ type: 'response', id: m.id, ok: false, code: 'QUEUE_FULL' }); return;
      }
      const controller = new AbortController();
      this.executing.set(m.id, controller);
      void this.run(m.id, m.method, m.params, controller);
    } else throw new Error('Invalid RPC message type');
  }

  private async run(id: string, method: string, params: unknown, controller: AbortController): Promise<void> {
    try {
      if (!this.handler) throw new BrowserError('INVALID_REQUEST', 'No request handler');
      const value = await this.handler(method, params, controller.signal);
      checkAbort(controller.signal);
      if (!this.closed) this.send({ type: 'response', id, ok: true, value: value ?? null });
    } catch (error) {
      if (!this.closed) {
        try { this.send({ type: 'response', id, ok: false, code: errorCode(error) }); } catch { this.close(); }
      }
    } finally { this.executing.delete(id); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { p.cleanup(); p.reject(new BrowserError('CONNECTION_LOST', 'Peer disconnected')); }
    this.pending.clear();
    for (const controller of this.executing.values()) controller.abort(new BrowserError('CONNECTION_LOST', 'Peer disconnected'));
    for (const listener of this.closeListeners) { try { listener(); } catch { /* teardown must continue */ } }
    this.closeListeners.clear(); this.listeners.clear();
    this.input.removeListener('data', this.onData);
    this.input.destroy();
    this.output.destroy();
  }
}
