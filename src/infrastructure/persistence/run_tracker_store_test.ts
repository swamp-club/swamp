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
import { join } from "@std/path";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { RunTrackerStore } from "./run_tracker_store.ts";

function makeTempDbPath(): string {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-run-tracker-test-" });
  return join(dir, "run_tracker.db");
}

function makeRun(overrides: Partial<{
  id: string;
  modelType: string;
  methodName: string;
  pid: number;
  hostname: string;
}> = {}): ActiveRun {
  return ActiveRun.createModelMethodRun({
    id: overrides.id ?? crypto.randomUUID(),
    modelType: overrides.modelType ?? "@test/model",
    methodName: overrides.methodName ?? "start",
    pid: overrides.pid ?? Deno.pid,
    hostname: overrides.hostname ?? "test-host",
  });
}

Deno.test("RunTrackerStore: register and findById", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = makeRun({ id: "run-1" });
    store.register(run);

    const found = store.findById("run-1");
    assertEquals(found?.id, "run-1");
    assertEquals(found?.runKind, "model_method");
    assertEquals(found?.modelType, "@test/model");
    assertEquals(found?.methodName, "start");
    assertEquals(found?.status, "running");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: findById returns null for missing run", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    assertEquals(store.findById("nonexistent"), null);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: heartbeat updates heartbeat_at", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = makeRun({ id: "run-1" });
    store.register(run);

    const before = store.findById("run-1")!.heartbeatAt;
    const spinUntil = Date.now() + 2;
    while (Date.now() < spinUntil) { /* spin */ }
    store.heartbeat("run-1");
    const after = store.findById("run-1")!.heartbeatAt;

    assertEquals(after.getTime() >= before.getTime(), true);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: complete changes status", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = makeRun({ id: "run-1" });
    store.register(run);
    store.complete("run-1", "completed");

    const found = store.findById("run-1");
    assertEquals(found?.status, "completed");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: findAllRunning returns only running runs", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.register(makeRun({ id: "run-1" }));
    store.register(makeRun({ id: "run-2" }));
    store.register(makeRun({ id: "run-3" }));
    store.complete("run-2", "completed");

    const running = store.findAllRunning();
    assertEquals(running.length, 2);
    const ids = running.map((r) => r.id).sort();
    assertEquals(ids, ["run-1", "run-3"]);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: findStaleRuns finds stale runs by TTL", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    // Insert a "stale" run with old heartbeat via raw fromData
    const staleRun = ActiveRun.fromData({
      id: "stale-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: 99999,
      hostname: "test-host",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      status: "running",
    });
    store.register(staleRun);

    // Insert a fresh run
    store.register(makeRun({ id: "fresh-1" }));

    const stale = store.findStaleRuns(90_000);
    assertEquals(stale.length, 1);
    assertEquals(stale[0].id, "stale-1");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: reapStaleRuns marks stale runs as failed", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const staleRun = ActiveRun.fromData({
      id: "stale-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: 2147483647, // Non-existent PID
      hostname: "test-host",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      status: "running",
    });
    store.register(staleRun);

    const reaped = store.reapStaleRuns(90_000);

    // Cross-host stale runs are reaped by TTL alone
    assertEquals(reaped.length, 1);
    assertEquals(reaped[0].id, "stale-1");

    const updated = store.findById("stale-1");
    assertEquals(updated?.status, "failed");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: reapStaleRuns is idempotent", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const staleRun = ActiveRun.fromData({
      id: "stale-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: 2147483647,
      hostname: "test-host",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      status: "running",
    });
    store.register(staleRun);

    const first = store.reapStaleRuns(90_000);
    assertEquals(first.length, 1);

    // Second reap finds nothing — already reaped
    const second = store.reapStaleRuns(90_000);
    assertEquals(second.length, 0);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: findAll returns all runs", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.register(makeRun({ id: "run-1" }));
    store.register(makeRun({ id: "run-2" }));
    store.complete("run-1", "failed");

    const all = store.findAll();
    assertEquals(all.length, 2);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: heartbeat is no-op for completed runs", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.register(makeRun({ id: "run-1" }));
    store.complete("run-1", "completed");

    // Should not throw, just log a debug message
    store.heartbeat("run-1");
    assertEquals(store.findById("run-1")?.status, "completed");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: concurrent stores on same DB file", () => {
  const dbPath = makeTempDbPath();
  const store1 = new RunTrackerStore(dbPath);
  const store2 = new RunTrackerStore(dbPath);
  try {
    store1.register(makeRun({ id: "run-1" }));
    store2.register(makeRun({ id: "run-2" }));

    assertEquals(store1.findAllRunning().length, 2);
    assertEquals(store2.findAllRunning().length, 2);
  } finally {
    store1.close();
    store2.close();
  }
});
