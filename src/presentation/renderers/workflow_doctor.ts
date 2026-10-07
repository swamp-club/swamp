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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import type {
  DoctorWorkflowsEvent,
  DoctorWorkflowsReport,
} from "../../libswamp/workflows/doctor.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

export interface WorkflowDoctorRenderer extends Renderer<DoctorWorkflowsEvent> {
  readonly overallStatus: DoctorWorkflowsReport["overallStatus"];
}

function overallLabel(status: DoctorWorkflowsReport["overallStatus"]): string {
  switch (status) {
    case "pass":
      return green(bold("OVERALL: PASS"));
    case "warn":
      return yellow(bold("OVERALL: WARN"));
    case "fail":
      return red(bold("OVERALL: FAIL"));
  }
}

/** `N passed, N failed`, plus the warning count only when there are any. */
function summaryCounts(report: DoctorWorkflowsReport): string {
  const counts = `${report.totalPassed} passed, ${report.totalFailed} failed`;
  // A report from an older `swamp serve` has no warning count.
  const warnings = report.totalWarnings ?? 0;
  if (warnings === 0) return counts;
  return `${counts}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
}

class LogWorkflowDoctorRenderer implements WorkflowDoctorRenderer {
  overallStatus: DoctorWorkflowsReport["overallStatus"] = "pass";
  private headerPrinted = false;

  handlers(): EventHandlers<DoctorWorkflowsEvent> {
    return {
      "workflow-checked": (e) => {
        if (!this.headerPrinted) {
          writeOutput(bold(cyan("Checking workflows...")));
          this.headerPrinted = true;
        }
        const r = e.result;
        const label = r.name ?? dim(r.file);
        if (r.status === "pass") {
          writeOutput(`  ${green("✓")} ${label}`);
        } else if (r.status === "warn") {
          writeOutput(`  ${yellow("⚠")} ${label}`);
          if (r.warning) {
            writeOutput(`    ${yellow("→")} ${r.warning}`);
          }
        } else {
          writeOutput(`  ${red("✗")} ${label}`);
          if (r.error) {
            writeOutput(`    ${red("→")} ${r.error}`);
          }
        }
      },
      completed: (e) => {
        this.overallStatus = e.report.overallStatus;
        if (e.report.workflows.length === 0) {
          if (!this.headerPrinted) {
            writeOutput(bold(cyan("Checking workflows...")));
          }
          writeOutput(`  No workflow files found`);
          writeOutput("");
          writeOutput(
            `0 passed, 0 failed — ${green(bold("OVERALL: PASS"))}`,
          );
          return;
        }
        writeOutput(
          `\n${summaryCounts(e.report)} — ${
            overallLabel(e.report.overallStatus)
          }`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonWorkflowDoctorRenderer implements WorkflowDoctorRenderer {
  overallStatus: DoctorWorkflowsReport["overallStatus"] = "pass";

  handlers(): EventHandlers<DoctorWorkflowsEvent> {
    return {
      "workflow-checked": () => {},
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

export function createWorkflowDoctorRenderer(
  mode: OutputMode,
): WorkflowDoctorRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowDoctorRenderer();
    case "log":
      return new LogWorkflowDoctorRenderer();
  }
}
