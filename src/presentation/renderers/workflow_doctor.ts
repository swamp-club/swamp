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

import { bold, cyan, dim, green, red } from "@std/fmt/colors";
import type {
  DoctorWorkflowsEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

export interface WorkflowDoctorRenderer extends Renderer<DoctorWorkflowsEvent> {
  readonly overallStatus: "pass" | "fail";
}

class LogWorkflowDoctorRenderer implements WorkflowDoctorRenderer {
  overallStatus: "pass" | "fail" = "pass";
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
        const status = e.report.overallStatus === "pass"
          ? green(bold("OVERALL: PASS"))
          : red(bold("OVERALL: FAIL"));
        writeOutput(
          `\n${e.report.totalPassed} passed, ${e.report.totalFailed} failed — ${status}`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonWorkflowDoctorRenderer implements WorkflowDoctorRenderer {
  overallStatus: "pass" | "fail" = "pass";

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
