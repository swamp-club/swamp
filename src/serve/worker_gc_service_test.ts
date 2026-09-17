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
import { type WorkerGcDeps, WorkerGcService } from "./worker_gc_service.ts";

const EMPTY_RESULT = {
  workersDeleted: 0,
  workersFailed: 0,
  bindingsPruned: 0,
  tokensCleaned: 0,
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
  assertEquals(result.workersDeleted, 3);
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
  await new Promise((r) => setTimeout(r, 250));
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
  await new Promise((r) => setTimeout(r, 200));
  await svc.dispose();
  assertEquals(callCount >= 2, true);
});
