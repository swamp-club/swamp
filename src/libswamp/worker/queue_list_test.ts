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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  workerQueueList,
  type WorkerQueueListDeps,
  type WorkerQueueListEvent,
} from "./queue_list.ts";

function makeRecord(
  modelName: string,
  dataName: string,
  attributes: Record<string, unknown>,
): DataRecord {
  return {
    id: `${modelName}-${dataName}`,
    name: dataName,
    version: 1,
    isLatest: true,
    createdAt: "2026-07-04T00:00:00.000Z",
    namespace: "",
    attributes,
    tags: {},
    modelName,
    modelId: modelName,
    modelType: "swamp/pending-dispatch",
    specName: "dispatch",
    dataType: "resource",
    contentType: "application/json",
    lifetime: "infinite",
    ownerType: "model",
    streaming: false,
    size: 0,
    content: "",
    ownerRef: "",
    workflowRunId: "",
    workflowName: "",
    jobName: "",
    stepName: "",
    source: "",
  };
}

function pendingAttributes(
  queueId: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    queueId,
    state: "waiting",
    target: "prod",
    labels: { tier: "smoke" },
    platform: "linux",
    workflowName: "deploy",
    jobName: "main",
    stepName: "build",
    modelType: "@acme/widget",
    methodName: "create",
    queuedAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-04T00:05:00.000Z");

function makeDeps(records: DataRecord[]): WorkerQueueListDeps {
  return {
    query: () => Promise.resolve(records),
    now: () => NOW,
  };
}

Deno.test("workerQueueList: yields resolving then completed with mapped items", async () => {
  const deps = makeDeps([
    makeRecord("pending-1", "pending-q-1", pendingAttributes("q-1")),
  ]);
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.count, 1);
  assertEquals(completed.data.items[0].queueId, "q-1");
  assertEquals(completed.data.items[0].stepName, "build");
  assertEquals(completed.data.items[0].modelType, "@acme/widget");
  assertEquals(completed.data.items[0].ageMs, 5 * 60 * 1000);
});

Deno.test("workerQueueList: formats requirement from target, labels, and platform", async () => {
  const deps = makeDeps([
    makeRecord(
      "p-1",
      "pending-q-1",
      pendingAttributes("q-1", {
        target: "staging",
        labels: { gpu: "true", env: "ci" },
        platform: "linux",
      }),
    ),
  ]);
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "completed" }
  >;
  assertStringIncludes(completed.data.items[0].requirement, "target=staging");
  assertStringIncludes(completed.data.items[0].requirement, "gpu=true");
  assertStringIncludes(completed.data.items[0].requirement, "platform=linux");
});

Deno.test("workerQueueList: formats requirement as 'any worker' when no placement", async () => {
  const deps = makeDeps([
    makeRecord(
      "p-1",
      "pending-q-1",
      pendingAttributes("q-1", {
        target: undefined,
        labels: undefined,
        platform: undefined,
      }),
    ),
  ]);
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.items[0].requirement, "any worker");
});

Deno.test("workerQueueList: sorts by queuedAt (oldest first)", async () => {
  const deps = makeDeps([
    makeRecord(
      "p-2",
      "pending-q-2",
      pendingAttributes("q-2", {
        queuedAt: "2026-07-04T00:02:00.000Z",
      }),
    ),
    makeRecord(
      "p-1",
      "pending-q-1",
      pendingAttributes("q-1", {
        queuedAt: "2026-07-04T00:00:00.000Z",
      }),
    ),
    makeRecord(
      "p-3",
      "pending-q-3",
      pendingAttributes("q-3", {
        queuedAt: "2026-07-04T00:01:00.000Z",
      }),
    ),
  ]);
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "completed" }
  >;
  assertEquals(
    completed.data.items.map((i) => i.queueId),
    ["q-1", "q-3", "q-2"],
  );
});

Deno.test("workerQueueList: skips malformed records via safeParse", async () => {
  const deps = makeDeps([
    makeRecord("ok", "pending-q-1", pendingAttributes("q-1")),
    makeRecord("bad", "pending-q-bad", { nonsense: true }),
  ]);
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 1);
  assertEquals(completed.data.items[0].queueId, "q-1");
});

Deno.test("workerQueueList: empty result when no records match", async () => {
  const deps = makeDeps([]);
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 0);
  assertEquals(completed.data.items, []);
});

Deno.test("workerQueueList: yields error when the query fails", async () => {
  const deps: WorkerQueueListDeps = {
    query: () => Promise.reject(new Error("datastore unreachable")),
  };
  const events = await collect<WorkerQueueListEvent>(
    workerQueueList(createLibSwampContext(), deps),
  );
  const error = events[1] as Extract<
    WorkerQueueListEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "datastore unreachable");
});
