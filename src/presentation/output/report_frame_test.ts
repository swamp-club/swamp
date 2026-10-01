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
import { setColorEnabled } from "@std/fmt/colors";
import { formatReportFrame } from "./report_frame.ts";

function withoutColor<T>(fn: () => T): T {
  setColorEnabled(false);
  try {
    return fn();
  } finally {
    setColorEnabled(true);
  }
}

Deno.test("formatReportFrame: returns undefined for empty markdown", () => {
  assertEquals(formatReportFrame("@test/report", "", 80), undefined);
});

Deno.test("formatReportFrame: returns undefined for whitespace-only markdown", () => {
  assertEquals(formatReportFrame("@test/report", "  \n\t\n", 80), undefined);
});

Deno.test("formatReportFrame: header and closing rule span the given columns", () => {
  const frame = withoutColor(() =>
    formatReportFrame("@test/report", "# Summary\n\nAll good.", 72)
  );
  const lines = frame!.split("\n");
  const header = lines[0];
  const closing = lines[lines.length - 1];
  assertEquals(header.startsWith("── Report: @test/report "), true);
  assertEquals(header.length, 72);
  assertEquals(closing, "─".repeat(72));
  assertStringIncludes(frame!, "All good.");
});

Deno.test("formatReportFrame: report name longer than the width does not throw", () => {
  const name = "@test/" + "x".repeat(100);
  const frame = withoutColor(() => formatReportFrame(name, "body", 40));
  const lines = frame!.split("\n");
  assertEquals(lines[0], `── Report: ${name} `);
  assertEquals(lines[lines.length - 1], "─".repeat(40));
});

Deno.test("formatReportFrame: showEmpty frames empty markdown", () => {
  const frame = withoutColor(() =>
    formatReportFrame("@test/report", "", 60, { showEmpty: true })
  );
  const lines = frame!.split("\n");
  assertEquals(lines[0].startsWith("── Report: @test/report "), true);
  assertEquals(lines[0].length, 60);
  assertEquals(lines[lines.length - 1], "─".repeat(60));
});
