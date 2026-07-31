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

import { assertEquals, assertExists } from "@std/assert";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALE_TTL_MS,
  type HeartbeatRecord,
  InstanceHeartbeatService,
} from "./instance_heartbeat.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

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
