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

import { assertEquals, assertThrows } from "@std/assert";
import { ReportRegistry } from "./report_registry.ts";
import type { ReportDefinition } from "./report.ts";
import type { ReportContext } from "./report_context.ts";

function makeReport(
  scope: "method" | "model" | "workflow" = "method",
  labels?: string[],
): ReportDefinition {
  return {
    description: `Test ${scope} report`,
    scope,
    labels,
    execute(_context: ReportContext) {
      return Promise.resolve({ markdown: "# Test", json: { test: true } });
    },
  };
}

Deno.test("ReportRegistry - register and get", () => {
  const registry = new ReportRegistry();
  const report = makeReport();
  registry.register("test-report", report);

  assertEquals(registry.get("test-report"), report);
  assertEquals(registry.has("test-report"), true);
  assertEquals(registry.has("nonexistent"), false);
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("ReportRegistry - duplicate registration throws", () => {
  const registry = new ReportRegistry();
  registry.register("test-report", makeReport());

  assertThrows(
    () => registry.register("test-report", makeReport()),
    Error,
    "Report already registered: test-report",
  );
});

Deno.test("ReportRegistry - getAll returns all reports", () => {
  const registry = new ReportRegistry();
  registry.register("report-a", makeReport("method"));
  registry.register("report-b", makeReport("model"));
  registry.register("report-c", makeReport("workflow"));

  const all = registry.getAll();
  assertEquals(all.length, 3);
  assertEquals(all.map((r) => r.name).sort(), [
    "report-a",
    "report-b",
    "report-c",
  ]);
});

Deno.test("ReportRegistry - getByScope filters by scope", () => {
  const registry = new ReportRegistry();
  registry.register("method-1", makeReport("method"));
  registry.register("method-2", makeReport("method"));
  registry.register("model-1", makeReport("model"));
  registry.register("workflow-1", makeReport("workflow"));

  const methodReports = registry.getByScope("method");
  assertEquals(methodReports.length, 2);
  assertEquals(
    methodReports.map((r) => r.name).sort(),
    ["method-1", "method-2"],
  );

  const modelReports = registry.getByScope("model");
  assertEquals(modelReports.length, 1);
  assertEquals(modelReports[0].name, "model-1");

  const workflowReports = registry.getByScope("workflow");
  assertEquals(workflowReports.length, 1);
  assertEquals(workflowReports[0].name, "workflow-1");
});
