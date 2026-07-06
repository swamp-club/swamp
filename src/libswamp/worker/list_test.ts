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
  effectiveTokenState,
  workerList,
  type WorkerListDeps,
  type WorkerListEvent,
  workerTokenList,
  type WorkerTokenListEvent,
} from "./list.ts";

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
    createdAt: "2026-06-09T00:00:00.000Z",
    namespace: "",
    attributes,
    tags: {},
    modelName,
    modelId: modelName,
    modelType: "swamp/enrollment-token",
    specName: "token",
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

function tokenAttributes(
  name: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    state: "unused",
    createdAt: "2026-06-09T00:00:00.000Z",
    expiresAt: "2026-06-10T00:00:00.000Z",
    vaultName: "main-vault",
    secretKey: `worker-token-${name}`,
    ...overrides,
  };
}

function workerAttributes(
  name: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    instanceUuid: "uuid-1",
    tokenName: name,
    status: "idle",
    labels: { os: "linux" },
    platform: "linux",
    arch: "x86_64",
    swampVersion: "1.0.0",
    protocolVersion: 1,
    enrolledAt: "2026-06-09T00:00:00.000Z",
    lastSeenAt: "2026-06-09T01:00:00.000Z",
    capacity: 1,
    activeDispatchIds: [],
    ...overrides,
  };
}

const NOW = Date.parse("2026-06-09T12:00:00.000Z");

function makeDeps(records: DataRecord[]): WorkerListDeps {
  return {
    query: () => Promise.resolve(records),
    now: () => NOW,
  };
}

Deno.test("workerTokenList: yields resolving then completed with mapped tokens", async () => {
  const deps = makeDeps([
    makeRecord("ci-runner-1", "token-main", tokenAttributes("ci-runner-1")),
  ]);
  const events = await collect<WorkerTokenListEvent>(
    workerTokenList(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.count, 1);
  assertEquals(completed.data.tokens[0].name, "ci-runner-1");
  assertEquals(completed.data.tokens[0].state, "unused");
  assertEquals(completed.data.tokens[0].effectiveState, "unused");
  assertEquals(completed.data.tokens[0].vaultName, "main-vault");
  assertEquals(completed.data.tokens[0].secretKey, "worker-token-ci-runner-1");
});

Deno.test("workerTokenList: overlays expired display state on stale live tokens", async () => {
  const deps = makeDeps([
    makeRecord(
      "stale",
      "token-main",
      tokenAttributes("stale", {
        state: "enrolled",
        expiresAt: "2026-06-09T06:00:00.000Z",
        boundMachineId: "machine-9",
      }),
    ),
  ]);
  const events = await collect<WorkerTokenListEvent>(
    workerTokenList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.tokens[0].state, "enrolled");
  assertEquals(completed.data.tokens[0].effectiveState, "expired");
  assertEquals(completed.data.tokens[0].bindingCount, 1);
  assertEquals(completed.data.tokens[0].bindings[0].machineId, "machine-9");
});

Deno.test("workerTokenList: skips malformed records and sorts by name", async () => {
  const deps = makeDeps([
    makeRecord("zeta", "token-main", tokenAttributes("zeta")),
    makeRecord("broken", "token-main", { nonsense: true }),
    makeRecord("alpha", "token-main", tokenAttributes("alpha")),
  ]);
  const events = await collect<WorkerTokenListEvent>(
    workerTokenList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 2);
  assertEquals(
    completed.data.tokens.map((token) => token.name),
    ["alpha", "zeta"],
  );
});

Deno.test("workerTokenList: yields error when the query fails", async () => {
  const deps: WorkerListDeps = {
    query: () => Promise.reject(new Error("catalog unavailable")),
  };
  const events = await collect<WorkerTokenListEvent>(
    workerTokenList(createLibSwampContext(), deps),
  );
  const error = events[1] as Extract<WorkerTokenListEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "catalog unavailable");
});

Deno.test("workerList: yields completed with mapped workers sorted by name", async () => {
  const deps = makeDeps([
    makeRecord("worker-b", "state-main", workerAttributes("worker-b")),
    makeRecord(
      "worker-a",
      "state-main",
      workerAttributes("worker-a", {
        status: "busy",
        capacity: 1,
        activeDispatchIds: ["dispatch-7"],
      }),
    ),
  ]);
  const events = await collect<WorkerListEvent>(
    workerList(createLibSwampContext(), deps),
  );

  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkerListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 2);
  assertEquals(
    completed.data.workers.map((worker) => worker.name),
    ["worker-a", "worker-b"],
  );
  assertEquals(completed.data.workers[0].status, "busy");
  assertEquals(completed.data.workers[0].activeDispatchIds, ["dispatch-7"]);
  assertEquals(completed.data.workers[1].labels, { os: "linux" });
  assertEquals(completed.data.workers[1].platform, "linux");
  assertEquals(completed.data.workers[1].arch, "x86_64");
});

Deno.test("workerList: skips malformed worker records", async () => {
  const deps = makeDeps([
    makeRecord("ok", "state-main", workerAttributes("ok")),
    makeRecord("bad", "state-main", { status: "idle" }),
  ]);
  const events = await collect<WorkerListEvent>(
    workerList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    WorkerListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 1);
  assertEquals(completed.data.workers[0].name, "ok");
});

Deno.test("workerList: yields error when the query fails", async () => {
  const deps: WorkerListDeps = {
    query: () => Promise.reject(new Error("boom")),
  };
  const events = await collect<WorkerListEvent>(
    workerList(createLibSwampContext(), deps),
  );
  const error = events[1] as Extract<WorkerListEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "boom");
});

Deno.test("effectiveTokenState: live states past expiry display as expired", () => {
  const past = "2026-06-09T00:00:00.000Z";
  const future = "2026-06-10T00:00:00.000Z";
  assertEquals(effectiveTokenState("unused", past, NOW), "expired");
  assertEquals(effectiveTokenState("enrolled", past, NOW), "expired");
  assertEquals(effectiveTokenState("unused", future, NOW), "unused");
  assertEquals(effectiveTokenState("enrolled", future, NOW), "enrolled");
  assertEquals(effectiveTokenState("revoked", past, NOW), "revoked");
  assertEquals(effectiveTokenState("expired", future, NOW), "expired");
});
