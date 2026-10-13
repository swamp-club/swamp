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
  type DrawerItem,
  drawerTitle,
  itemParamFor,
  parseItemParam,
  withItemParam,
} from "./run_item_param.ts";

const items: DrawerItem[] = [
  { kind: "data", modelName: "echo-shell", dataName: "result", version: 12 },
  { kind: "data", modelName: "@acme/x", dataName: "log" },
  {
    kind: "report",
    modelName: "m",
    reportName: "@swamp/summary",
    variant: "eu",
  },
  {
    kind: "runReport",
    workflowName: "deploy",
    runId: "0d6a1f6e-1111-4222-8333-444455556666",
    reportName: "@swamp/workflow-summary",
  },
];

Deno.test("itemParamFor: round-trips every drawer item", () => {
  for (const item of items) {
    assertEquals(parseItemParam(itemParamFor(item)), item);
  }
});

Deno.test("itemParamFor: is the full page's path without the prefix", () => {
  assertEquals(
    itemParamFor(items[0]),
    "behaviors/echo-shell/data/result/versions/12",
  );
  assertEquals(
    itemParamFor(items[3]),
    "workflows/deploy/runs/0d6a1f6e-1111-4222-8333-444455556666/reports/@swamp%2Fworkflow-summary",
  );
});

Deno.test("parseItemParam: ignores missing and non-item values", () => {
  assertEquals(parseItemParam(null), null);
  assertEquals(parseItemParam(""), null);
  assertEquals(parseItemParam("workflows/deploy"), null);
  assertEquals(parseItemParam("models/m"), null);
  assertEquals(parseItemParam("behaviors/m"), null);
  assertEquals(parseItemParam("nonsense/%E0%A4%A"), null);
});

Deno.test("parseItemParam: a param shared before the behaviors rename still opens", () => {
  assertEquals(
    parseItemParam("models/echo-shell/data/result/versions/12"),
    items[0],
  );
  assertEquals(
    parseItemParam("behaviours/echo-shell/data/result/versions/12"),
    items[0],
  );
});

Deno.test("withItemParam: sets and clears the param, keeping others", () => {
  const base =
    "https://swamp.test/dashboard/workflows/deploy/runs/r1?job=build";
  const open = withItemParam(base, items[0]);
  assertEquals(
    new URL(open).searchParams.get("item"),
    "behaviors/echo-shell/data/result/versions/12",
  );
  assertEquals(new URL(open).searchParams.get("job"), "build");
  assertEquals(withItemParam(open, null), base);
});

Deno.test("drawerTitle: names the item", () => {
  assertEquals(items.map(drawerTitle), [
    "result v12",
    "log",
    "@swamp/summary · eu",
    "@swamp/workflow-summary",
  ]);
});
