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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";
import { withSpan } from "../../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../../infrastructure/tracing/span_test_helpers.ts";
import { StoreSink } from "./store_sink.ts";

await initializeLogging({});

const decoder = new TextDecoder();

function makeEvent(
  action: string,
  timestamp = "2026-09-04T10:00:00.000Z",
): AuditEvent {
  return {
    ...createAuditEvent({
      instanceId: "inst-1",
      category: "auth",
      stage: "response",
      outcome: "success",
      action,
      resourceKind: "access",
      resourceName: "*",
      principalKind: "user",
      principalId: "test-user",
      initiatedBy: "user:test-user",
      sourceIp: "127.0.0.1",
      requestId: crypto.randomUUID(),
    }),
    timestamp,
  };
}

function createMockStore(): AuditStore & {
  written: Map<string, Uint8Array>;
} {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    put(key: string, data: Uint8Array): Promise<void> {
      written.set(key, data);
      return Promise.resolve();
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(written.get(key) ?? null);
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...written.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
    delete(key: string): Promise<void> {
      written.delete(key);
      return Promise.resolve();
    },
  };
}

Deno.test("StoreSink: writes batch when flushed", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test.action")]);
  await sink.flush();
  await sink.close();

  assertEquals(store.written.size, 1);
  const [key] = [...store.written.keys()];
  assertStringIncludes(key, "events/2026-09-04/");
  assertStringIncludes(key, ".jsonl");

  const content = decoder.decode(store.written.get(key)!);
  const parsed = JSON.parse(content.trim());
  assertEquals(parsed.action, "test.action");
});

Deno.test("StoreSink: auto-flushes when batch size reached", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 2,
    flushIntervalMs: 60_000,
  });

  await sink.write([
    makeEvent("a"),
    makeEvent("b"),
  ]);
  await sink.close();

  assertEquals(store.written.size, 1);
});

Deno.test("StoreSink: partitions by date", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([
    makeEvent("a", "2026-09-04T10:00:00.000Z"),
    makeEvent("b", "2026-09-05T10:00:00.000Z"),
  ]);
  await sink.flush();
  await sink.close();

  assertEquals(store.written.size, 2);
  const keys = [...store.written.keys()].sort();
  assertStringIncludes(keys[0], "events/2026-09-04/");
  assertStringIncludes(keys[1], "events/2026-09-05/");
});

Deno.test("StoreSink: writes to multiple stores", async () => {
  const storeA = createMockStore();
  const storeB = createMockStore();
  const sink = new StoreSink({
    stores: [storeA, storeB],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test")]);
  await sink.flush();
  await sink.close();

  assertEquals(storeA.written.size, 1);
  assertEquals(storeB.written.size, 1);
});

Deno.test("StoreSink: store failure does not crash", async () => {
  const failingStore: AuditStore = {
    put(): Promise<void> {
      return Promise.reject(new Error("store down"));
    },
    get(): Promise<Uint8Array | null> {
      return Promise.resolve(null);
    },
    list(): Promise<string[]> {
      return Promise.resolve([]);
    },
    delete(): Promise<void> {
      return Promise.resolve();
    },
  };
  const goodStore = createMockStore();
  const sink = new StoreSink({
    stores: [failingStore, goodStore],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test")]);
  // The good store has the batch, so flush does not report it.
  await sink.flush();
  await sink.close();

  assertEquals(goodStore.written.size, 1);
});

Deno.test("StoreSink: a batch one store missed is retried there under the same key", async () => {
  const keys: string[] = [];
  let down = true;
  const flakyStore: AuditStore = {
    put(key: string): Promise<void> {
      keys.push(key);
      return down ? Promise.reject(new Error("store down")) : Promise.resolve();
    },
    get: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
  };
  const goodStore = createMockStore();
  const sink = new StoreSink({
    stores: [goodStore, flakyStore],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test")]);
  await sink.flush();
  await sink.flush();
  down = false;
  await sink.flush();
  await sink.flush();

  // First put, two failed retries, one that landed, then nothing more.
  assertEquals(keys.length, 4);
  assertEquals(new Set(keys).size, 1);
  assertEquals([...goodStore.written.keys()], [keys[0]]);
  await sink.close();
});

Deno.test("StoreSink: flush rejects when a batch reached no store", async () => {
  const failingStore: AuditStore = {
    put: () => Promise.reject(new Error("store down")),
    get: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
  };
  const sink = new StoreSink({
    stores: [failingStore],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test")]);
  await assertRejects(() => sink.flush(), Error, "reached no store");
  // Reported once; the WAL holds the batch, so it is not retried here.
  await sink.flush();
  await sink.close();
});

Deno.test("StoreSink: flush reports a batch the interval timer failed to store", async () => {
  let puts = 0;
  const failingStore: AuditStore = {
    put(): Promise<void> {
      puts++;
      return Promise.reject(new Error("store down"));
    },
    get: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
  };
  const sink = new StoreSink({
    stores: [failingStore],
    batchSize: 100,
    flushIntervalMs: 10,
  });

  await sink.write([makeEvent("test")]);
  await waitFor(() => puts === 1, "timer flush");
  await assertRejects(() => sink.flush(), Error, "reached no store");
  await sink.close();
});

Deno.test("StoreSink: flush waits for a batch write already running", async () => {
  let finishPut: (() => void) | null = null;
  const slowStore = createMockStore();
  const put = slowStore.put.bind(slowStore);
  slowStore.put = (key: string, data: Uint8Array) =>
    new Promise<void>((resolve) => {
      finishPut = () => put(key, data).then(resolve);
    });
  const sink = new StoreSink({
    stores: [slowStore],
    batchSize: 1,
    flushIntervalMs: 60_000,
  });

  const writing = sink.write([makeEvent("slow")]);
  let flushed = false;
  const flushing = sink.flush().then(() => {
    flushed = true;
  });
  await waitFor(() => finishPut !== null, "put started");
  assertEquals(flushed, false);
  finishPut!();
  await writing;
  await flushing;
  assertEquals(slowStore.written.size, 1);
  await sink.close();
});

Deno.test("StoreSink: flush is no-op when batch is empty", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.flush();
  await sink.close();

  assertEquals(store.written.size, 0);
});

Deno.test("StoreSink: close flushes pending events", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("pending")]);
  await sink.close();

  assertEquals(store.written.size, 1);
});

Deno.test("StoreSink: abort signal triggers close", async () => {
  const store = createMockStore();
  const ac = new AbortController();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
    signal: ac.signal,
  });

  await sink.write([makeEvent("before-abort")]);
  ac.abort();

  await waitFor(() => store.written.size >= 1, "abort signal flush");

  assertEquals(store.written.size, 1);
  await sink.close();
});

Deno.test("StoreSink: close is idempotent", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test")]);
  await sink.close();
  await sink.close();
  await sink.close();

  assertEquals(store.written.size, 1);
});

Deno.test("StoreSink: slow store does not block subsequent batches", async () => {
  let writeCount = 0;
  const slowStore: AuditStore = {
    put(_key: string, _data: Uint8Array): Promise<void> {
      writeCount++;
      return new Promise((resolve) => setTimeout(resolve, 100));
    },
    get(): Promise<Uint8Array | null> {
      return Promise.resolve(null);
    },
    list(): Promise<string[]> {
      return Promise.resolve([]);
    },
    delete(): Promise<void> {
      return Promise.resolve();
    },
  };
  const sink = new StoreSink({
    stores: [slowStore],
    batchSize: 1,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("batch-1")]);
  await sink.write([makeEvent("batch-2")]);
  await sink.close();

  assertEquals(writeCount, 2);
});

Deno.test("StoreSink: timer flush during close does not duplicate events", async () => {
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 10,
  });

  await sink.write([makeEvent("event-1")]);

  await waitFor(() => store.written.size >= 1, "timer flush");

  await sink.close();

  // All writes should be for event-1, and there should be exactly 1 batch
  assertEquals(store.written.size, 1);
  const content = decoder.decode([...store.written.values()][0]);
  const parsed = JSON.parse(content.trim());
  assertEquals(parsed.action, "event-1");
});

Deno.test("StoreSink: write accepts more events than fit in a spread call", async () => {
  // push(...events) threw RangeError above ~125k events (swamp-club#2565).
  const count = 150_000;
  const store = createMockStore();
  const sink = new StoreSink({
    stores: [store],
    batchSize: count + 1,
    flushIntervalMs: 60_000,
  });
  const event = makeEvent("bulk");

  await sink.write(Array.from({ length: count }, () => event));
  await sink.close();

  let lines = 0;
  for (const data of store.written.values()) {
    lines += decoder.decode(data).trim().split("\n").length;
  }
  assertEquals(lines, count);
});

Deno.test("StoreSink: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const flushSeen: (Span | undefined)[] = [];
    const gcSeen: (Span | undefined)[] = [];
    let recording = true;
    const store = createMockStore();
    const put = store.put.bind(store);
    const list = store.list.bind(store);
    store.put = (key, data) => {
      if (recording) flushSeen.push(trace.getActiveSpan());
      return put(key, data);
    };
    store.list = (prefix) => {
      if (recording) gcSeen.push(trace.getActiveSpan());
      return list(prefix);
    };
    await withSpan("swamp.cli", {}, async () => {
      // The constructor arms both the flush and the GC timer under the
      // caller's span.
      const sink = new StoreSink({
        stores: [{ store, retentionDays: 30 }],
        batchSize: 100,
        flushIntervalMs: 10,
        gcIntervalMs: 10,
      });
      try {
        // A periodic flush only writes when events are queued.
        await sink.write([makeEvent("first")]);
        await waitFor(() => flushSeen.length >= 1, "the first timed flush");
        await sink.write([makeEvent("second")]);
        await waitFor(() => flushSeen.length >= 2, "the second timed flush");
        await waitFor(() => gcSeen.length >= 2, "two GC ticks");
      } finally {
        recording = false;
        await sink.close();
      }
    });
    assert(flushSeen.length >= 2);
    assert(gcSeen.length >= 2);
    for (const span of [...flushSeen, ...gcSeen]) {
      assertEquals(span, undefined);
    }
  });
});

Deno.test("StoreSink: a batch spanning two dates counts as stored once one date lands, and the other is retried under its key", async () => {
  let failDate: string | null = "2026-10-07";
  const keys: string[] = [];
  const store = createMockStore();
  const put = store.put.bind(store);
  store.put = (key: string, data: Uint8Array) => {
    keys.push(key);
    if (failDate !== null && key.includes(failDate)) {
      return Promise.reject(new Error("store down"));
    }
    return put(key, data);
  };
  const sink = new StoreSink({
    stores: [store],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([
    { ...makeEvent("before"), timestamp: "2026-10-06T23:59:59.000Z" },
    { ...makeEvent("after"), timestamp: "2026-10-07T00:00:01.000Z" },
  ]);
  await sink.flush();
  failDate = null;
  await sink.flush();

  // The first put, a retry in the same flush, and the one that landed.
  const lateKeys = keys.filter((k) => k.includes("2026-10-07"));
  assertEquals(lateKeys.length, 3);
  assertEquals(new Set(lateKeys).size, 1);
  assertEquals(store.written.size, 2);
  await sink.close();
});
