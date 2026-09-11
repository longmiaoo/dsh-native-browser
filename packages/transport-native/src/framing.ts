import { endianness } from 'node:os';
import { BrowserError } from '../../contracts/src/index.js';

export const MAX_FRAME_BYTES = 1024 * 1024 - 1;
const littleEndian = endianness() === 'LE';

export function encodeFrame(value: unknown, maxBytes = MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (!payload.length || payload.length > maxBytes) throw new BrowserError('INVALID_REQUEST', 'Message exceeds frame budget');
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(payload.length); else header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder: validates length before allocating the payload. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerOffset = 0;
  private payload: Buffer | undefined;
  private offset = 0;
  private failed = false;
  constructor(private readonly onMessage: (message: unknown) => void, private readonly maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): void {
    if (this.failed) throw new BrowserError('INVALID_REQUEST', 'Decoder is closed after malformed input');
    let position = 0;
    try {
      while (position < chunk.length) {
        if (!this.payload) {
          const count = Math.min(4 - this.headerOffset, chunk.length - position);
          chunk.copy(this.header, this.headerOffset, position, position + count);
          this.headerOffset += count; position += count;
          if (this.headerOffset !== 4) continue;
          const size = littleEndian ? this.header.readUInt32LE() : this.header.readUInt32BE();
          if (size < 1 || size > this.maxBytes) throw new BrowserError('INVALID_REQUEST', 'Invalid frame length');
          this.payload = Buffer.alloc(size); this.offset = 0;
        }
        const count = Math.min(this.payload.length - this.offset, chunk.length - position);
        chunk.copy(this.payload, this.offset, position, position + count);
        this.offset += count; position += count;
        if (this.offset === this.payload.length) {
          // Fatal UTF-8 decoding rejects malformed wire text, not replacement characters.
          const text = new TextDecoder('utf-8', { fatal: true }).decode(this.payload);
          const value: unknown = JSON.parse(text);
          this.payload = undefined; this.headerOffset = 0; this.offset = 0;
          this.onMessage(value);
        }
      }
    } catch (error) { this.failed = true; this.payload = undefined; throw error; }
  }

  finish(): void {
    if (this.headerOffset || this.payload) throw new BrowserError('CONNECTION_LOST', 'Connection ended in a partial frame');
  }
}
