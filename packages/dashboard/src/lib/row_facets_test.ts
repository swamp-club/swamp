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
  applyRowFacets,
  buildRowFacets,
  type RowFacetSpec,
} from "./row_facets.ts";

interface Row {
  route: string;
  workflow: string;
  last: string | null;
  scheme: string;
}
const rows: Row[] = [
  { route: "/a", workflow: "deploy-api", last: "failed", scheme: "github" },
  { route: "/b", workflow: "deploy-api", last: "succeeded", scheme: "github" },
  { route: "/c", workflow: "sync-crm", last: null, scheme: "github" },
];
const specs: RowFacetSpec<Row>[] = [
  {
    key: "workflow",
    label: "Workflow",
    description: "",
    valueOf: (r) => r.workflow,
  },
  {
    key: "last",
    label: "Last run",
    description: "",
    valueOf: (r) => r.last ?? "never",
    labelOf: (v) => v === "never" ? "Never ran" : v,
    order: ["failed", "succeeded", "never"],
  },
  { key: "scheme", label: "Scheme", description: "", valueOf: (r) => r.scheme },
];

Deno.test("buildRowFacets: counted values, fixed order, single-valued facets empty", () => {
  const [workflow, last, scheme] = buildRowFacets(rows, specs);
  assertEquals(workflow.values, [
    { value: "deploy-api", label: "deploy-api", hint: "2" },
    { value: "sync-crm", label: "sync-crm", hint: "1" },
  ]);
  assertEquals(last.values.map((v) => v.label), [
    "failed",
    "succeeded",
    "Never ran",
  ]);
  assertEquals(scheme.values, []);
});

Deno.test("applyRowFacets: OR within a facet", () => {
  assertEquals(
    applyRowFacets(rows, specs, { last: ["failed", "never"] }).map((r) =>
      r.route
    ),
    ["/a", "/c"],
  );
  assertEquals(applyRowFacets(rows, specs, { last: [] }).length, 3);
});

Deno.test("applyRowFacets: AND across selections, none selected keeps all", () => {
  assertEquals(applyRowFacets(rows, specs, {}).length, 3);
  assertEquals(
    applyRowFacets(rows, specs, { workflow: ["deploy-api"] }).map((r) =>
      r.route
    ),
    ["/a", "/b"],
  );
  assertEquals(
    applyRowFacets(rows, specs, { workflow: ["deploy-api"], last: ["failed"] })
      .map((r) => r.route),
    ["/a"],
  );
  assertEquals(
    applyRowFacets(rows, specs, { workflow: ["sync-crm"], last: ["failed"] }),
    [],
  );
});
