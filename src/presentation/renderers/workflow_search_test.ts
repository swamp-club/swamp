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
import { createWorkflowSearchRenderer } from "./workflow_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";
import type { WorkflowSearchItem } from "../../libswamp/workflows/search.ts";

function workflow(name: string, jobCount = 1): WorkflowSearchItem {
  return {
    id: `id-${name}`,
    name,
    jobCount,
    stepCount: 1,
    hasInputs: false,
  };
}

Deno.test("createWorkflowSearchRenderer: non-interactive log lists the matching workflows", async () => {
  const renderer = createWorkflowSearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "deploy",
        results: [
          workflow("deploy-app", 2),
          workflow("cleanup"),
          workflow(
            "deploy-db",
          ),
        ],
      },
    })
  );
  assertEquals(lines, [
    "deploy-app (2 jobs)\n\ndeploy-db (1 jobs)",
    "",
    "workflows: 2",
  ]);
  assertEquals(renderer.selectedItem(), undefined);
  assertEquals(renderer.selectedAction(), undefined);
});

Deno.test("createWorkflowSearchRenderer: non-interactive log with no match prints the no-results line", async () => {
  const renderer = createWorkflowSearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: { query: "nope", results: [workflow("deploy")] },
    })
  );
  assertEquals(lines, ["No matching workflows found"]);
});

Deno.test("createWorkflowSearchRenderer: json mode ignores interactive false", async () => {
  const data = { query: "", results: [workflow("deploy")] };
  const plain = await captureLog(() =>
    createWorkflowSearchRenderer("json").handlers().completed({
      kind: "completed",
      data,
    })
  );
  const remote = await captureLog(() =>
    createWorkflowSearchRenderer("json", undefined, { interactive: false })
      .handlers().completed({ kind: "completed", data })
  );
  assertEquals(remote, plain);
  assertEquals(JSON.parse(remote[0]).results[0].name, "deploy");
});
