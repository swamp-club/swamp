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
  type NamedWorkflow,
  readableNestedRuns,
  redactParentRun,
} from "./nested_run_redaction.ts";

const readable = new Set(["readable-id"]);
const canRead = (w: NamedWorkflow) =>
  Promise.resolve(readable.has(w.workflowId));

Deno.test("redactParentRun: keeps a parent the principal may read, drops one it may not with what derives from it", async () => {
  const kept = {
    parentRun: { workflowId: "readable-id", workflowName: "parent" },
    parentWaiting: true,
  };
  await redactParentRun(kept, canRead);
  assertEquals(kept.parentRun.workflowName, "parent");
  assertEquals(kept.parentWaiting, true);

  const hidden: {
    parentRun?: NamedWorkflow;
    parentWaiting?: boolean;
  } = {
    parentRun: { workflowId: "secret-id", workflowName: "secret" },
    parentWaiting: true,
  };
  await redactParentRun(hidden, canRead);
  assertEquals(hidden, {});
});

Deno.test("readableNestedRuns: keeps only nested runs of readable workflows", async () => {
  const runs = [
    { workflowId: "readable-id", workflowName: "a", runId: "1" },
    { workflowId: "secret-id", workflowName: "b", runId: "2" },
  ];
  assertEquals(
    await readableNestedRuns(runs, (r) => r.workflowId, canRead),
    [runs[0]],
  );
  assertEquals(
    await readableNestedRuns([runs[1]], (r) => r.workflowId, canRead),
    undefined,
  );
  assertEquals(
    await readableNestedRuns(
      undefined,
      (r: typeof runs[0]) => r.workflowId,
      canRead,
    ),
    undefined,
  );
});
