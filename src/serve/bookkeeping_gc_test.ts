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
import type { DataRecord } from "../domain/data/data_record.ts";
import type { Namespace } from "../domain/data/namespace.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import {
  type BookkeepingGcDeps,
  bookkeepingListPredicate,
  reapEndedBookkeepingRecords,
} from "./bookkeeping_gc.ts";
import { createSyncGate } from "./sync_gate.ts";
import { STEP_LEASE_MODEL_TYPE } from "../domain/models/worker/step_lease_model.ts";

const GRACE = 1000;
const NOW = Date.parse("2026-09-10T00:00:00.000Z");
const OLD = new Date(NOW - 2 * GRACE).toISOString();
const RECENT = new Date(NOW - GRACE / 2).toISOString();

function leaseRecord(id: string, state: string, endedAt?: string): DataRecord {
  return {
    name: `lease-${id}`,
    modelId: "leases-model",
    attributes: {
      leaseId: id,
      dispatchId: `d-${id}`,
      workerName: "w",
      modelType: "command/shell",
      modelId: "m",
      methodName: "execute",
      state,
      hasWrites: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      ...(endedAt ? { endedAt } : {}),
    },
  } as unknown as DataRecord;
}

function dispatchRecord(
  id: string,
  state: string,
  endedAt?: string,
): DataRecord {
  return {
    name: `pending-${id}`,
    modelId: "pending-model",
    attributes: {
      queueId: id,
      state,
      modelType: "command/shell",
      methodName: "execute",
      queuedAt: "2026-09-01T00:00:00.000Z",
      ...(endedAt ? { endedAt } : {}),
    },
  } as unknown as DataRecord;
}

interface Harness {
  deps: BookkeepingGcDeps;
  /** Ordered log of `delete:<name>` and `push` events. */
  events: string[];
  predicates: string[];
}

function harness(opts: {
  leases?: DataRecord[];
  dispatches?: DataRecord[];
  sync?: boolean;
  batchSize?: number;
  failDelete?: Set<string>;
  failPush?: boolean;
  missingOnDisk?: Set<string>;
}): Harness {
  const events: string[] = [];
  const predicates: string[] = [];
  const deps: BookkeepingGcDeps = {
    query: (predicate) => {
      predicates.push(predicate);
      if (predicate.includes("swamp/step-lease")) {
        return Promise.resolve(opts.leases ?? []);
      }
      return Promise.resolve(opts.dispatches ?? []);
    },
    repo: {
      namespace: "team-a" as Namespace,
      listVersions: (_type: ModelType, _id: string, name: string) =>
        Promise.resolve(opts.missingOnDisk?.has(name) ? [] : [1, 2]),
      delete: (_type: ModelType, _id: string, name: string) => {
        if (opts.failDelete?.has(name)) {
          return Promise.reject(new Error(`cannot delete ${name}`));
        }
        events.push(`delete:${name}`);
        return Promise.resolve();
      },
    },
    syncService: opts.sync === false ? undefined : {
      pushChanged: () => {
        events.push("push");
        return opts.failPush
          ? Promise.reject(new Error("push down"))
          : Promise.resolve();
      },
    },
    syncGate: createSyncGate(),
    batchSize: opts.batchSize,
    now: () => NOW,
  };
  return { deps, events, predicates };
}

Deno.test("bookkeepingListPredicate: scopes to the instance and own namespace", () => {
  const predicate = bookkeepingListPredicate(
    STEP_LEASE_MODEL_TYPE,
    "leases",
    "team-a",
  );
  assertEquals(
    predicate,
    'modelType == "swamp/step-lease" && modelName == "leases" && ns == "team-a"',
  );
});

Deno.test("reapEndedBookkeepingRecords: queries only the repo's own namespace", async () => {
  const h = harness({});
  await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.predicates.length, 2);
  for (const predicate of h.predicates) {
    assertStringIncludes(predicate, 'ns == "team-a"');
  }
});

Deno.test("reapEndedBookkeepingRecords: deletes only ended records past grace", async () => {
  const h = harness({
    leases: [
      leaseRecord("old-done", "completed", OLD),
      leaseRecord("old-failed", "failed", OLD),
      leaseRecord("recent", "completed", RECENT),
      leaseRecord("live", "active"),
    ],
    dispatches: [
      dispatchRecord("old-sent", "dispatched", OLD),
      dispatchRecord("waiting", "waiting"),
    ],
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, [
    "delete:lease-old-done",
    "delete:lease-old-failed",
    "delete:pending-old-sent",
    "push",
  ]);
  assertEquals(result, {
    leasesDeleted: 2,
    dispatchesDeleted: 1,
    failed: 0,
    batches: 1,
    pushFailures: 0,
  });
});

Deno.test("reapEndedBookkeepingRecords: nothing to reap takes no gate and pushes nothing", async () => {
  const h = harness({ leases: [leaseRecord("live", "active")] });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, []);
  assertEquals(result.batches, 0);
});

Deno.test("reapEndedBookkeepingRecords: each batch deletes then pushes before the next", async () => {
  const h = harness({
    batchSize: 2,
    leases: ["a", "b", "c", "d", "e"].map((id) =>
      leaseRecord(id, "completed", OLD)
    ),
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, [
    "delete:lease-a",
    "delete:lease-b",
    "push",
    "delete:lease-c",
    "delete:lease-d",
    "push",
    "delete:lease-e",
    "push",
  ]);
  assertEquals(result.batches, 3);
  assertEquals(result.leasesDeleted, 5);
});

Deno.test("reapEndedBookkeepingRecords: a failed delete is counted and the batch still pushes", async () => {
  const h = harness({
    leases: [
      leaseRecord("a", "completed", OLD),
      leaseRecord("b", "completed", OLD),
    ],
    failDelete: new Set(["lease-a"]),
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, ["delete:lease-b", "push"]);
  assertEquals(result.failed, 1);
  assertEquals(result.leasesDeleted, 1);
});

Deno.test("reapEndedBookkeepingRecords: a push failure is counted, not thrown", async () => {
  const h = harness({
    batchSize: 1,
    leases: [
      leaseRecord("a", "completed", OLD),
      leaseRecord("b", "completed", OLD),
    ],
    failPush: true,
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(result.pushFailures, 2);
  assertEquals(result.leasesDeleted, 2);
  assertEquals(h.events, [
    "delete:lease-a",
    "push",
    "delete:lease-b",
    "push",
  ]);
});

Deno.test("reapEndedBookkeepingRecords: a record already gone from disk is not counted", async () => {
  const h = harness({
    leases: [leaseRecord("ghost", "completed", OLD)],
    missingOnDisk: new Set(["lease-ghost"]),
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  // Still deleted, so a stale catalog row is dropped.
  assertEquals(h.events, ["delete:lease-ghost", "push"]);
  assertEquals(result.leasesDeleted, 0);
});

Deno.test("reapEndedBookkeepingRecords: without a sync service nothing is pushed", async () => {
  const h = harness({
    sync: false,
    leases: [leaseRecord("a", "completed", OLD)],
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, ["delete:lease-a"]);
  assertEquals(result.leasesDeleted, 1);
});

Deno.test("reapEndedBookkeepingRecords: stops between records once stopping, still pushing the partial batch", async () => {
  const h = harness({
    batchSize: 10,
    leases: ["a", "b", "c"].map((id) => leaseRecord(id, "completed", OLD)),
  });
  const result = await reapEndedBookkeepingRecords(
    h.deps,
    GRACE,
    () => h.events.length >= 1,
  );
  assertEquals(h.events, ["delete:lease-a", "push"]);
  assertEquals(result.leasesDeleted, 1);
});

Deno.test("reapEndedBookkeepingRecords: stops between batches once stopping", async () => {
  const h = harness({
    batchSize: 1,
    leases: ["a", "b", "c"].map((id) => leaseRecord(id, "completed", OLD)),
  });
  const result = await reapEndedBookkeepingRecords(
    h.deps,
    GRACE,
    () => h.events.includes("push"),
  );
  assertEquals(h.events, ["delete:lease-a", "push"]);
  assertEquals(result.batches, 1);
});
