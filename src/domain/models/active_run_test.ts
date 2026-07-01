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

import { assertEquals, assertThrows } from "@std/assert";
import { ActiveRun } from "./active_run.ts";

Deno.test("ActiveRun.createModelMethodRun: creates with running status", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  assertEquals(run.id, "test-id");
  assertEquals(run.runKind, "model_method");
  assertEquals(run.modelType, "@test/model");
  assertEquals(run.methodName, "start");
  assertEquals(run.workflowName, null);
  assertEquals(run.pid, 1234);
  assertEquals(run.hostname, "test-host");
  assertEquals(run.status, "running");
});

Deno.test("ActiveRun.markCompleted: transitions from running to completed", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markCompleted();
  assertEquals(run.status, "completed");
});

Deno.test("ActiveRun.markFailed: transitions from running to failed", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markFailed();
  assertEquals(run.status, "failed");
});

Deno.test("ActiveRun.markCancelled: transitions from running to cancelled", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markCancelled();
  assertEquals(run.status, "cancelled");
});

Deno.test("ActiveRun.markCompleted: throws from non-running status", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markCompleted();
  assertThrows(
    () => run.markCompleted(),
    Error,
    "Cannot mark run as completed from status 'completed'",
  );
});

Deno.test("ActiveRun.markFailed: throws from non-running status", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markFailed();
  assertThrows(
    () => run.markFailed(),
    Error,
    "Cannot mark run as failed from status 'failed'",
  );
});

Deno.test("ActiveRun.recordHeartbeat: updates heartbeat time", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  const before = run.heartbeatAt;
  // Small delay to ensure time difference
  const spinUntil = Date.now() + 2;
  while (Date.now() < spinUntil) { /* spin */ }
  run.recordHeartbeat();
  assertEquals(run.heartbeatAt.getTime() >= before.getTime(), true);
});

Deno.test("ActiveRun.recordHeartbeat: throws from non-running status", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markCompleted();
  assertThrows(
    () => run.recordHeartbeat(),
    Error,
    "Cannot heartbeat a run in status 'completed'",
  );
});

Deno.test("ActiveRun.isStale: returns false when heartbeat is fresh", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  assertEquals(run.isStale(90_000), false);
});

Deno.test("ActiveRun.isStale: returns true when heartbeat exceeds TTL", () => {
  const run = ActiveRun.fromData({
    id: "test-id",
    runKind: "model_method",
    modelType: "@test/model",
    methodName: "start",
    workflowName: null,
    pid: 1234,
    hostname: "test-host",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    status: "running",
  });

  assertEquals(run.isStale(90_000), true);
});

Deno.test("ActiveRun.isStale: returns false for non-running status", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  run.markCompleted();
  assertEquals(run.isStale(0), false);
});

Deno.test("ActiveRun.toData: roundtrips through fromData", () => {
  const run = ActiveRun.createModelMethodRun({
    id: "test-id",
    modelType: "@test/model",
    methodName: "start",
    pid: 1234,
    hostname: "test-host",
  });

  const data = run.toData();
  const restored = ActiveRun.fromData(data);

  assertEquals(restored.id, run.id);
  assertEquals(restored.runKind, run.runKind);
  assertEquals(restored.modelType, run.modelType);
  assertEquals(restored.methodName, run.methodName);
  assertEquals(restored.pid, run.pid);
  assertEquals(restored.hostname, run.hostname);
  assertEquals(restored.status, run.status);
});
