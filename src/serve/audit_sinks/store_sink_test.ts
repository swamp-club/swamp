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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";
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
    async put(key: string, data: Uint8Array) {
      written.set(key, data);
    },
    async get(key: string) {
      return written.get(key) ?? null;
    },
    async list(prefix: string) {
      return [...written.keys()].filter((k) => k.startsWith(prefix));
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
    async put() {
      throw new Error("store down");
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
  };
  const goodStore = createMockStore();
  const sink = new StoreSink({
    stores: [failingStore, goodStore],
    batchSize: 100,
    flushIntervalMs: 60_000,
  });

  await sink.write([makeEvent("test")]);
  await sink.flush();
  await sink.close();

  assertEquals(goodStore.written.size, 1);
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

  // Give the signal handler time to run
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(store.written.size, 1);
  // Clean up (close is idempotent)
  await sink.close();
});
