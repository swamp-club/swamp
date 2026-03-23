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

import { assertStringIncludes } from "@std/assert";
import { assertThrows } from "@std/assert";
import { createReportDescribeRenderer } from "./report_describe.ts";
import type { ReportDescribeEvent } from "../../libswamp/mod.ts";

Deno.test("report describe log renderer - renders definition metadata", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportDescribeRenderer("log");
    const handlers = renderer.handlers();
    handlers.resolving({ kind: "resolving" });
    handlers.completed({
      kind: "completed",
      data: {
        name: "cost-report",
        description: "Shows cost breakdown",
        scope: "model",
        labels: ["cost", "finops"],
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "cost-report");
    assertStringIncludes(combined, "Shows cost breakdown");
    assertStringIncludes(combined, "model");
    assertStringIncludes(combined, "cost, finops");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report describe json renderer - outputs JSON", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportDescribeRenderer("json");
    const handlers = renderer.handlers();
    handlers.resolving({ kind: "resolving" });
    handlers.completed({
      kind: "completed",
      data: {
        name: "cost-report",
        description: "Shows cost breakdown",
        scope: "model",
        labels: ["cost"],
      },
    });

    const parsed = JSON.parse(output[0]);
    assertStringIncludes(parsed.name, "cost-report");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report describe renderer - throws on error", () => {
  const renderer = createReportDescribeRenderer("log");
  const handlers = renderer.handlers();
  const errorEvent: ReportDescribeEvent = {
    kind: "error",
    error: { code: "not_found", message: "Report not found: foo" },
  };
  assertThrows(
    () =>
      handlers.error(
        errorEvent as Extract<ReportDescribeEvent, { kind: "error" }>,
      ),
    Error,
    "Report not found: foo",
  );
});
