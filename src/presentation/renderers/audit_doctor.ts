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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import type {
  AuditDoctorEvent,
  CheckResult,
  EventHandlers,
  OverallStatus,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

/**
 * Renderer for `swamp doctor audit`. Exposes `overallStatus` so the CLI
 * can exit non-zero on a failing report.
 */
export interface AuditDoctorRenderer {
  handlers(): EventHandlers<AuditDoctorEvent>;
  readonly overallStatus: OverallStatus;
}

function iconFor(status: CheckResult["status"]): string {
  switch (status) {
    case "pass":
      return green("✓"); // ✓
    case "fail":
      return red("✗"); // ✗
    case "skip":
      return dim("–"); // –
  }
}

function summaryLine(status: OverallStatus): string {
  switch (status) {
    case "pass":
      return green(bold("OVERALL: PASS"));
    case "warn":
      return yellow(bold("OVERALL: WARN"));
    case "fail":
      return red(bold("OVERALL: FAIL"));
  }
}

class LogAuditDoctorRenderer implements AuditDoctorRenderer {
  overallStatus: OverallStatus = "pass";

  handlers(): EventHandlers<AuditDoctorEvent> {
    return {
      "check-started": () => {
        // No-op. Checks run fast enough that an in-progress line is visual
        // noise — users see the `✓/✗/–` line on check-completed and that's
        // enough.
      },
      "check-completed": (e) => {
        const r = e.result;
        writeOutput(`${iconFor(r.status)} ${bold(r.name)}  ${dim(r.message)}`);
        if (r.status === "fail" && r.hint) {
          writeOutput(`    ${yellow("hint:")} ${r.hint}`);
        }
      },
      completed: (e) => {
        this.overallStatus = e.report.overallStatus;
        const pass = e.report.checks.filter((c) => c.status === "pass").length;
        const fail = e.report.checks.filter((c) => c.status === "fail").length;
        const skip = e.report.checks.filter((c) => c.status === "skip").length;
        writeOutput(
          `\n${pass} passed, ${fail} failed, ${skip} skipped — ${
            summaryLine(e.report.overallStatus)
          }`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonAuditDoctorRenderer implements AuditDoctorRenderer {
  overallStatus: OverallStatus = "pass";

  handlers(): EventHandlers<AuditDoctorEvent> {
    return {
      "check-started": () => {
        // No-op — JSON consumers get a single final emit.
      },
      "check-completed": () => {
        // No-op — per-check progress is swallowed in JSON mode.
      },
      completed: (e) => {
        this.overallStatus = e.report.overallStatus;
        console.log(JSON.stringify(e.report, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createAuditDoctorRenderer(
  mode: OutputMode,
): AuditDoctorRenderer {
  switch (mode) {
    case "json":
      return new JsonAuditDoctorRenderer();
    case "log":
      return new LogAuditDoctorRenderer();
  }
}
