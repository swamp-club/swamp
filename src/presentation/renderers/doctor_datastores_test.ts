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
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createDoctorDatastoresRenderer,
  retentionDetailLines,
} from "./doctor_datastores.ts";
import type { DoctorDatastoresData } from "../../libswamp/datastores/doctor_datastores.ts";
import type { RetentionCheckSummary } from "../../libswamp/datastores/retention_check.ts";

await initializeLogging({});

function captureStdout(fn: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

const SUMMARY: RetentionCheckSummary = {
  configured: true,
  automatic: true,
  checkedAt: "2026-10-15T00:00:00.000Z",
  kinds: [
    {
      kind: "workflowRuns",
      retention: "30d",
      cutoff: "2026-09-15T00:00:00.000Z",
      scanned: true,
      overdue: 3,
      items: [{ id: "wf/run-1", at: "2026-08-01T00:00:00.000Z" }],
      kept: 1,
      watermark: {
        lastPassAt: "2026-10-14T23:00:00.000Z",
        cutoff: "2026-09-14T23:00:00.000Z",
        complete: false,
      },
    },
    {
      kind: "bookkeeping",
      retention: "30d",
      cutoff: "2026-09-15T00:00:00.000Z",
      scanned: false,
      overdue: 0,
      items: [],
      kept: 0,
      watermark: null,
    },
  ],
  v3History: {
    oldestCommitAt: "2026-10-10T00:00:00.000Z",
    compactionBound: "2026-10-08T00:00:00.000Z",
    failBefore: "2026-10-07T00:00:00.000Z",
    overdue: false,
  },
};

function data(retentionFinding?: RetentionCheckSummary): DoctorDatastoresData {
  return {
    datastoreType: "filesystem",
    isCustom: false,
    healthFindings: [
      { check: "health", passed: true, message: "ok" },
      { check: "retention", passed: false, message: "3 item(s)" },
    ],
    vaultMismatchFindings: [],
    ...(retentionFinding ? { retentionFinding } : {}),
  };
}

Deno.test("createDoctorDatastoresRenderer: json mode carries the retention finding and fails on it", () => {
  const renderer = createDoctorDatastoresRenderer("json");
  const out = captureStdout(() =>
    renderer.handlers().completed({ kind: "completed", data: data(SUMMARY) })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "fail");
  assertEquals(parsed.retentionFinding, SUMMARY);
  assertEquals(renderer.overallStatus, "fail");
});

Deno.test("createDoctorDatastoresRenderer: json mode reports a null retention finding without --retention", () => {
  const renderer = createDoctorDatastoresRenderer("json");
  const out = captureStdout(() =>
    renderer.handlers().completed({ kind: "completed", data: data() })
  );
  assertEquals(JSON.parse(out).retentionFinding, null);
});

Deno.test("retentionDetailLines: lists overdue items, the rest as a count, watermarks and the v3 bound", () => {
  const text = stripAnsiCode(retentionDetailLines(SUMMARY).join("\n"));
  assertStringIncludes(text, "Retention: automatic on");
  assertStringIncludes(
    text,
    "workflowRuns 30d cutoff 2026-09-15T00:00:00.000Z",
  );
  assertStringIncludes(text, "3 older than cutoff");
  assertStringIncludes(text, "(1 kept by design)");
  assertStringIncludes(text, "• wf/run-1 2026-08-01T00:00:00.000Z");
  assertStringIncludes(text, "… and 2 more");
  assertStringIncludes(text, "last pass 2026-10-14T23:00:00.000Z");
  assertStringIncludes(text, "incomplete");
  assertStringIncludes(text, "serve bookkeeping");
  assertStringIncludes(
    text,
    "v3 history oldest commit 2026-10-10T00:00:00.000Z",
  );
  assertStringIncludes(
    text,
    "This check fails only for history older than 2026-10-07T00:00:00.000Z",
  );
  assertStringIncludes(text, "removed content leaves history about 7 days");
});

Deno.test("retentionDetailLines: says retention is not configured", () => {
  const text = stripAnsiCode(
    retentionDetailLines({ ...SUMMARY, configured: false }).join("\n"),
  );
  assertStringIncludes(text, "Retention: not configured");
  assertEquals(text.includes("workflowRuns"), false);
});
