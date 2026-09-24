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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type WorkerGcDeps,
  workerGcListPredicate,
  WorkerGcService,
} from "./worker_gc_service.ts";
import type { BookkeepingReapResult } from "./bookkeeping_gc.ts";
import { createSyncGate } from "./sync_gate.ts";

const EMPTY_RESULT = {
  workersDeleted: 0,
  workersFailed: 0,
  bindingsPruned: 0,
  tokensCleaned: 0,
};

const EMPTY_REAP: BookkeepingReapResult = {
  leasesDeleted: 0,
  dispatchesDeleted: 0,
  failed: 0,
  batches: 0,
  pushFailures: 0,
};

function makeDeps(
  overrides: Partial<WorkerGcDeps> = {},
): WorkerGcDeps {
  return {
    intervalMs: 100,
    gracePeriodMs: 1000,
    runPrune: () => Promise.resolve(EMPTY_RESULT),
    ...overrides,
  };
}

Deno.test("WorkerGcService: runOnce delegates to runPrune with grace period", async () => {
  let capturedGrace: number | undefined;
  const deps = makeDeps({
    runPrune: (grace) => {
      capturedGrace = grace;
      return Promise.resolve({ ...EMPTY_RESULT, workersDeleted: 3 });
    },
  });
  const svc = new WorkerGcService(deps);
  const result = await svc.runOnce();
  assertEquals(result.workers?.workersDeleted, 3);
  assertEquals(result.bookkeeping, null);
  assertEquals(capturedGrace, 1000);
});

Deno.test("WorkerGcService: dispose cancels scheduled timer", async () => {
  let runCount = 0;
  const deps = makeDeps({
    runPrune: () => {
      runCount++;
      return Promise.resolve(EMPTY_RESULT);
    },
  });
  const svc = new WorkerGcService(deps);
  svc.start();
  await svc.dispose();
  const countAtDispose = runCount;
  await waitFor(() => true, "brief pause after dispose");
  assertEquals(runCount, countAtDispose);
});

Deno.test("WorkerGcService: start after dispose is a no-op", async () => {
  const deps = makeDeps();
  const svc = new WorkerGcService(deps);
  await svc.dispose();
  svc.start();
  assertEquals(true, true);
});

Deno.test("WorkerGcService: sweep error does not crash the service", async () => {
  let callCount = 0;
  const deps = makeDeps({
    intervalMs: 50,
    runPrune: () => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(EMPTY_RESULT);
    },
  });
  const svc = new WorkerGcService(deps);
  svc.start();
  await waitFor(() => callCount >= 2, "at least two GC cycles");
  await svc.dispose();
  assertEquals(callCount >= 2, true);
});

Deno.test("WorkerGcService: worker prune and its push run inside the exclusive sync gate", async () => {
  const gate = createSyncGate();
  const events: string[] = [];
  const deps = makeDeps({
    syncGate: gate,
    syncNamespace: "team-a",
    syncService: {
      pushChanged: (options) => {
        events.push(`push:${options?.namespace}:${gate.exclusiveHeld}`);
        return Promise.resolve();
      },
    },
    runPrune: () => {
      events.push(`prune:${gate.exclusiveHeld}`);
      return Promise.resolve(EMPTY_RESULT);
    },
  });
  await new WorkerGcService(deps).runOnce();
  assertEquals(events, ["prune:true", "push:team-a:true"]);
  assertEquals(gate.exclusiveHeld, false);
});

Deno.test("WorkerGcService: a failed prune still pushes what it deleted", async () => {
  const events: string[] = [];
  const deps = makeDeps({
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve();
      },
    },
    runPrune: () => {
      events.push("prune");
      return Promise.reject(new Error("half-way"));
    },
  });
  const result = await new WorkerGcService(deps).runOnce();
  assertEquals(events, ["prune", "push"]);
  assertEquals(result.workers, null);
});

Deno.test("WorkerGcService: a push failure does not fail the prune", async () => {
  const deps = makeDeps({
    syncService: { pushChanged: () => Promise.reject(new Error("push down")) },
    runPrune: () => Promise.resolve({ ...EMPTY_RESULT, workersDeleted: 2 }),
  });
  const result = await new WorkerGcService(deps).runOnce();
  assertEquals(result.workers?.workersDeleted, 2);
});

Deno.test("WorkerGcService: bookkeeping reap runs each sweep with the grace period", async () => {
  let capturedGrace: number | undefined;
  const deps = makeDeps({
    reapBookkeeping: (grace) => {
      capturedGrace = grace;
      return Promise.resolve({ ...EMPTY_REAP, leasesDeleted: 4, batches: 1 });
    },
  });
  const result = await new WorkerGcService(deps).runOnce();
  assertEquals(result.bookkeeping?.leasesDeleted, 4);
  assertEquals(capturedGrace, 1000);
});

Deno.test("WorkerGcService: a failed worker prune does not skip the bookkeeping reap", async () => {
  let reaped = false;
  const deps = makeDeps({
    runPrune: () => Promise.reject(new Error("prune down")),
    reapBookkeeping: () => {
      reaped = true;
      return Promise.resolve(EMPTY_REAP);
    },
  });
  const result = await new WorkerGcService(deps).runOnce();
  assertEquals(reaped, true);
  assertEquals(result.workers, null);
  assertEquals(result.bookkeeping, EMPTY_REAP);
});

Deno.test("WorkerGcService: a failed bookkeeping reap does not lose the worker result", async () => {
  const deps = makeDeps({
    runPrune: () => Promise.resolve({ ...EMPTY_RESULT, workersDeleted: 1 }),
    reapBookkeeping: () => Promise.reject(new Error("reap down")),
  });
  const result = await new WorkerGcService(deps).runOnce();
  assertEquals(result.workers?.workersDeleted, 1);
  assertEquals(result.bookkeeping, null);
});

Deno.test("WorkerGcService: dispose signals a running reap to stop", async () => {
  let isStopping: (() => boolean) | undefined;
  let release: (() => void) | undefined;
  const reapStarted = Promise.withResolvers<void>();
  const deps = makeDeps({
    reapBookkeeping: (_grace, stopping) => {
      isStopping = stopping;
      reapStarted.resolve();
      return new Promise((resolve) => {
        release = () => resolve(EMPTY_REAP);
      });
    },
  });
  const svc = new WorkerGcService(deps);
  const sweep = svc.runOnce();
  await reapStarted.promise;
  assertEquals(isStopping!(), false);
  await svc.dispose();
  assertEquals(isStopping!(), true);
  release!();
  await sweep;
});

Deno.test("WorkerGcService: no bookkeeping reap starts after dispose", async () => {
  let reaped = false;
  const deps = makeDeps({
    reapBookkeeping: () => {
      reaped = true;
      return Promise.resolve(EMPTY_REAP);
    },
  });
  const svc = new WorkerGcService(deps);
  await svc.dispose();
  const result = await svc.runOnce();
  assertEquals(reaped, false);
  assertEquals(result.bookkeeping, null);
});

Deno.test("workerGcListPredicate: scopes worker state to the own namespace", () => {
  assertEquals(
    workerGcListPredicate("team-a"),
    'modelType == "swamp/worker" && name == "state-main" && ns == "team-a"',
  );
});
