// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  reportTypeSearch,
  type ReportTypeSearchDeps,
  type ReportTypeSearchEvent,
} from "./type_search.ts";

function makeDeps(
  overrides: Partial<ReportTypeSearchDeps> = {},
): ReportTypeSearchDeps {
  return {
    getReportTypes: () => [
      {
        type: "@swamp/method-summary",
        name: "@swamp/method-summary",
        description: "Summary of method execution results",
      },
      {
        type: "@swamp/cost-report",
        name: "@swamp/cost-report",
        description: "Cost breakdown for model operations",
      },
    ],
    ...overrides,
  };
}

Deno.test("reportTypeSearch: returns all report types with no query", async () => {
  const deps = makeDeps();
  const events = await collect<ReportTypeSearchEvent>(
    reportTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ReportTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].type, "@swamp/method-summary");
  assertEquals(completed.data.results[0].name, "@swamp/method-summary");
});

Deno.test("reportTypeSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<ReportTypeSearchEvent>(
    reportTypeSearch(createLibSwampContext(), deps, { query: "cost" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    ReportTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "cost");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("reportTypeSearch: returns empty results when no report types", async () => {
  const deps = makeDeps({
    getReportTypes: () => [],
  });
  const events = await collect<ReportTypeSearchEvent>(
    reportTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    ReportTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
