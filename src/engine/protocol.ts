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

import manifest from "../../packages/serve-go/protocol.json" with {
  type: "json",
};

/** Private serve-engine contract. Public domain messages remain opaque. */
export const ENGINE_PROTOCOL = manifest;
export interface EngineRequest {
  version: number;
  generation: string;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export function parseEngineRequest(value: unknown): EngineRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid engine envelope");
  }
  const v = value as Record<string, unknown>;
  if (
    v.version !== ENGINE_PROTOCOL.version ||
    typeof v.generation !== "string" || !v.generation ||
    v.generation.length > 128 ||
    typeof v.id !== "string" || !v.id || v.id.length > 128 ||
    typeof v.method !== "string" ||
    (v.params !== undefined &&
      (v.params === null || typeof v.params !== "object" ||
        Array.isArray(v.params)))
  ) throw new Error("Invalid engine envelope or incompatible protocol version");
  return v as unknown as EngineRequest;
}

/** One allocation per bounded frame, including when input arrives byte by byte. */
export async function* readEngineFrames(
  stream: ReadableStream<Uint8Array>,
  maximum = ENGINE_PROTOCOL.limits.frameBytes,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  let cancelling: Promise<void> | undefined;
  const cancel = () => {
    cancelling ??= reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const header = new Uint8Array(4);
  let target = header;
  let offset = 0;
  let payload = false;
  try {
    while (true) {
      const next = await reader.read();
      if (signal?.aborted) throw new Error("Engine input cancelled");
      if (next.done) {
        if (offset !== 0 || payload) throw new Error("Truncated engine frame");
        return;
      }
      let position = 0;
      while (position < next.value.length) {
        const count = Math.min(
          target.length - offset,
          next.value.length - position,
        );
        target.set(next.value.subarray(position, position + count), offset);
        offset += count;
        position += count;
        if (offset !== target.length) continue;
        offset = 0;
        if (!payload) {
          const length = new DataView(header.buffer).getUint32(0);
          if (length === 0 || length > maximum) {
            throw new Error("Invalid engine frame length");
          }
          target = new Uint8Array(length);
          payload = true;
        } else {
          let value: unknown;
          try {
            value = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(target),
            );
          } catch {
            throw new Error("Invalid engine frame JSON");
          }
          target = header;
          payload = false;
          yield value;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await cancelling;
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function encodeEngineFrame(
  value: unknown,
  maximum = ENGINE_PROTOCOL.limits.frameBytes,
): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (!bytes.length || bytes.length > maximum) {
    throw new Error("Engine reply exceeds frame limit");
  }
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length);
  frame.set(bytes, 4);
  return frame;
}

/** A short synchronous burst is bounded independently for each session. */
export const ENGINE_SESSION_BURST_FRAMES =
  ENGINE_PROTOCOL.limits.engineSessionFrames;
const CONTROL_BYTES = ENGINE_PROTOCOL.limits.engineControlBytes;
const CLOSE_FRAME_BYTES = ENGINE_PROTOCOL.limits.engineCloseFrameBytes;
// One session can finish opening while the previous sessions close.
const CLOSE_FRAMES = ENGINE_PROTOCOL.limits.sessions + 1;
const SESSION_BYTES = ENGINE_PROTOCOL.limits.engineSessionBytes;
// A closed session can retain only the single frame currently being written.
// Every other queued frame is released on close. No lane preallocates storage.
const SESSION_LANES = ENGINE_PROTOCOL.limits.sessions + 1;

interface PendingFrame {
  frame: Uint8Array | undefined;
  readonly bytes: number;
  readonly kind: "control" | "close" | "session";
  readonly sessionId?: string;
  writing: boolean;
}
interface SessionWrites {
  readonly entries: Set<PendingFrame>;
  bytes: number;
}

/**
 * Synchronous admission with independent session budgets and reserved control
 * and close capacity. At most sessions+1 lazy lanes retain engineSessionBytes
 * each, plus reserved control/close bytes. Only pipe failure fences the engine.
 */
export class EngineWriter {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #tail: Promise<void> = Promise.resolve();
  #failed = false;
  #frames = 0;
  #controlBytes = 0;
  #controls = 0;
  #closes = 0;
  readonly #sessions = new Map<string, SessionWrites>();
  readonly #onFailure?: () => void;
  constructor(stream: WritableStream<Uint8Array>, onFailure?: () => void) {
    this.#writer = stream.getWriter();
    this.#onFailure = onFailure;
  }
  get pending(): number {
    return this.#frames;
  }
  /** Control responses cannot compete with public event traffic for space. */
  send(value: unknown): void {
    this.#assertAvailable();
    const frame = encodeEngineFrame(value, CONTROL_BYTES - 4);
    if (
      this.#controlBytes + frame.length > CONTROL_BYTES ||
      this.#controls >= ENGINE_PROTOCOL.limits.pendingControls
    ) throw new Error("Engine control queue full");
    this.#controlBytes += frame.length;
    this.#controls++;
    this.#enqueue({
      frame,
      bytes: frame.length,
      kind: "control",
      writing: false,
    });
  }
  /** Refusal detaches this session; other sessions and accepted runs survive. */
  sendSession(sessionId: string, value: unknown): boolean {
    this.#assertAvailable();
    const frame = encodeEngineFrame(value);
    const lane = this.#sessions.get(sessionId) ?? {
      entries: new Set<PendingFrame>(),
      bytes: 0,
    };
    if (
      lane.entries.size >= ENGINE_SESSION_BURST_FRAMES ||
      lane.bytes + frame.length > SESSION_BYTES ||
      (!this.#sessions.has(sessionId) && this.#sessions.size >= SESSION_LANES)
    ) return false;
    const entry: PendingFrame = {
      frame,
      bytes: frame.length,
      kind: "session",
      sessionId,
      writing: false,
    };
    lane.entries.add(entry);
    lane.bytes += frame.length;
    this.#sessions.set(sessionId, lane);
    this.#enqueue(entry);
    return true;
  }
  /** Drop a detached lane's unsent payload and use its reserved close slot. */
  closeSession(sessionId: string, value: unknown): void {
    this.#assertAvailable();
    const lane = this.#sessions.get(sessionId);
    if (lane) {
      for (const entry of [...lane.entries]) {
        if (!entry.writing) this.#release(entry);
      }
    }
    const frame = encodeEngineFrame(value, CLOSE_FRAME_BYTES - 4);
    if (this.#closes >= CLOSE_FRAMES) {
      throw new Error("Engine close queue full");
    }
    this.#closes++;
    this.#enqueue({
      frame,
      bytes: frame.length,
      kind: "close",
      writing: false,
    });
  }
  #assertAvailable(): void {
    if (this.#failed) throw new Error("Engine output unavailable");
  }
  #enqueue(entry: PendingFrame): void {
    this.#frames++;
    this.#tail = this.#tail.then(async () => {
      if (!this.#failed && entry.frame) {
        entry.writing = true;
        await this.#writer.write(entry.frame);
      }
    }).catch(() => {
      if (!this.#failed) {
        this.#failed = true;
        this.#onFailure?.();
      }
    }).finally(() => this.#release(entry));
  }
  #release(entry: PendingFrame): void {
    if (!entry.frame) return;
    // Clearing the bytes also releases memory captured by the ordered chain.
    entry.frame = undefined;
    this.#frames--;
    if (entry.kind === "control") {
      this.#controls--;
      this.#controlBytes -= entry.bytes;
    } else if (entry.kind === "close") {
      this.#closes--;
    } else {
      const lane = this.#sessions.get(entry.sessionId!);
      lane?.entries.delete(entry);
      if (lane) {
        lane.bytes -= entry.bytes;
        if (lane.entries.size === 0) this.#sessions.delete(entry.sessionId!);
      }
    }
  }
  async flush(): Promise<void> {
    await this.#tail;
    this.#assertAvailable();
  }
  /** A forced process exit releases ownership without claiming delivery. */
  async close(flush = true): Promise<void> {
    try {
      if (flush) await this.flush();
    } finally {
      this.#writer.releaseLock();
    }
  }
}
