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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Environment } from "cel-js";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  leaseListPredicate,
  workerLeaseList,
  type WorkerLeaseListDeps,
  type WorkerLeaseListEvent,
} from "./lease_list.ts";

const NOW = Date.parse("2026-06-09T12:00:00.000Z");

function leaseRecord(
  id: string,
  overrides?: Record<string, unknown>,
): DataRecord {
  return {
    id: `rec-${id}`,
    name: `lease-${id}`,
    version: 1,
    isLatest: true,
    createdAt: "2026-06-09T11:59:00.000Z",
    attributes: {
      leaseId: id,
      dispatchId: id,
      workerName: "gpu-1",
      modelType: "command/shell",
      modelId: "m-1",
      methodName: "execute",
      workflowName: "train",
      workflowRunId: "run-7",
      stepName: "fit",
      state: "active",
      hasWrites: false,
      createdAt: "2026-06-09T11:58:00.000Z",
      ...overrides,
    },
  } as unknown as DataRecord;
}

function deps(
  records: DataRecord[],
  seen: string[] = [],
): WorkerLeaseListDeps {
  return {
    namespace: "repo-ns",
    now: () => NOW,
    query: (predicate) => {
      seen.push(predicate);
      return Promise.resolve(records);
    },
  };
}

function completed(events: WorkerLeaseListEvent[]) {
  return (events[1] as Extract<WorkerLeaseListEvent, { kind: "completed" }>)
    .data;
}

Deno.test("leaseListPredicate: selects by lease name and recency, scoped to the repo", () => {
  const predicate = leaseListPredicate(
    "repo-ns",
    ["d-1", "d-2"],
    "2026-06-09T11:59:50.000Z",
  );
  assert(predicate !== undefined);
  assertStringIncludes(predicate, 'modelName == "leases"');
  assertStringIncludes(predicate, 'ns == "repo-ns"');
  assertStringIncludes(predicate, 'name in ["lease-d-1", "lease-d-2"]');
  assertStringIncludes(predicate, 'createdAt >= "2026-06-09T11:59:50.000Z"');
  assert(!predicate.includes("attributes."));
});

Deno.test("leaseListPredicate: quotes ids so they cannot alter the expression", () => {
  const predicate = leaseListPredicate("ns", ['x" || true || "'], undefined);
  assert(predicate !== undefined);
  const env = new Environment({ unlistedVariablesAreDyn: true });
  const record = {
    modelType: "swamp/step-lease",
    modelName: "leases",
    ns: "ns",
    name: "lease-other",
    createdAt: "2026-06-09T00:00:00.000Z",
  };
  assertEquals(env.evaluate(predicate, record), false);
});

Deno.test("leaseListPredicate: evaluates name and recency terms with the query engine's CEL", () => {
  const predicate = leaseListPredicate(
    "ns",
    ["d-1"],
    "2026-06-09T11:59:50.000Z",
  );
  assert(predicate !== undefined);
  const env = new Environment({ unlistedVariablesAreDyn: true });
  const base = {
    modelType: "swamp/step-lease",
    modelName: "leases",
    ns: "ns",
  };
  const active = {
    ...base,
    name: "lease-d-1",
    createdAt: "2026-06-09T10:00:00.000Z",
  };
  const recent = {
    ...base,
    name: "lease-d-9",
    createdAt: "2026-06-09T11:59:55.000Z",
  };
  const stale = {
    ...base,
    name: "lease-d-9",
    createdAt: "2026-06-09T11:00:00.000Z",
  };
  const foreign = { ...active, ns: "other" };
  assertEquals(env.evaluate(predicate, active), true);
  assertEquals(env.evaluate(predicate, recent), true);
  assertEquals(env.evaluate(predicate, stale), false);
  assertEquals(env.evaluate(predicate, foreign), false);
});

Deno.test("leaseListPredicate: returns undefined with nothing to select", () => {
  assertEquals(leaseListPredicate("ns", [], undefined), undefined);
});

Deno.test("workerLeaseList: maps leases and computes the recency cutoff on the server clock", async () => {
  const seen: string[] = [];
  const events = await collect<WorkerLeaseListEvent>(
    workerLeaseList(
      createLibSwampContext(),
      deps([
        leaseRecord("d-2", { workerName: "gpu-2" }),
        leaseRecord("d-1", {
          state: "completed",
          endedAt: "2026-06-09T11:59:58.000Z",
        }),
      ], seen),
      { dispatchIds: ["d-2"], endedWithinMs: 10_000 },
    ),
  );
  assertEquals(events[0], { kind: "resolving" });
  const data = completed(events);
  assertEquals(data.count, 2);
  assertEquals(data.leases.map((l) => l.workerName), ["gpu-1", "gpu-2"]);
  assertEquals(data.leases[0].state, "completed");
  assertEquals(data.leases[0].endedAt, "2026-06-09T11:59:58.000Z");
  assertEquals(data.leases[1].stepName, "fit");
  assertEquals(data.leases[1].workflowRunId, "run-7");
  assertStringIncludes(seen[0], 'createdAt >= "2026-06-09T11:59:50.000Z"');
});

Deno.test("workerLeaseList: skips the query when nothing is requested", async () => {
  const seen: string[] = [];
  const events = await collect<WorkerLeaseListEvent>(
    workerLeaseList(createLibSwampContext(), deps([], seen)),
  );
  assertEquals(seen.length, 0);
  assertEquals(completed(events).count, 0);
});

Deno.test("workerLeaseList: skips malformed lease records", async () => {
  const events = await collect<WorkerLeaseListEvent>(
    workerLeaseList(
      createLibSwampContext(),
      deps([leaseRecord("d-1"), leaseRecord("d-2", { state: "bogus" })]),
      { dispatchIds: ["d-1", "d-2"] },
    ),
  );
  assertEquals(completed(events).count, 1);
});

Deno.test("workerLeaseList: yields error when the query fails", async () => {
  const events = await collect<WorkerLeaseListEvent>(
    workerLeaseList(
      createLibSwampContext(),
      {
        namespace: "ns",
        query: () => Promise.reject(new Error("catalog down")),
      },
      { dispatchIds: ["d-1"] },
    ),
  );
  const error = events[1] as Extract<WorkerLeaseListEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "worker_lease_list_failed");
  assertStringIncludes(error.error.message, "catalog down");
});
