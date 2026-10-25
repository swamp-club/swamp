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
import { createWorkflowHistorySearchRenderer } from "./workflow_history_search.tsx";
import { reapedRunsLine } from "./workflow_run_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";

const REAPED = { cutoff: "2026-10-01T00:00:00.000Z", retention: "14d" };

Deno.test("createWorkflowHistorySearchRenderer: non-interactive log lists matching runs and ends with the reaped note", async () => {
  const renderer = createWorkflowHistorySearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "deploy",
        results: [
          {
            runId: "r1",
            workflowId: "w1",
            workflowName: "deploy",
            status: "succeeded",
          },
          {
            runId: "r2",
            workflowId: "w2",
            workflowName: "gc",
            status: "failed",
          },
        ],
        reapedBefore: REAPED,
      },
    })
  );
  assertEquals(lines.length, 4);
  assertStringIncludes(lines[0], "deploy [succeeded]\nrun: r1");
  assertEquals(lines[0].includes("r2"), false);
  assertEquals(lines[2], "runs: 1");
  assertEquals(lines[3], reapedRunsLine(REAPED));
});
