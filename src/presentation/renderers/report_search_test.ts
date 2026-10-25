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
import { createReportSearchRenderer } from "./report_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";
import type { StoredReportSummary } from "../../libswamp/reports/report_views.ts";

function report(reportName: string): StoredReportSummary {
  return {
    reportName,
    reportScope: "method",
    modelId: "m1",
    modelName: "web",
    modelType: "command/shell",
    version: 1,
    createdAt: "2026-10-25T00:00:00.000Z",
    dataName: `report-${reportName}`,
  };
}

Deno.test("createReportSearchRenderer: non-interactive log lists the reports matching the command query", async () => {
  const renderer = createReportSearchRenderer("log", "cost", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: { reports: [report("cost-summary"), report("drift")] },
    })
  );
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[0], "cost-summary\nscope: method");
  assertEquals(lines[0].includes("drift"), false);
  assertEquals(lines[2], "reports: 1");
});
