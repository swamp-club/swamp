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
import {
  type PrunableToken,
  type PrunableWorker,
  workerPrune,
  type WorkerPruneDeps,
  type WorkerPruneEvent,
  type WorkerPruneResult,
} from "./prune.ts";
import { createLibSwampContext } from "../context.ts";
import type { ModelDeleteEvent } from "../models/delete.ts";
import type { ModelMethodRunEvent } from "../models/run.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeWorker(
  overrides: Partial<PrunableWorker> = {},
): PrunableWorker {
  return {
    name: "worker-pool-abc",
    definitionName: "worker-worker-pool-abc",
    status: "disconnected",
    tokenName: "pool",
    disconnectedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function makeToken(
  overrides: Partial<PrunableToken> = {},
): PrunableToken {
  return {
    name: "pool",
    bindings: [{ machineId: "machine-abc" }],
    ...overrides,
  };
}

function successDeleteStream(): AsyncIterable<ModelDeleteEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        kind: "completed" as const,
        data: {
          id: "id",
          name: "n",
          type: "swamp/worker",
          inputPath: "/p",
          resourceDeleted: false,
          outputsDeleted: 0,
          evaluatedInputDeleted: true,
          dataDeleted: true,
          expiredDataAutoCollected: 0,
        },
      };
    },
  };
}

function successPruneStream(): AsyncIterable<ModelMethodRunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        kind: "completed" as const,
        run: {
          modelId: "id",
          modelName: "n",
          modelType: "swamp/enrollment-token",
          methodName: "prune_bindings",
          outputId: "id",
          status: "succeeded" as const,
          duration: 1,
          dataArtifacts: [],
          logFile: "/log",
        },
      };
    },
  };
}

function makeDeps(
  workers: PrunableWorker[] = [],
  tokens: PrunableToken[] = [],
  overrides: Partial<WorkerPruneDeps> = {},
): WorkerPruneDeps {
  return {
    listWorkers: async () => workers,
    listTokens: async () => tokens,
    deleteWorker: () => successDeleteStream(),
    pruneBindings: () => successPruneStream(),
    now: () => NOW,
    ...overrides,
  };
}

async function collectEvents(
  gen: AsyncGenerator<WorkerPruneEvent>,
): Promise<WorkerPruneEvent[]> {
  const events: WorkerPruneEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function findResult(
  events: WorkerPruneEvent[],
): WorkerPruneResult | undefined {
  const completed = events.find((e) => e.kind === "completed");
  return completed?.kind === "completed" ? completed.result : undefined;
}

Deno.test("workerPrune: no disconnected workers yields zero counts", async () => {
  const deps = makeDeps([
    makeWorker({ status: "idle" }),
  ]);
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 0);
  assertEquals(result?.workersFailed, 0);
});

Deno.test("workerPrune: all within grace period yields zero counts", async () => {
  const deps = makeDeps([
    makeWorker({ disconnectedAt: new Date(NOW - HOUR_MS).toISOString() }),
  ]);
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 0);
});

Deno.test("workerPrune: dry run does not delete", async () => {
  const deleted: string[] = [];
  const deps = makeDeps(
    [makeWorker()],
    [makeToken()],
    {
      deleteWorker: (name) => {
        deleted.push(name);
        return successDeleteStream();
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: true }),
  );
  assertEquals(deleted.length, 0);
  const preview = events.find((e) => e.kind === "previewing");
  assertEquals(
    preview?.kind === "previewing" ? preview.workers.length : 0,
    1,
  );
});

Deno.test("workerPrune: deletes stale worker and prunes bindings", async () => {
  const deleted: string[] = [];
  const pruned: Array<{ token: string; ids: string[] }> = [];
  const deps = makeDeps(
    [makeWorker()],
    [makeToken()],
    {
      deleteWorker: (name) => {
        deleted.push(name);
        return successDeleteStream();
      },
      pruneBindings: (token, ids) => {
        pruned.push({ token, ids });
        return successPruneStream();
      },
      resolveStaleBindings: async (token, _remaining) => {
        return token.bindings.map((b) => b.machineId);
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(result?.bindingsPruned, 1);
  assertEquals(result?.tokensCleaned, 1);
  assertEquals(deleted, ["worker-worker-pool-abc"]);
  assertEquals(pruned, [{ token: "pool", ids: ["machine-abc"] }]);
});

Deno.test("workerPrune: partial delete failure continues to next worker", async () => {
  let callCount = 0;
  const deps = makeDeps(
    [
      makeWorker({ name: "w1", definitionName: "worker-w1" }),
      makeWorker({ name: "w2", definitionName: "worker-w2" }),
    ],
    [],
    {
      deleteWorker: () => {
        callCount++;
        if (callCount === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                kind: "error" as const,
                error: { code: "test_fail", message: "boom" },
              };
            },
          };
        }
        return successDeleteStream();
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(result?.workersFailed, 1);
  assertEquals(
    events.some((e) => e.kind === "worker_delete_failed"),
    true,
  );
});

Deno.test("workerPrune: mixed prunable and non-prunable workers", async () => {
  const deleted: string[] = [];
  const deps = makeDeps(
    [
      makeWorker({
        name: "stale",
        definitionName: "worker-stale",
      }),
      makeWorker({
        name: "recent",
        definitionName: "worker-recent",
        status: "disconnected",
        disconnectedAt: new Date(NOW - HOUR_MS).toISOString(),
      }),
      makeWorker({
        name: "idle",
        definitionName: "worker-idle",
        status: "idle",
      }),
    ],
    [],
    {
      deleteWorker: (name) => {
        deleted.push(name);
        return successDeleteStream();
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(deleted, ["worker-stale"]);
});

Deno.test("workerPrune: skips binding prune when resolveStaleBindings is not provided", async () => {
  const pruned: string[] = [];
  const deps = makeDeps(
    [makeWorker()],
    [makeToken()],
    {
      pruneBindings: (token) => {
        pruned.push(token);
        return successPruneStream();
      },
      // no resolveStaleBindings → bindings skipped
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(result?.bindingsPruned, 0);
  assertEquals(pruned.length, 0);
});
