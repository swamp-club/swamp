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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import fc from "fast-check";
import fixtures from "../../packages/serve-go/fixtures/frames.json" with {
  type: "json",
};
import {
  encodeEngineFrame,
  ENGINE_PROTOCOL,
  ENGINE_SESSION_BURST_FRAMES,
  EngineWriter,
  parseEngineRequest,
  readEngineFrames,
} from "./protocol.ts";

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
async function collect(chunks: Uint8Array[]) {
  return await Array.fromAsync(readEngineFrames(stream(chunks)));
}
Deno.test("readEngineFrames: shared golden envelopes survive coalescing and single byte reads", async () => {
  const encoded = fixtures.map((f) => encodeEngineFrame(f));
  const joined = new Uint8Array(encoded.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const frame of encoded) {
    joined.set(frame, at);
    at += frame.length;
  }
  assertEquals(await collect([joined]), fixtures);
  assertEquals(
    await collect([...joined].map((v) => new Uint8Array([v]))),
    fixtures,
  );
});

Deno.test("EngineWriter: session overflow preserves peer output and reserved close/control delivery", async () => {
  const output: Uint8Array[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let writing!: () => void;
  const started = new Promise<void>((resolve) => writing = resolve);
  let failures = 0;
  const writer = new EngineWriter(
    new WritableStream({
      async write(frame) {
        writing();
        await blocked;
        output.push(frame);
      },
    }),
    () => failures++,
  );
  assertEquals(writer.sendSession("slow", { sessionId: "slow", seq: 0 }), true);
  await started;
  for (let seq = 1; seq < ENGINE_SESSION_BURST_FRAMES; seq++) {
    assertEquals(writer.sendSession("slow", { sessionId: "slow", seq }), true);
  }
  assertEquals(
    writer.sendSession("slow", { sessionId: "slow", overflow: true }),
    false,
  );
  assertEquals(
    writer.sendSession("peer", { sessionId: "peer", success: true }),
    true,
  );
  writer.closeSession("slow", { sessionId: "slow", closed: { code: 1013 } });
  writer.send({ id: "control", result: { ready: true } });
  release();
  await writer.flush();
  assertEquals(await collect(output), [
    { sessionId: "slow", seq: 0 },
    { sessionId: "peer", success: true },
    { sessionId: "slow", closed: { code: 1013 } },
    { id: "control", result: { ready: true } },
  ]);
  assertEquals(failures, 0);
  assertEquals(writer.pending, 0);
  await writer.close();
});
Deno.test("EngineWriter: independent byte budgets admit peers when another lane is full", async () => {
  const blocked = Promise.withResolvers<void>();
  const written: Uint8Array[] = [];
  const writer = new EngineWriter(
    new WritableStream({
      async write(frame) {
        await blocked.promise;
        written.push(frame);
      },
    }),
  );
  // A serialized JSON string has two quote bytes and the frame has four header
  // bytes. Fill the exact lane limit, rather than only its frame-count limit.
  const full = "x".repeat(ENGINE_PROTOCOL.limits.engineSessionBytes - 6);
  try {
    assertEquals(writer.sendSession("full", full), true);
    assertEquals(writer.sendSession("full", {}), false);
    assertEquals(writer.sendSession("peer", full), true);
    assertEquals(writer.sendSession("small-peer", { healthy: true }), true);
    // Bound aggregate allocations by lane count without reserving any bytes
    // until a session actually has output.
    for (let lane = 3; lane <= ENGINE_PROTOCOL.limits.sessions; lane++) {
      assertEquals(writer.sendSession(`lane-${lane}`, {}), true);
    }
    assertEquals(writer.sendSession("excess-lane", {}), false);
    assertEquals(writer.sendSession("small-peer", { healthy: "again" }), true);
  } finally {
    blocked.resolve();
    await writer.close();
  }
  assertEquals(written.length, ENGINE_PROTOCOL.limits.sessions + 2);
  assertEquals(writer.pending, 0);
});

Deno.test("EngineWriter: closing queued lanes releases their budget during session churn", async () => {
  const blocked = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const closed: string[] = [];
  const writer = new EngineWriter(
    new WritableStream({
      async write(frame) {
        started.resolve();
        await blocked.promise;
        const value = JSON.parse(new TextDecoder().decode(frame.subarray(4)));
        if (value.closed) closed.push(value.closed);
      },
    }),
  );
  const full = "x".repeat(ENGINE_PROTOCOL.limits.engineSessionBytes - 6);
  assertEquals(writer.sendSession("in-flight", full), true);
  await started.promise;
  writer.closeSession("in-flight", { closed: "in-flight" });
  for (let lane = 0; lane < ENGINE_PROTOCOL.limits.sessions; lane++) {
    // Each overflowing lane starts at the full byte limit; detaching it frees
    // the payload while every reserved close remains queued behind the pipe.
    assertEquals(writer.sendSession(`closed-${lane}`, full), true);
    assertEquals(writer.sendSession(`closed-${lane}`, {}), false);
    writer.closeSession(`closed-${lane}`, { closed: `closed-${lane}` });
  }
  for (let lane = 0; lane < ENGINE_PROTOCOL.limits.sessions; lane++) {
    assertEquals(writer.sendSession(`live-${lane}`, {}), true);
  }
  assertEquals(writer.sendSession("excess-lane", {}), false);
  blocked.resolve();
  await writer.close();
  assertEquals(writer.pending, 0);
  assertEquals(closed, [
    "in-flight",
    ...Array.from(
      { length: ENGINE_PROTOCOL.limits.sessions },
      (_, lane) => `closed-${lane}`,
    ),
  ]);
});
Deno.test("readEngineFrames: arbitrary unicode JSON and chunk boundaries round trip", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.jsonValue(),
      fc.array(fc.integer({ min: 1, max: 128 }), {
        minLength: 1,
        maxLength: 20,
      }),
      async (value, sizes) => {
        const encoded = encodeEngineFrame(value);
        const chunks = [];
        let at = 0;
        let i = 0;
        while (at < encoded.length) {
          const size = sizes[i++ % sizes.length];
          chunks.push(encoded.slice(at, at + size));
          at += size;
        }
        assertEquals(await collect(chunks), [value]);
      },
    ),
    { numRuns: 100 },
  );
});
Deno.test("readEngineFrames: rejects invalid lengths, JSON, UTF-8, and truncated EOF", async () => {
  for (
    const bytes of [
      new Uint8Array([0]),
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array([255, 255, 255, 255]),
      new Uint8Array([0, 0, 0, 1, 123]),
      new Uint8Array([0, 0, 0, 1, 255]),
    ]
  ) {
    await assertRejects(() => collect([bytes]));
  }
});
Deno.test("parseEngineRequest: rejects incompatible versions and malformed envelopes", () => {
  assertEquals<unknown>(parseEngineRequest(fixtures[0]), fixtures[0]);
  for (
    const value of [null, [], {}, { ...fixtures[0], version: 2 }, {
      ...fixtures[0],
      generation: "",
    }, { ...fixtures[0], params: [] }]
  ) assertThrows(() => parseEngineRequest(value));
});
Deno.test("EngineWriter: tracks writes and exposes failure through flush", async () => {
  const bytes: Uint8Array[] = [];
  const writer = new EngineWriter(
    new WritableStream({
      write(value) {
        bytes.push(value);
      },
    }),
  );
  for (const fixture of fixtures) writer.send(fixture);
  await writer.flush();
  assertEquals(writer.pending, 0);
  assertEquals(await collect(bytes), fixtures);
  await writer.close();
  const failed = new EngineWriter(
    new WritableStream({
      write() {
        throw new Error("canary");
      },
    }),
  );
  failed.send(fixtures[0]);
  await assertRejects(() => failed.flush(), Error, "Engine output unavailable");
  assertThrows(
    () => failed.send(fixtures[0]),
    Error,
    "Engine output unavailable",
  );
  await assertRejects(() => failed.close());
});
Deno.test("EngineWriter: refuses queue growth while its pipe is stalled", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const writer = new EngineWriter(
    new WritableStream({
      write() {
        return blocked;
      },
    }),
  );
  for (let n = 0; n < 128; n++) writer.send({ n });
  assertThrows(() => writer.send({ n: 129 }), Error, "queue full");
  unblock();
  await writer.close();
});

Deno.test("readEngineFrames: cancellation interrupts an incomplete frame and awaits source cleanup", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(writer) {
      writer.enqueue(new Uint8Array([0, 0]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = readEngineFrames(source, undefined, controller.signal);
  const pending = reader.next();
  const refused = assertRejects(() => pending, Error, "Engine input cancelled");
  controller.abort();
  await refused;
  assertEquals(cancelled, true);
  assertEquals(source.locked, false);
});

Deno.test("EngineWriter: even an undefined write rejection notifies failure once", async () => {
  let notified = 0;
  const output = new WritableStream<Uint8Array>({
    write: () => Promise.reject(undefined),
  });
  const writer = new EngineWriter(output, () => {
    notified++;
  });
  writer.send({ first: true });
  writer.send({ second: true });
  await assertRejects(() => writer.flush(), Error, "Engine output unavailable");
  assertEquals(notified, 1);
  assertEquals(writer.pending, 0);
  await assertRejects(() => writer.close());
  assertEquals(output.locked, false);
});
