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
import { sanitizeReportNameForData as domainSanitize } from "../../../../src/domain/reports/report_data_name.ts";
import { reportDataName, sanitizeReportNameForData } from "./report_name.ts";

const CASES = [
  "@swamp/method-summary",
  "@swamp/workflow-summary",
  "@webframp/aws/cost-report",
  "@org\\report",
  "a..b",
  "..",
  "...",
  "foo\0bar",
  "cost-report",
  "@@x//y",
];

Deno.test("sanitizeReportNameForData: matches the domain function", () => {
  for (const name of CASES) {
    assertEquals(sanitizeReportNameForData(name), domainSanitize(name), name);
  }
});

Deno.test("reportDataName: base and variant names", () => {
  assertEquals(
    reportDataName("@swamp/method-summary"),
    "report-swamp-method-summary",
  );
  assertEquals(
    reportDataName("@acme/cost", "us-east"),
    "report-acme-cost-us-east",
  );
});
