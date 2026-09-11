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
import { renderAuditReport } from "./audit_report_output.ts";
import type { AuditReportResponse } from "../../serve/protocol.ts";

function makeReport(
  overrides?: Partial<AuditReportResponse>,
): AuditReportResponse {
  return {
    name: "access-review",
    description: "Access review report",
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-10T00:00:00Z",
    generatedAt: "2026-09-10T12:00:00Z",
    markdown: "# Access Review\n\nNo events found.",
    data: { principals: [], totalEvents: 0 },
    ...overrides,
  };
}

Deno.test("renderAuditReport: json mode outputs valid JSON", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderAuditReport(makeReport(), "json");
    const parsed = JSON.parse(output.join(""));
    assertEquals(parsed.name, "access-review");
    assertEquals(parsed.data.totalEvents, 0);
  } finally {
    console.log = origLog;
  }
});

Deno.test("renderAuditReport: json mode includes all fields", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderAuditReport(makeReport(), "json");
    const parsed = JSON.parse(output.join(""));
    assertEquals(typeof parsed.name, "string");
    assertEquals(typeof parsed.description, "string");
    assertEquals(typeof parsed.from, "string");
    assertEquals(typeof parsed.to, "string");
    assertEquals(typeof parsed.generatedAt, "string");
    assertEquals(typeof parsed.markdown, "string");
    assertEquals(typeof parsed.data, "object");
  } finally {
    console.log = origLog;
  }
});

Deno.test("renderAuditReport: log mode includes report name", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderAuditReport(makeReport(), "log");
    const text = output.join("\n");
    assertStringIncludes(text, "access-review");
  } finally {
    console.log = origLog;
  }
});

Deno.test("renderAuditReport: log mode includes markdown content", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderAuditReport(
      makeReport({ markdown: "# My Report\n\n3 principals found." }),
      "log",
    );
    const text = output.join("\n");
    assertStringIncludes(text, "3 principals found");
  } finally {
    console.log = origLog;
  }
});
