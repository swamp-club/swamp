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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { DataRecord } from "../domain/data/data_record.ts";
import type { Namespace } from "../domain/data/namespace.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import {
  type BookkeepingGcDeps,
  bookkeepingListPredicate,
  createWorkerTokenNameQuery,
  enrollmentTokenListPredicate,
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

function tokenRecord(
  name: string,
  fields: { state: string; expiresAt: string; revokedAt?: string },
): DataRecord {
  return {
    name: "token-main",
    modelId: `token-model-${name}`,
    attributes: {
      name,
      state: fields.state,
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: fields.expiresAt,
      vaultName: "default",
      secretKey: `worker-token-${name}`,
      maxEnrollments: 1,
      bindings: [],
      ...(fields.revokedAt ? { revokedAt: fields.revokedAt } : {}),
    },
  } as unknown as DataRecord;
}

interface Harness {
  deps: BookkeepingGcDeps;
  /**
   * Ordered log of `delete:<name>` and `push` events. A delete or push made
   * while the sync gate is not held exclusively is logged with an
   * `UNGATED ` prefix, so any assertion on the log also pins the gating.
   */
  events: string[];
  predicates: string[];
}

function harness(opts: {
  leases?: DataRecord[];
  dispatches?: DataRecord[];
  tokens?: DataRecord[];
  /** Wires `listWorkerTokenNames`; an Error makes it reject. */
  workerTokenNames?: string[] | Error;
  sync?: boolean;
  batchSize?: number;
  failDelete?: Set<string>;
  failPush?: boolean;
  missingOnDisk?: Set<string>;
  /** Records whose body read throws. */
  unreadableBody?: Set<string>;
  /** Records whose body is not JSON. */
  corruptBody?: Set<string>;
}): Harness {
  const events: string[] = [];
  const predicates: string[] = [];
  const gate = createSyncGate();
  const gated = (event: string) =>
    events.push(gate.exclusiveHeld ? event : `UNGATED ${event}`);
  const bodies = new Map<string, unknown>();
  // Keyed by modelId + name: every token record shares the data name.
  const key = (id: string, name: string) => `${id}/${name}`;
  for (
    const r of [
      ...(opts.leases ?? []),
      ...(opts.dispatches ?? []),
      ...(opts.tokens ?? []),
    ]
  ) {
    bodies.set(key(r.modelId, r.name), r.attributes);
  }
  const deps: BookkeepingGcDeps = {
    // References only, as serve wires it: bodies come from getContent.
    query: (predicate) => {
      predicates.push(predicate);
      const records = predicate.includes("swamp/step-lease")
        ? opts.leases ?? []
        : predicate.includes("swamp/enrollment-token")
        ? opts.tokens ?? []
        : opts.dispatches ?? [];
      return Promise.resolve(
        records.map((r) => ({ modelId: r.modelId, name: r.name })),
      );
    },
    repo: {
      namespace: "team-a" as Namespace,
      getContent: (_type: ModelType | string, id: string, name: string) => {
        if (opts.unreadableBody?.has(name)) {
          return Promise.reject(new Error(`EIO reading ${name}`));
        }
        if (opts.corruptBody?.has(name)) {
          return Promise.resolve(new TextEncoder().encode("{not json"));
        }
        const body = bodies.get(key(id, name));
        return Promise.resolve(
          body === undefined
            ? null
            : new TextEncoder().encode(JSON.stringify(body)),
        );
      },
      listVersions: (_type: ModelType, _id: string, name: string) =>
        Promise.resolve(opts.missingOnDisk?.has(name) ? [] : [1, 2]),
      delete: (type: ModelType, id: string, name: string) => {
        if (opts.failDelete?.has(name)) {
          return Promise.reject(new Error(`cannot delete ${name}`));
        }
        gated(
          type.normalized === "swamp/enrollment-token"
            ? `delete:${id}`
            : `delete:${name}`,
        );
        return Promise.resolve();
      },
    },
    syncService: opts.sync === false ? undefined : {
      pushChanged: () => {
        gated("push");
        return opts.failPush
          ? Promise.reject(new Error("push down"))
          : Promise.resolve();
      },
    },
    syncGate: gate,
    batchSize: opts.batchSize,
    ...(opts.workerTokenNames === undefined ? {} : {
      listWorkerTokenNames: () => {
        const names = opts.workerTokenNames;
        return names instanceof Error
          ? Promise.reject(names)
          : Promise.resolve(new Set(names));
      },
    }),
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
    tokensDeleted: 0,
    failed: 0,
    unreadable: 0,
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

Deno.test("reapEndedBookkeepingRecords: an unreadable or corrupt record is skipped, the rest are still reaped", async () => {
  const h = harness({
    leases: [
      leaseRecord("eio", "completed", OLD),
      leaseRecord("garbled", "completed", OLD),
      leaseRecord("ok", "completed", OLD),
    ],
    dispatches: [dispatchRecord("sent", "dispatched", OLD)],
    unreadableBody: new Set(["lease-eio"]),
    corruptBody: new Set(["lease-garbled"]),
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, ["delete:lease-ok", "delete:pending-sent", "push"]);
  assertEquals(result.unreadable, 2);
  assertEquals(result.leasesDeleted, 1);
  assertEquals(result.dispatchesDeleted, 1);
});

const FUTURE = new Date(NOW + 10 * GRACE).toISOString();

Deno.test("enrollmentTokenListPredicate: scopes to token records in the own namespace", () => {
  assertEquals(
    enrollmentTokenListPredicate("team-a"),
    'modelType == "swamp/enrollment-token" && name == "token-main" && ns == "team-a"',
  );
});

Deno.test("reapEndedBookkeepingRecords: reaps revoked and expired tokens past grace, keeps live, young and referenced ones", async () => {
  const h = harness({
    tokens: [
      tokenRecord("revoked-old", {
        state: "revoked",
        expiresAt: FUTURE,
        revokedAt: OLD,
      }),
      tokenRecord("expired-old", { state: "expired", expiresAt: OLD }),
      // Never marked expired, but its lifetime ended long ago.
      tokenRecord("lapsed-old", { state: "enrolled", expiresAt: OLD }),
      tokenRecord("active", { state: "enrolled", expiresAt: FUTURE }),
      tokenRecord("unused", { state: "unused", expiresAt: FUTURE }),
      tokenRecord("revoked-young", {
        state: "revoked",
        expiresAt: FUTURE,
        revokedAt: RECENT,
      }),
      tokenRecord("expired-young", { state: "expired", expiresAt: RECENT }),
      tokenRecord("bound", {
        state: "revoked",
        expiresAt: OLD,
        revokedAt: OLD,
      }),
    ],
    workerTokenNames: ["bound"],
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, [
    "delete:token-model-revoked-old",
    "delete:token-model-expired-old",
    "delete:token-model-lapsed-old",
    "push",
  ]);
  assertEquals(result.tokensDeleted, 3);
  assertEquals(result.leasesDeleted, 0);
  assertEquals(result.batches, 1);
});

Deno.test("reapEndedBookkeepingRecords: tokens are not reaped without the worker reference lookup", async () => {
  const h = harness({
    tokens: [tokenRecord("expired-old", { state: "expired", expiresAt: OLD })],
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, []);
  assertEquals(result.tokensDeleted, 0);
  assertEquals(
    h.predicates.some((p) => p.includes("swamp/enrollment-token")),
    false,
  );
});

Deno.test("reapEndedBookkeepingRecords: a failed worker reference lookup skips tokens, leases are still reaped", async () => {
  const h = harness({
    leases: [leaseRecord("old-done", "completed", OLD)],
    tokens: [tokenRecord("expired-old", { state: "expired", expiresAt: OLD })],
    workerTokenNames: new Error("catalog down"),
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, ["delete:lease-old-done", "push"]);
  assertEquals(result.tokensDeleted, 0);
  assertEquals(result.leasesDeleted, 1);
});

Deno.test("reapEndedBookkeepingRecords: tokens are reaped in gated batches", async () => {
  const h = harness({
    tokens: [
      tokenRecord("a", { state: "expired", expiresAt: OLD }),
      tokenRecord("b", { state: "expired", expiresAt: OLD }),
      tokenRecord("c", { state: "expired", expiresAt: OLD }),
    ],
    workerTokenNames: [],
    batchSize: 2,
  });
  const result = await reapEndedBookkeepingRecords(h.deps, GRACE);
  assertEquals(h.events, [
    "delete:token-model-a",
    "delete:token-model-b",
    "push",
    "delete:token-model-c",
    "push",
  ]);
  assertEquals(result.tokensDeleted, 3);
  assertEquals(result.batches, 2);
});

Deno.test("createWorkerTokenNameQuery: collects worker token names from the own namespace", async () => {
  const seen: Array<{ predicate: string; select?: string }> = [];
  const list = createWorkerTokenNameQuery({
    query: (predicate, options) => {
      seen.push({ predicate, select: options?.select });
      return Promise.resolve(["fleet", "solo", "fleet"]);
    },
  }, "team-a");
  assertEquals([...await list()].sort(), ["fleet", "solo"]);
  assertStringIncludes(seen[0].predicate, '"swamp/worker"');
  assertStringIncludes(seen[0].predicate, 'ns == "team-a"');
  assertEquals(seen[0].select, "attributes.tokenName");
});

Deno.test("createWorkerTokenNameQuery: a worker without a readable token name fails the lookup", async () => {
  const list = createWorkerTokenNameQuery({
    query: () => Promise.resolve(["fleet", undefined]),
  }, "team-a");
  await assertRejects(() => list());
});
