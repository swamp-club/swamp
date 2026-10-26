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

import { assert, assertEquals, assertExists } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALE_TTL_MS,
  type HeartbeatRecord,
  InstanceHeartbeatService,
} from "./instance_heartbeat.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";
import { heartbeatLiveness } from "../infrastructure/persistence/control_plane_continuation_claim_store.ts";
import { serveHolder } from "../domain/workflows/continuation_claim.ts";

await initializeLogging({});

function createInMemoryStore(): ControlPlaneStore & {
  entries: Map<string, Uint8Array>;
  deleted: string[];
} {
  const entries = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    entries,
    deleted,
    put: (key: string, data: Uint8Array) => {
      entries.set(key, data);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(entries.get(key) ?? null),
    delete: (key: string) => {
      entries.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
    list: (prefix: string) => {
      const keys = [...entries.keys()].filter((k) => k.startsWith(prefix));
      return Promise.resolve(keys.sort());
    },
  };
}

Deno.test("InstanceHeartbeatService: start writes initial heartbeat", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "test-id", {
    intervalMs: 60_000,
  });

  await service.start();
  await service.stop();

  // The start should have written but stop deletes. Check the deleted key.
  assertEquals(store.deleted, ["heartbeats/test-id"]);
});

Deno.test("InstanceHeartbeatService: stop deletes heartbeat", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "stop-test", {
    intervalMs: 60_000,
  });

  await service.start();

  // Heartbeat should be present after start
  const data = store.entries.get("heartbeats/stop-test");
  assertExists(data);

  await service.stop();

  // Heartbeat should be deleted after stop
  assertEquals(store.entries.has("heartbeats/stop-test"), false);
});

Deno.test("InstanceHeartbeatService: instanceId getter returns correct value", () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "my-instance");
  assertEquals(service.instanceId, "my-instance");
});

Deno.test("InstanceHeartbeatService: heartbeat record contains expected fields", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "field-test", {
    intervalMs: 60_000,
  });

  await service.start();

  const data = store.entries.get("heartbeats/field-test");
  assertExists(data);
  const record = JSON.parse(new TextDecoder().decode(data)) as HeartbeatRecord;

  assertEquals(record.instanceId, "field-test");
  assertEquals(typeof record.hostname, "string");
  assertEquals(typeof record.pid, "number");
  assertEquals(typeof record.startedAt, "string");
  assertEquals(typeof record.heartbeatAt, "string");

  await service.stop();
});

Deno.test("InstanceHeartbeatService: publishes its stale TTL when given one, and a reader of claims judges it by that", async () => {
  const store = createInMemoryStore();
  const plain = new InstanceHeartbeatService(store, "plain", {
    intervalMs: 60_000,
  });
  const slow = new InstanceHeartbeatService(store, "slow", {
    intervalMs: 60_000,
    staleTtlMs: 600_000,
  });
  await plain.start();
  await slow.start();
  const read = (id: string) =>
    JSON.parse(
      new TextDecoder().decode(store.entries.get(`heartbeats/${id}`)),
    ) as HeartbeatRecord;

  assertEquals("staleTtlMs" in read("plain"), false);
  assertEquals(read("slow").staleTtlMs, 600_000);

  // Five minutes on, a reader whose own default is 90 s still counts the
  // slow instance alive, and the one that published nothing dead.
  const liveness = heartbeatLiveness(store, {
    now: () => new Date(Date.now() + 300_000),
  });
  assertEquals(await liveness(serveHolder("slow")), "alive");
  assertEquals(await liveness(serveHolder("plain")), "dead");

  await plain.stop();
  await slow.stop();
});

Deno.test("InstanceHeartbeatService.isStale: returns false for fresh heartbeat", () => {
  const record: HeartbeatRecord = {
    instanceId: "fresh",
    hostname: "host",
    pid: 1,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  assertEquals(InstanceHeartbeatService.isStale(record), false);
});

Deno.test("InstanceHeartbeatService.isStale: returns true for old heartbeat", () => {
  const record: HeartbeatRecord = {
    instanceId: "stale",
    hostname: "host",
    pid: 1,
    startedAt: new Date(Date.now() - 300_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
  };
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("InstanceHeartbeatService.isStale: returns true for invalid date", () => {
  const record: HeartbeatRecord = {
    instanceId: "bad-date",
    hostname: "host",
    pid: 1,
    startedAt: "not-a-date",
    heartbeatAt: "not-a-date",
  };
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("InstanceHeartbeatService.parseRecord: parses valid record", () => {
  const record: HeartbeatRecord = {
    instanceId: "parse-test",
    hostname: "host",
    pid: 42,
    startedAt: "2026-01-01T00:00:00Z",
    heartbeatAt: "2026-01-01T00:01:00Z",
  };
  const data = new TextEncoder().encode(JSON.stringify(record));
  const parsed = InstanceHeartbeatService.parseRecord(data);
  assertExists(parsed);
  assertEquals(parsed.instanceId, "parse-test");
  assertEquals(parsed.pid, 42);
});

Deno.test("InstanceHeartbeatService.parseRecord: returns null for invalid data", () => {
  const data = new TextEncoder().encode("not-json{{{");
  assertEquals(InstanceHeartbeatService.parseRecord(data), null);

  const missingFields = new TextEncoder().encode(
    JSON.stringify({ instanceId: "test" }),
  );
  assertEquals(InstanceHeartbeatService.parseRecord(missingFields), null);
});

Deno.test("InstanceHeartbeatService: default constants are reasonable", () => {
  assertEquals(DEFAULT_HEARTBEAT_INTERVAL_MS, 30_000);
  assertEquals(DEFAULT_STALE_TTL_MS, 90_000);
});

Deno.test("InstanceHeartbeatService: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    let recording = false;
    const store = createInMemoryStore();
    const put = store.put;
    store.put = (key, data) => {
      if (recording) seen.push(trace.getActiveSpan());
      return put(key, data);
    };
    const service = new InstanceHeartbeatService(store, "trace-test", {
      intervalMs: 10,
    });
    await withSpan("swamp.cli", {}, async () => {
      // start() awaits its first write under the caller's span; only the
      // writes the interval makes afterwards are ticks.
      await service.start();
      recording = true;
      try {
        await waitFor(() => seen.length >= 2, "two heartbeat ticks");
      } finally {
        recording = false;
        await service.stop();
      }
    });
    assert(seen.length >= 2);
    for (const span of seen) assertEquals(span, undefined);
  });
});

Deno.test("InstanceHeartbeatService: stop with leaveStoppedRecord writes a stopped record instead of deleting (swamp-club#3958)", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "stopped-test", {
    intervalMs: 60_000,
  });
  await service.start();

  await service.stop({ leaveStoppedRecord: true });

  assertEquals(store.deleted, []);
  const data = store.entries.get("heartbeats/stopped-test");
  assertExists(data);
  const record = InstanceHeartbeatService.parseRecord(data);
  assertExists(record);
  assertExists(record.stoppedAt);
  assertEquals(InstanceHeartbeatService.isStopped(record), true);
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("InstanceHeartbeatService: a stopped record that cannot be written leaves the last heartbeat", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "slow-stop", {
    intervalMs: 60_000,
  });
  await service.start();
  const last = store.entries.get("heartbeats/slow-stop");
  store.put = () => Promise.reject(new Error("S3 unreachable"));

  await service.stop({ leaveStoppedRecord: true });

  assertEquals(store.deleted, []);
  assertEquals(store.entries.get("heartbeats/slow-stop"), last);
});

Deno.test("InstanceHeartbeatService: a stopped record write that never settles is cut off at its bound", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "hung-stop", {
    intervalMs: 60_000,
  });
  await service.start();
  let release: (() => void) | undefined;
  store.put = () => new Promise<void>((resolve) => release = resolve);

  await service.stop({ leaveStoppedRecord: true, writeTimeoutMs: 10 });

  assertEquals(store.deleted, []);
  release?.();
});

Deno.test("InstanceHeartbeatService.isStale: a stopped record is stale whatever its age", () => {
  const now = new Date().toISOString();
  const record: HeartbeatRecord = {
    instanceId: "stopped",
    hostname: "host",
    pid: 1,
    startedAt: now,
    heartbeatAt: now,
    stoppedAt: now,
  };
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("InstanceHeartbeatService.parseRecord: rejects a stoppedAt that is not a string", () => {
  const data = new TextEncoder().encode(JSON.stringify({
    instanceId: "x",
    hostname: "host",
    pid: 1,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    stoppedAt: 1,
  }));
  assertEquals(InstanceHeartbeatService.parseRecord(data), null);
});

Deno.test("InstanceHeartbeatService: a periodic write in flight at stop cannot replace the stopped record", async () => {
  const store = createInMemoryStore();
  const service = new InstanceHeartbeatService(store, "race-stop", {
    intervalMs: 5,
  });
  await service.start();
  const put = store.put;
  let release: (() => void) | undefined;
  let held = false;
  store.put = (key, data) => {
    if (held) return put(key, data);
    held = true;
    // The next periodic write is held until released, then lands.
    return new Promise<void>((resolve) => {
      release = () => put(key, data).then(resolve);
    });
  };
  await waitFor(() => release !== undefined, "the next periodic write");

  const stopping = service.stop({ leaveStoppedRecord: true });
  // One macrotask yield: a stopped write that does not wait for the held
  // write has gone out by then, and the held write lands after it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release!();
  await stopping;

  const record = InstanceHeartbeatService.parseRecord(
    store.entries.get("heartbeats/race-stop")!,
  );
  assertExists(record?.stoppedAt);
});
