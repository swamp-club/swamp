// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type { RpcTransport } from "./rpc_channel.ts";

const HEADER_SIZE = 4;
const MAX_FRAME_SIZE = 64 * 1024 * 1024; // 64 MiB

/**
 * Length-prefixed RPC transport over stdin/stdout. Each frame is a 4-byte
 * big-endian length followed by the UTF-8 JSON payload. This avoids
 * newline-based framing which breaks when JSON payloads contain newlines.
 */
export class StdioTransport implements RpcTransport {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder = new TextEncoder();

  constructor(stdout: WritableStream<Uint8Array>) {
    this.#writer = stdout.getWriter();
  }

  send(data: string): void {
    const payload = this.#encoder.encode(data);
    const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength);
    frame.set(payload, HEADER_SIZE);
    this.#writer.write(frame).catch(() => {});
  }

  async close(): Promise<void> {
    try {
      await this.#writer.close();
    } catch {
      // Already closed or released.
    }
  }
}

/**
 * Read length-prefixed frames from a readable byte stream. Calls `onFrame`
 * for each complete frame, `onClose` when the stream ends. Handles partial
 * reads: a frame header or payload may be split across multiple chunks.
 */
export async function createStdioReader(
  stdin: ReadableStream<Uint8Array>,
  onFrame: (data: string) => void,
  onClose: () => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stdin.getReader();
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = concatBuffers(buffer, new Uint8Array(value));

      while (buffer.byteLength >= HEADER_SIZE) {
        const view = new DataView(
          buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + HEADER_SIZE,
          ),
        );
        const payloadLength = view.getUint32(0);

        if (payloadLength > MAX_FRAME_SIZE) {
          throw new Error(
            `Frame too large: ${payloadLength} bytes exceeds ${MAX_FRAME_SIZE} byte limit`,
          );
        }

        const frameSize = HEADER_SIZE + payloadLength;
        if (buffer.byteLength < frameSize) break;

        const payload = buffer.subarray(HEADER_SIZE, frameSize);
        onFrame(decoder.decode(payload));

        buffer = buffer.byteLength > frameSize
          ? new Uint8Array(buffer.subarray(frameSize))
          : new Uint8Array(0);
      }
    }
  } finally {
    reader.releaseLock();
    onClose();
  }
}

function concatBuffers(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  if (a.byteLength === 0) return b;
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}
