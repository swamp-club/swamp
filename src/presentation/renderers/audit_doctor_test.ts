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
import { stripAnsiCode } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/stream.ts";
import type { AuditDoctorEvent } from "../../domain/audit/doctor/doctor_service.ts";
import type { CheckResult } from "../../domain/audit/doctor/check.ts";
import { createAuditDoctorRenderer } from "./audit_doctor.ts";

async function* toStream<E>(events: E[]): AsyncGenerator<E> {
  for (const event of events) yield event;
}

async function renderLog(checks: CheckResult[]): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(...stripAnsiCode(msg).split("\n"));
  try {
    await consumeStream(
      toStream<AuditDoctorEvent>([
        ...checks.map((result) => ({
          kind: "check-completed" as const,
          result,
        })),
        {
          kind: "completed",
          report: {
            tool: "claude",
            overallStatus: checks.some((c) => c.warning) ? "warn" : "pass",
            checks,
          },
        },
      ]),
      createAuditDoctorRenderer("log").handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  return lines.filter((line) => line !== "");
}

Deno.test("createAuditDoctorRenderer: log mode marks a warned check and prints its warning and hint", async () => {
  const lines = await renderLog([
    { name: "binary-on-path", status: "pass", message: "claude found" },
    {
      name: "agent-config-loadable",
      status: "pass",
      message: "hooks wired",
      warning: "below the git root /src",
      hint: "Run `swamp audit install --user`",
    },
  ]);
  assertEquals(lines, [
    "✓ binary-on-path  claude found",
    "! agent-config-loadable  hooks wired",
    "    warning: below the git root /src",
    "    hint: Run `swamp audit install --user`",
    "1 passed, 1 warned, 0 failed, 0 skipped — OVERALL: WARN",
  ]);
});

Deno.test("createAuditDoctorRenderer: log mode leaves the summary unchanged without warnings", async () => {
  const lines = await renderLog([
    { name: "binary-on-path", status: "pass", message: "ok", hint: "unused" },
  ]);
  assertEquals(lines, [
    "✓ binary-on-path  ok",
    "1 passed, 0 failed, 0 skipped — OVERALL: PASS",
  ]);
});
