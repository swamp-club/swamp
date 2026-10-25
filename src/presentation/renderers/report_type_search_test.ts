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
import { createReportTypeSearchRenderer } from "./report_type_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";

Deno.test("createReportTypeSearchRenderer: non-interactive log lists the matching report types", async () => {
  const renderer = createReportTypeSearchRenderer("log", {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "cost",
        results: [
          {
            type: "@acme/cost",
            name: "Cost",
            description: "Spend",
            scope: "method",
          },
          {
            type: "@acme/drift",
            name: "Drift",
            description: "Diff",
            scope: "workflow",
          },
        ],
      },
    })
  );
  assertEquals(lines, ["@acme/cost [method]\nSpend", "", "report types: 1"]);
});
