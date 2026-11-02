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
import { methodRunnerWorkerStatusStore } from "./worker_status_ledger.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";

Deno.test("methodRunnerWorkerStatusStore: runs each status change as set_status on the worker's instance", async () => {
  const runs: Parameters<ModelMethodRunner>[0][] = [];
  const store = methodRunnerWorkerStatusStore((input) => {
    runs.push(input);
    return Promise.resolve();
  });

  await store.recordStatus("w1", {
    status: "busy",
    activeDispatchIds: ["d-1"],
  });
  await store.recordStatus("w1", { status: "idle" });
  await store.recordStatus("w2", {
    status: "unverified",
    verifyFailureReason: "probe failed",
  });

  assertEquals(
    runs.map((run) => [run.typeArg, run.definitionName, run.methodName]),
    [
      ["swamp/worker", "worker-w1", "set_status"],
      ["swamp/worker", "worker-w1", "set_status"],
      ["swamp/worker", "worker-w2", "set_status"],
    ],
  );
  assertEquals(runs.map((run) => run.inputs), [
    { status: "busy", activeDispatchIds: ["d-1"] },
    { status: "idle" },
    { status: "unverified", verifyFailureReason: "probe failed" },
  ]);
});
