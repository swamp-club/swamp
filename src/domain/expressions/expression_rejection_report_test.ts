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
  createRejectionReport,
  firstRejection,
  runWithRejectionReport,
} from "./expression_rejection_report.ts";

Deno.test("firstRejection: reports every refusal when no report is entered", () => {
  assertEquals(firstRejection("${{ inputs.x }}"), true);
  assertEquals(firstRejection("${{ inputs.x }}"), true);
});

Deno.test("firstRejection: reports a raw once per report", () => {
  const report = createRejectionReport();
  runWithRejectionReport(report, () => {
    assertEquals(firstRejection("${{ inputs.x }}"), true);
    assertEquals(firstRejection("${{ inputs.x }}"), false);
    assertEquals(firstRejection("${{ inputs.y }}"), true);
  });
  // Entering the same report again keeps what it has seen.
  runWithRejectionReport(report, () => {
    assertEquals(firstRejection("${{ inputs.x }}"), false);
  });
  runWithRejectionReport(createRejectionReport(), () => {
    assertEquals(firstRejection("${{ inputs.x }}"), true);
  });
});

Deno.test("firstRejection: concurrent reports stay apart across awaits", async () => {
  const seen = async (): Promise<boolean[]> => {
    const results = [firstRejection("${{ inputs.x }}")];
    await Promise.resolve();
    results.push(firstRejection("${{ inputs.x }}"));
    return results;
  };
  const [a, b] = await Promise.all([
    runWithRejectionReport(createRejectionReport(), seen),
    runWithRejectionReport(createRejectionReport(), seen),
  ]);
  assertEquals(a, [true, false]);
  assertEquals(b, [true, false]);
});
