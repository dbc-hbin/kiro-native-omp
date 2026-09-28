import type { JsonRecord } from "./types";

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

const MIN_FRAME = 16;
const MAX_FRAME = 16 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function crc32(bytes: Uint8Array): number {
  return Bun.hash.crc32(bytes) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function encodeHeader(name: string, value: string): Uint8Array {
  const n = textEncoder.encode(name);
  const v = textEncoder.encode(value);
  if (n.length > 255 || v.length > 65_535) throw new Error("eventstream header too large");
  return concat([Uint8Array.of(n.length), n, Uint8Array.of(7), u16(v.length), v]);
}

export function encodeEventFrame(eventType: string, payload: JsonRecord, messageType = "event"): Uint8Array {
  const headers = concat([
    encodeHeader(":message-type", messageType),
    encodeHeader(":event-type", eventType),
    encodeHeader(":content-type", "application/json"),
  ]);
  const body = textEncoder.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const prelude = concat([u32(total), u32(headers.length)]);
  const preludeWithCrc = concat([prelude, u32(crc32(prelude))]);
  const withoutMessageCrc = concat([preludeWithCrc, headers, body]);
  return concat([withoutMessageCrc, u32(crc32(withoutMessageCrc))]);
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (p < buf.length) {
    const nameLen = view.getUint8(p++);
    if (p + nameLen + 3 > buf.length) throw new Error("eventstream truncated header");
    const name = textDecoder.decode(buf.subarray(p, p + nameLen));
    p += nameLen;
    const type = view.getUint8(p++);
    if (type !== 7) throw new Error(`eventstream only supports string headers, got ${type}`);
    const len = view.getUint16(p, false);
    p += 2;
    if (p + len > buf.length) throw new Error("eventstream truncated header value");
    out[name] = textDecoder.decode(buf.subarray(p, p + len));
    p += len;
  }
  return out;
}

function decodeFrame(frame: Uint8Array): EventStreamMessage {
  if (frame.length < MIN_FRAME) throw new Error("eventstream frame too short");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const total = view.getUint32(0, false);
  const headerLength = view.getUint32(4, false);
  if (total !== frame.length) throw new Error("eventstream length mismatch");
  if (headerLength > total - MIN_FRAME) throw new Error("eventstream invalid header length");
  if (view.getUint32(8, false) !== crc32(frame.subarray(0, 8))) throw new Error("eventstream prelude CRC mismatch");
  if (view.getUint32(total - 4, false) !== crc32(frame.subarray(0, total - 4))) throw new Error("eventstream message CRC mismatch");
  const headers = parseHeaders(frame.subarray(12, 12 + headerLength));
  return { headers, payload: frame.subarray(12 + headerLength, total - 4) };
}

export async function* decodeEventStream(source: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  const reader = source.getReader();
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value?.length) buf = concat([buf, value]);
      let offset = 0;
      while (buf.length - offset >= 4) {
        const total = new DataView(buf.buffer, buf.byteOffset + offset, buf.byteLength - offset).getUint32(0, false);
        if (total < MIN_FRAME) throw new Error(`eventstream invalid frame length ${total}`);
        if (total > MAX_FRAME) throw new Error(`eventstream frame exceeds ${MAX_FRAME} bytes`);
        if (buf.length - offset < total) break;
        yield decodeFrame(buf.subarray(offset, offset + total));
        offset += total;
      }
      if (offset) buf = buf.slice(offset);
      if (done) break;
    }
    if (buf.length) throw new Error("eventstream truncated message at end of stream");
  } finally {
    reader.releaseLock();
  }
}

export function framesToChunkedResponse(frames: readonly Uint8Array[]): Response {
  const bytes = concat([...frames]);
  const sizes = [7, 13, 5, 29, 3, 47];
  let offset = 0;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const size = sizes[index++ % sizes.length];
      const end = Math.min(bytes.length, offset + size);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
}
