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
import { reportDescribe } from "./describe.ts";
import type { ReportDescribeDeps } from "./describe.ts";
import type { ReportDefinition } from "../../domain/reports/report.ts";

const testReport: ReportDefinition = {
  description: "A test cost report",
  scope: "model",
  labels: ["cost", "finops"],
  execute: () => Promise.resolve({ markdown: "", json: {} }),
};

function makeDeps(
  reports: Record<string, ReportDefinition> = {},
): ReportDescribeDeps {
  return {
    getReport: (name) => reports[name],
  };
}

Deno.test("reportDescribe - returns report definition details", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ "cost-report": testReport });

  const events = await collect(reportDescribe(ctx, deps, "cost-report"));
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.name, "cost-report");
    assertEquals(last.data.description, "A test cost report");
    assertEquals(last.data.scope, "model");
    assertEquals(last.data.labels, ["cost", "finops"]);
  }
});

Deno.test("reportDescribe - returns empty labels when none defined", async () => {
  const noLabelsReport: ReportDefinition = {
    description: "No labels",
    scope: "method",
    execute: () => Promise.resolve({ markdown: "", json: {} }),
  };
  const ctx = createLibSwampContext();
  const deps = makeDeps({ "simple-report": noLabelsReport });

  const events = await collect(reportDescribe(ctx, deps, "simple-report"));
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.labels, []);
  }
});

Deno.test("reportDescribe - errors when report not found", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({});

  const events = await collect(reportDescribe(ctx, deps, "missing-report"));
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "not_found");
  }
});
