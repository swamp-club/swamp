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
  cleanupActiveRunsForInstance,
  deleteActiveRun,
  findActiveRunByRunId,
  rekeyActiveRun,
  writeActiveRun,
} from "./active_run_tracker.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

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
        [...data.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

function parseRecord(
  store: ControlPlaneStore & { data: Map<string, Uint8Array> },
  key: string,
): Record<string, unknown> | null {
  const raw = store.data.get(key);
  if (!raw) return null;
  return JSON.parse(new TextDecoder().decode(raw));
}

Deno.test("writeActiveRun: writes record to control-plane store", async () => {
  const store = createMockStore();
  writeActiveRun(store, "instance-1", "run-abc", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  // writeActiveRun is fire-and-forget; flush microtasks
  await new Promise((r) => setTimeout(r, 10));

  const record = parseRecord(store, "active-runs/instance-1/run-abc");
  assertEquals(record, {
    instanceId: "instance-1",
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
});

Deno.test("deleteActiveRun: removes record from control-plane store", async () => {
  const store = createMockStore();
  writeActiveRun(store, "instance-1", "run-abc", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(store.data.has("active-runs/instance-1/run-abc"), true);

  deleteActiveRun(store, "instance-1", "run-abc");
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(store.data.has("active-runs/instance-1/run-abc"), false);
});

Deno.test("rekeyActiveRun: deletes old key and writes new key", async () => {
  const store = createMockStore();
  writeActiveRun(store, "instance-1", "temp-uuid", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));

  rekeyActiveRun(store, "instance-1", "temp-uuid", "domain-run-id", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(store.data.has("active-runs/instance-1/temp-uuid"), false);
  const record = parseRecord(store, "active-runs/instance-1/domain-run-id");
  assertEquals(record, {
    instanceId: "instance-1",
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
});

Deno.test("cleanupActiveRunsForInstance: deletes all records for an instance", async () => {
  const store = createMockStore();

  writeActiveRun(store, "stale-instance", "run-1", {
    resourceName: "workflow-a",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  writeActiveRun(store, "stale-instance", "run-2", {
    resourceName: "workflow-b",
    runKind: "method-run",
    startedAt: "2026-08-01T12:01:00Z",
  });
  writeActiveRun(store, "healthy-instance", "run-3", {
    resourceName: "workflow-c",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:02:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));

  const cleaned = await cleanupActiveRunsForInstance(store, "stale-instance");
  assertEquals(cleaned, 2);
  assertEquals(store.data.has("active-runs/stale-instance/run-1"), false);
  assertEquals(store.data.has("active-runs/stale-instance/run-2"), false);
  assertEquals(store.data.has("active-runs/healthy-instance/run-3"), true);
});

Deno.test("findActiveRunByRunId: finds run across instances", async () => {
  const store = createMockStore();
  writeActiveRun(store, "instance-a", "run-1", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  writeActiveRun(store, "instance-b", "run-2", {
    resourceName: "build-model",
    runKind: "method-run",
    startedAt: "2026-08-01T12:01:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));

  const result = await findActiveRunByRunId(store, "run-2");
  assertEquals(result?.instanceId, "instance-b");
  assertEquals(result?.record.resourceName, "build-model");
  assertEquals(result?.record.runKind, "method-run");
});

Deno.test("findActiveRunByRunId: returns null when run not found", async () => {
  const store = createMockStore();
  writeActiveRun(store, "instance-a", "run-1", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));

  const result = await findActiveRunByRunId(store, "run-nonexistent");
  assertEquals(result, null);
});

Deno.test("findActiveRunByRunId: returns null on empty store", async () => {
  const store = createMockStore();
  const result = await findActiveRunByRunId(store, "run-1");
  assertEquals(result, null);
});

Deno.test("findActiveRunByRunId: handles corrupted record gracefully", async () => {
  const store = createMockStore();
  store.data.set(
    "active-runs/instance-a/run-bad",
    new TextEncoder().encode("not-json"),
  );

  const result = await findActiveRunByRunId(store, "run-bad");
  assertEquals(result, null);
});

Deno.test("writeActiveRun: does not throw on store failure", async () => {
  const store = createMockStore();
  store.put = () => Promise.reject(new Error("S3 unreachable"));

  writeActiveRun(store, "instance-1", "run-abc", {
    resourceName: "deploy-pipeline",
    runKind: "workflow-run",
    startedAt: "2026-08-01T12:00:00Z",
  });
  await new Promise((r) => setTimeout(r, 10));
  // No throw — the error is caught and logged
});

Deno.test("deleteActiveRun: does not throw on store failure", async () => {
  const store = createMockStore();
  store.delete = () => Promise.reject(new Error("S3 unreachable"));

  deleteActiveRun(store, "instance-1", "run-abc");
  await new Promise((r) => setTimeout(r, 10));
  // No throw — the error is caught and logged
});
