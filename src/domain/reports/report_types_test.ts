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
import { reportRegistry } from "./report_registry.ts";
import { getReportTypes } from "./report_types.ts";
import type { ReportDefinition } from "./report.ts";

function makeReport(
  overrides: Partial<ReportDefinition> = {},
): ReportDefinition {
  return {
    description: "test report",
    scope: "method",
    execute: () => Promise.resolve({ markdown: "", json: {} }),
    ...overrides,
  };
}

Deno.test("getReportTypes: includes scope from loaded reports", () => {
  const original = reportRegistry.getAll;
  const originalLazy = reportRegistry.getAllLazy;

  const methodReport = makeReport({ scope: "method", description: "m" });
  const workflowReport = makeReport({ scope: "workflow", description: "w" });

  reportRegistry.getAll = () => [
    { name: "@test/method-report", report: methodReport },
    { name: "@test/workflow-report", report: workflowReport },
  ];
  reportRegistry.getAllLazy = () => [];

  try {
    const types = getReportTypes();
    assertEquals(types.length, 2);
    assertEquals(types[0].scope, "method");
    assertEquals(types[1].scope, "workflow");
  } finally {
    reportRegistry.getAll = original;
    reportRegistry.getAllLazy = originalLazy;
  }
});

Deno.test("getReportTypes: marks built-in reports correctly", () => {
  const original = reportRegistry.getAll;
  const originalLazy = reportRegistry.getAllLazy;

  const builtinReport = makeReport({ scope: "method", description: "builtin" });
  const userReport = makeReport({ scope: "model", description: "user" });

  reportRegistry.getAll = () => [
    { name: "@swamp/method-summary", report: builtinReport },
    { name: "@user/custom-report", report: userReport },
  ];
  reportRegistry.getAllLazy = () => [];

  try {
    const types = getReportTypes();
    assertEquals(types.length, 2);
    const builtin = types.find((t) => t.name === "@swamp/method-summary")!;
    const user = types.find((t) => t.name === "@user/custom-report")!;
    assertEquals(builtin.isBuiltIn, true);
    assertEquals(user.isBuiltIn, false);
  } finally {
    reportRegistry.getAll = original;
    reportRegistry.getAllLazy = originalLazy;
  }
});

Deno.test("getReportTypes: lazy entries have default scope", () => {
  const original = reportRegistry.getAll;
  const originalLazy = reportRegistry.getAllLazy;

  reportRegistry.getAll = () => [];
  reportRegistry.getAllLazy = () => [
    {
      type: "@user/lazy-report",
      bundlePath: "/tmp/bundle.js",
      sourcePath: "/tmp/report.ts",
      version: "1.0.0",
    },
  ];

  try {
    const types = getReportTypes();
    assertEquals(types.length, 1);
    assertEquals(types[0].scope, "method");
    assertEquals(types[0].isBuiltIn, false);
    assertEquals(types[0].description, "");
  } finally {
    reportRegistry.getAll = original;
    reportRegistry.getAllLazy = originalLazy;
  }
});
