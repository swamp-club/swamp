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
import { buildReportErrorResult } from "./report_error_report.ts";

Deno.test("buildReportErrorResult: markdown includes report name and error message", () => {
  const result = buildReportErrorResult(
    "@example/my-audit",
    "workflow",
    "gate tripped: 3 finding(s)",
  );

  assertStringIncludes(result.markdown, "# Report Error: @example/my-audit");
  assertStringIncludes(result.markdown, "scope: workflow");
  assertStringIncludes(result.markdown, "## Error");
  assertStringIncludes(result.markdown, "gate tripped: 3 finding(s)");
});

Deno.test("buildReportErrorResult: json contains error flag and details", () => {
  const result = buildReportErrorResult(
    "@example/my-audit",
    "workflow",
    "gate tripped: 3 finding(s)",
  );

  assertEquals(result.json.error, true);
  assertEquals(result.json.reportName, "@example/my-audit");
  assertEquals(result.json.scope, "workflow");
  assertEquals(result.json.message, "gate tripped: 3 finding(s)");
});

Deno.test("buildReportErrorResult: works for method scope", () => {
  const result = buildReportErrorResult(
    "@org/cost-check",
    "method",
    "connection timeout",
  );

  assertStringIncludes(result.markdown, "scope: method");
  assertEquals(result.json.scope, "method");
  assertEquals(result.json.reportName, "@org/cost-check");
});

Deno.test("buildReportErrorResult: includes stack trace in markdown when provided", () => {
  const stack =
    "TypeError: foo\n    at bar (file.ts:10:5)\n    at baz (file.ts:20:3)";
  const result = buildReportErrorResult(
    "@example/my-audit",
    "workflow",
    "foo",
    stack,
  );

  assertStringIncludes(result.markdown, "## Stack Trace");
  assertStringIncludes(result.markdown, stack);
});

Deno.test("buildReportErrorResult: includes stack in json when provided", () => {
  const stack = "TypeError: foo\n    at bar (file.ts:10:5)";
  const result = buildReportErrorResult(
    "@example/my-audit",
    "workflow",
    "foo",
    stack,
  );

  assertEquals(result.json.stack, stack);
});

Deno.test("buildReportErrorResult: omits stack from json when not provided", () => {
  const result = buildReportErrorResult(
    "@example/my-audit",
    "workflow",
    "foo",
  );

  assertEquals(result.json.stack, undefined);
});
