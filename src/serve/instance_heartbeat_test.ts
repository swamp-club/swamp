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

import { assertEquals } from "@std/assert";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  type HeartbeatRecord,
  InstanceHeartbeatService,
} from "./instance_heartbeat.ts";

function createMockStore(): ControlPlaneStore & {
  data: Map<string, Uint8Array>;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put(key: string, value: Uint8Array): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(data.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
      );
    },
  };
}

Deno.test("InstanceHeartbeatService: start writes heartbeat record", async () => {
  const store = createMockStore();
  const service = new InstanceHeartbeatService(store, "inst-1", {
    intervalMs: 60_000,
  });

  await service.start();
  try {
    const raw = store.data.get("heartbeats/inst-1");
    assertEquals(raw !== undefined, true);

    const record = JSON.parse(new TextDecoder().decode(raw!));
    assertEquals(record.instanceId, "inst-1");
    assertEquals(typeof record.hostname, "string");
    assertEquals(typeof record.pid, "number");
    assertEquals(typeof record.startedAt, "string");
    assertEquals(typeof record.heartbeatAt, "string");
  } finally {
    await service.stop();
  }
});

Deno.test("InstanceHeartbeatService: stop deletes heartbeat record", async () => {
  const store = createMockStore();
  const service = new InstanceHeartbeatService(store, "inst-1", {
    intervalMs: 60_000,
  });

  await service.start();
  assertEquals(store.data.has("heartbeats/inst-1"), true);

  await service.stop();
  assertEquals(store.data.has("heartbeats/inst-1"), false);
});

Deno.test("InstanceHeartbeatService: instanceId getter", async () => {
  const store = createMockStore();
  const service = new InstanceHeartbeatService(store, "inst-42", {
    intervalMs: 60_000,
  });
  assertEquals(service.instanceId, "inst-42");
  await service.stop();
});

Deno.test("InstanceHeartbeatService.isStale: fresh record is not stale", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host",
    pid: 1234,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  assertEquals(InstanceHeartbeatService.isStale(record), false);
});

Deno.test("InstanceHeartbeatService.isStale: old record is stale", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host",
    pid: 1234,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
  };
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("InstanceHeartbeatService.isStale: custom TTL", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host",
    pid: 1234,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
  };
  assertEquals(InstanceHeartbeatService.isStale(record, 3_000), true);
  assertEquals(InstanceHeartbeatService.isStale(record, 10_000), false);
});

Deno.test("InstanceHeartbeatService.parseRecord: valid record", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:30.000Z",
  };
  const data = new TextEncoder().encode(JSON.stringify(record));
  const parsed = InstanceHeartbeatService.parseRecord(data);
  assertEquals(parsed?.instanceId, "inst-1");
  assertEquals(parsed?.pid, 1234);
});

Deno.test("InstanceHeartbeatService.parseRecord: invalid JSON returns null", () => {
  const data = new TextEncoder().encode("not json");
  assertEquals(InstanceHeartbeatService.parseRecord(data), null);
});

Deno.test("InstanceHeartbeatService.parseRecord: missing fields returns null", () => {
  const data = new TextEncoder().encode('{"instanceId":"x"}');
  assertEquals(InstanceHeartbeatService.parseRecord(data), null);
});
