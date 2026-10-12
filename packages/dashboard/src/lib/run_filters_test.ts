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
  filterRowsByWorkflow,
  runSearchPayload,
  statusCounts,
  workflowNamesForFilter,
} from "./run_filters.ts";
import {
  EMPTY_FILTER,
  facetIndex,
  type WorkflowRef,
} from "./workflow_facets.ts";

const workflows: WorkflowRef[] = [
  { name: "deploy-api", trigger: { schedule: "0 * * * *" } },
  { name: "deploy-web" },
  { name: "etl-orders" },
  { name: "standalone" },
];
const facetsOf = facetIndex({
  webhooks: [{ route: "/hooks/web", workflow: "deploy-web" }],
});
const catalog = new Map(workflows.map((w) => [w.name, w]));

Deno.test("workflowNamesForFilter: null when no filter is active", () => {
  assertEquals(workflowNamesForFilter(workflows, EMPTY_FILTER, facetsOf), null);
});

Deno.test("workflowNamesForFilter: facets and query narrow to sorted names", () => {
  assertEquals(
    workflowNamesForFilter(
      workflows,
      { ...EMPTY_FILTER, prefix: "deploy" },
      facetsOf,
    ),
    ["deploy-api", "deploy-web"],
  );
  assertEquals(
    workflowNamesForFilter(
      workflows,
      { ...EMPTY_FILTER, trigger: "schedule" },
      facetsOf,
    ),
    ["deploy-api"],
  );
  assertEquals(
    workflowNamesForFilter(
      workflows,
      { ...EMPTY_FILTER, webhook: "/hooks/web" },
      facetsOf,
    ),
    ["deploy-web"],
  );
  assertEquals(
    workflowNamesForFilter(
      workflows,
      { ...EMPTY_FILTER, trigger: "manual" },
      facetsOf,
    ),
    ["etl-orders", "standalone"],
  );
  // Fuzzy ranking does not leak into the request: names come back sorted.
  assertEquals(
    workflowNamesForFilter(
      workflows,
      { ...EMPTY_FILTER, query: "dep" },
      facetsOf,
    ),
    ["deploy-api", "deploy-web"],
  );
});

Deno.test("workflowNamesForFilter: an empty array when nothing matches", () => {
  assertEquals(
    workflowNamesForFilter(
      workflows,
      { ...EMPTY_FILTER, query: "zzzz" },
      facetsOf,
    ),
    [],
  );
});

Deno.test("filterRowsByWorkflow: keeps incoming order and unknown workflows match by name", () => {
  const rows = [
    { workflowName: "standalone", id: 1 },
    { workflowName: "deploy-web", id: 2 },
    { workflowName: "deploy-api", id: 3 },
    { workflowName: "deploy-gone", id: 4 },
  ];
  const kept = filterRowsByWorkflow(
    rows,
    { ...EMPTY_FILTER, query: "deploy" },
    (r) => r.workflowName,
    catalog,
    facetsOf,
  );
  assertEquals(kept.map((r) => r.id), [2, 3, 4]);
  assertEquals(
    filterRowsByWorkflow(
      rows,
      EMPTY_FILTER,
      (r) => r.workflowName,
      catalog,
      facetsOf,
    ).map((r) => r.id),
    [1, 2, 3, 4],
  );
  assertEquals(
    filterRowsByWorkflow(
      rows,
      { ...EMPTY_FILTER, trigger: "webhook" },
      (r) => r.workflowName,
      catalog,
      facetsOf,
    ).map((r) => r.id),
    [2],
  );
});

Deno.test("runSearchPayload: sends only the filters that are set", () => {
  assertEquals(
    runSearchPayload({
      page: 0,
      pageSize: 25,
      status: "",
      source: "",
      workflows: null,
    }),
    { limit: 25, offset: 0 },
  );
  assertEquals(
    runSearchPayload({
      page: 2,
      pageSize: 25,
      status: "failed",
      source: "webhook",
      workflows: ["a", "b"],
      since: "2026-10-05T00:00:00.000Z",
      until: "2026-10-12T00:00:00.000Z",
    }),
    {
      limit: 25,
      offset: 50,
      status: "failed",
      triggerSource: "webhook",
      workflows: ["a", "b"],
      since: "2026-10-05T00:00:00.000Z",
      until: "2026-10-12T00:00:00.000Z",
    },
  );
});

Deno.test("statusCounts: maps totals to status filters", () => {
  assertEquals(statusCounts(null), null);
  assertEquals(
    statusCounts({
      runs: 10,
      succeeded: 5,
      failed: 2,
      running: 1,
      suspended: 1,
      cancelled: 1,
    }),
    {
      "": 10,
      succeeded: 5,
      failed: 2,
      running: 1,
      suspended: 1,
      cancelled: 1,
    },
  );
});
