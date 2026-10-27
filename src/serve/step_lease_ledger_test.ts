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
import { methodRunnerLeaseStore } from "./step_lease_ledger.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";

Deno.test("methodRunnerLeaseStore: runs each transition as its step-lease method on the leases instance", async () => {
  const runs: Parameters<ModelMethodRunner>[0][] = [];
  const store = methodRunnerLeaseStore((input) => {
    runs.push(input);
    return Promise.resolve();
  });
  const acquire = {
    leaseId: "l-1",
    dispatchId: "d-1",
    workerName: "w1",
    modelType: "command/shell",
    modelId: "m-1",
    methodName: "execute",
  };

  await store.acquire(acquire);
  await store.markWrites("l-1");
  await store.end("l-1", "completed");
  await store.end("l-1", "failed", "boom");
  await store.end("l-1", "expired", "lost");

  assertEquals(
    runs.map((run) => [run.typeArg, run.definitionName, run.methodName]),
    [
      ["swamp/step-lease", "leases", "acquire"],
      ["swamp/step-lease", "leases", "mark_writes"],
      ["swamp/step-lease", "leases", "complete"],
      ["swamp/step-lease", "leases", "fail"],
      ["swamp/step-lease", "leases", "expire"],
    ],
  );
  assertEquals(runs.map((run) => run.inputs), [
    acquire,
    { leaseId: "l-1" },
    { leaseId: "l-1" },
    { leaseId: "l-1", error: "boom" },
    { leaseId: "l-1", error: "lost" },
  ]);
});
