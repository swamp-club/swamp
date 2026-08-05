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
import { hostname } from "node:os";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { type PendingRunEntry, RunTrackerStore } from "./run_tracker_store.ts";
import { isSensitiveHeader } from "../../serve/webhook.ts";

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

// ── pending_runs tests ──────────────────────────────────────────────

function makePendingRun(
  overrides: Partial<PendingRunEntry> = {},
): PendingRunEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    source: overrides.source ?? "webhook",
    workflowIdOrName: overrides.workflowIdOrName ?? "test-workflow",
    payload: overrides.payload,
    route: overrides.route,
    traceparent: overrides.traceparent,
    tracestate: overrides.tracestate,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

Deno.test("RunTrackerStore: enqueuePendingRun and findAllPendingRuns", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const entry = makePendingRun({ id: "pr-1", route: "/hooks/deploy" });
    store.enqueuePendingRun(entry);

    const found = store.findAllPendingRuns();
    assertEquals(found.length, 1);
    assertEquals(found[0].id, "pr-1");
    assertEquals(found[0].source, "webhook");
    assertEquals(found[0].workflowIdOrName, "test-workflow");
    assertEquals(found[0].route, "/hooks/deploy");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: deletePendingRun removes the entry", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.enqueuePendingRun(makePendingRun({ id: "pr-1" }));
    assertEquals(store.findAllPendingRuns().length, 1);

    store.deletePendingRun("pr-1");
    assertEquals(store.findAllPendingRuns().length, 0);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: deletePendingRun is idempotent", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.deletePendingRun("nonexistent");
    assertEquals(store.findAllPendingRuns().length, 0);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: findAllPendingRuns returns entries in creation order", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.enqueuePendingRun(
      makePendingRun({ id: "pr-2", createdAt: "2026-01-01T00:00:02Z" }),
    );
    store.enqueuePendingRun(
      makePendingRun({ id: "pr-1", createdAt: "2026-01-01T00:00:01Z" }),
    );
    store.enqueuePendingRun(
      makePendingRun({ id: "pr-3", createdAt: "2026-01-01T00:00:03Z" }),
    );

    const found = store.findAllPendingRuns();
    assertEquals(found.map((r) => r.id), ["pr-1", "pr-2", "pr-3"]);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: findAllPendingRuns returns empty array when no entries", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    assertEquals(store.findAllPendingRuns().length, 0);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: pending run preserves webhook payload and trace headers", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const payload = JSON.stringify({ ref: "main", action: "push" });
    store.enqueuePendingRun(makePendingRun({
      id: "pr-1",
      source: "webhook",
      payload,
      route: "/hooks/ci",
      traceparent: "00-abc-def-01",
      tracestate: "vendor=value",
    }));

    const found = store.findAllPendingRuns();
    assertEquals(found[0].payload, payload);
    assertEquals(found[0].route, "/hooks/ci");
    assertEquals(found[0].traceparent, "00-abc-def-01");
    assertEquals(found[0].tracestate, "vendor=value");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: cron pending run has no payload or route", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.enqueuePendingRun(makePendingRun({
      id: "pr-1",
      source: "cron",
    }));

    const found = store.findAllPendingRuns();
    assertEquals(found[0].source, "cron");
    assertEquals(found[0].payload, undefined);
    assertEquals(found[0].route, undefined);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: schema v2 migration adds pending_runs to existing DB", () => {
  const dbPath = makeTempDbPath();
  // Create a v1 store (existing schema without pending_runs)
  const store1 = new RunTrackerStore(dbPath);
  store1.register(makeRun({ id: "existing-run" }));
  store1.close();

  // Reopen — migration should add pending_runs table
  const store2 = new RunTrackerStore(dbPath);
  try {
    store2.enqueuePendingRun(makePendingRun({ id: "pr-1" }));
    assertEquals(store2.findAllPendingRuns().length, 1);
    assertEquals(store2.findAllRunning().length, 1);
  } finally {
    store2.close();
  }
});

// ── reapDeadProcessRuns tests ──────────────────────────────────────

Deno.test("RunTrackerStore: reapDeadProcessRuns marks dead-PID runs as failed", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = ActiveRun.fromData({
      id: "dead-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: 2147483647,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "running",
    });
    store.register(run);

    const reaped = store.reapDeadProcessRuns();

    assertEquals(reaped.length, 1);
    assertEquals(reaped[0].id, "dead-1");
    assertEquals(store.findById("dead-1")?.status, "failed");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: reapDeadProcessRuns skips runs from current process", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = ActiveRun.fromData({
      id: "self-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: Deno.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "running",
    });
    store.register(run);

    const reaped = store.reapDeadProcessRuns();

    assertEquals(reaped.length, 0);
    assertEquals(store.findById("self-1")?.status, "running");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: reapDeadProcessRuns skips runs from different host", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = ActiveRun.fromData({
      id: "remote-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: 2147483647,
      hostname: "other-host",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "running",
    });
    store.register(run);

    const reaped = store.reapDeadProcessRuns();

    assertEquals(reaped.length, 0);
    assertEquals(store.findById("remote-1")?.status, "running");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: reapDeadProcessRuns skips completed runs", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = ActiveRun.fromData({
      id: "done-1",
      runKind: "model_method",
      modelType: "@test/model",
      methodName: "start",
      workflowName: null,
      pid: 2147483647,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "running",
    });
    store.register(run);
    store.complete("done-1", "completed");

    const reaped = store.reapDeadProcessRuns();

    assertEquals(reaped.length, 0);
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: schema v3 migration adds initiated_by column", () => {
  const dbPath = makeTempDbPath();
  const store1 = new RunTrackerStore(dbPath);
  store1.register(makeRun({ id: "pre-migration-run" }));
  store1.close();

  const store2 = new RunTrackerStore(dbPath);
  try {
    const found = store2.findById("pre-migration-run");
    assertEquals(found?.id, "pre-migration-run");
    assertEquals(found?.initiatedBy, null);
  } finally {
    store2.close();
  }
});

Deno.test("RunTrackerStore: register stores initiatedBy", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = ActiveRun.createModelMethodRun({
      id: "with-user",
      modelType: "@test/model",
      methodName: "start",
      pid: Deno.pid,
      hostname: "test-host",
      initiatedBy: "user:paul",
    });
    store.register(run);

    const found = store.findById("with-user");
    assertEquals(found?.initiatedBy, "user:paul");
  } finally {
    store.close();
  }
});

Deno.test("RunTrackerStore: register stores null initiatedBy for ghost runs", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const run = ActiveRun.createModelMethodRun({
      id: "ghost-run",
      modelType: "@test/model",
      methodName: "start",
      pid: Deno.pid,
      hostname: "test-host",
    });
    store.register(run);

    const found = store.findById("ghost-run");
    assertEquals(found?.initiatedBy, null);
  } finally {
    store.close();
  }
});

// ── scrubPendingRunHeaders tests ─────────────────────────────────────

Deno.test("scrubPendingRunHeaders: strips sensitive headers from pending run payloads", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const payload = JSON.stringify({
      headers: {
        authorization: "Bearer secret",
        "x-github-event": "push",
        cookie: "session=abc",
      },
    });
    store.enqueuePendingRun(makePendingRun({ id: "pr-scrub-1", payload }));

    const scrubbed = store.scrubPendingRunHeaders(isSensitiveHeader);
    assertEquals(scrubbed, 1);

    const found = store.findAllPendingRuns();
    assertEquals(found.length, 1);
    const updatedPayload = JSON.parse(found[0].payload!);
    assertEquals(updatedPayload.headers, { "x-github-event": "push" });
  } finally {
    store.close();
  }
});

Deno.test("scrubPendingRunHeaders: leaves rows with no headers unchanged", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    const payload = JSON.stringify({ body: {} });
    store.enqueuePendingRun(makePendingRun({ id: "pr-no-headers", payload }));

    const scrubbed = store.scrubPendingRunHeaders(isSensitiveHeader);
    assertEquals(scrubbed, 0);
  } finally {
    store.close();
  }
});

Deno.test("scrubPendingRunHeaders: handles null payload gracefully", () => {
  const store = new RunTrackerStore(makeTempDbPath());
  try {
    store.enqueuePendingRun(makePendingRun({ id: "pr-null-payload" }));

    const scrubbed = store.scrubPendingRunHeaders(isSensitiveHeader);
    assertEquals(scrubbed, 0);
  } finally {
    store.close();
  }
});
