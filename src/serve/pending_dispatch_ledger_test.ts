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
import { methodRunnerPendingDispatchStore } from "./pending_dispatch_ledger.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";

Deno.test("methodRunnerPendingDispatchStore: runs each transition as its method on the pending instance", async () => {
  const runs: Parameters<ModelMethodRunner>[0][] = [];
  const store = methodRunnerPendingDispatchStore((input) => {
    runs.push(input);
    return Promise.resolve();
  });
  const endedAt = "2026-07-04T00:01:00.000Z";

  await store.enqueue({
    queueId: "q-1",
    modelType: "command/shell",
    methodName: "execute",
    queuedAt: "2026-07-04T00:00:00.000Z",
  });
  await store.end("q-1", { state: "dispatched", dispatchId: "d-1", endedAt });
  await store.end("q-2", { state: "timed_out", endedAt });
  await store.end("q-3", { state: "cancelled", endedAt });

  assertEquals(
    runs.map((run) => [run.typeArg, run.definitionName, run.methodName]),
    [
      ["swamp/pending-dispatch", "pending", "enqueue"],
      ["swamp/pending-dispatch", "pending", "mark_dispatched"],
      ["swamp/pending-dispatch", "pending", "timeout"],
      ["swamp/pending-dispatch", "pending", "cancel"],
    ],
  );
  assertEquals(runs.map((run) => run.inputs), [
    {
      queueId: "q-1",
      modelType: "command/shell",
      methodName: "execute",
      queuedAt: "2026-07-04T00:00:00.000Z",
    },
    { queueId: "q-1", dispatchId: "d-1", endedAt },
    { queueId: "q-2", endedAt },
    { queueId: "q-3", endedAt },
  ]);
});
