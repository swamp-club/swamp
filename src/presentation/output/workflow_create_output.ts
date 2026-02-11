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

import { bold, cyan, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface WorkflowStepData {
  name: string;
  description: string;
  taskType: string;
}

export interface WorkflowJobData {
  name: string;
  description: string;
  steps: WorkflowStepData[];
}

export interface WorkflowCreateData {
  id: string;
  name: string;
  path: string;
  jobs?: WorkflowJobData[];
}

export function renderWorkflowCreate(
  data: WorkflowCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const lines = [
      `${bold(cyan("Created:"))} ${bold(data.name)}`,
      `${bold(cyan("Path:"))} ${data.path}`,
    ];

    if (data.jobs && data.jobs.length > 0) {
      lines.push("");
      lines.push(bold(cyan("Jobs:")));
      for (const job of data.jobs) {
        lines.push(
          `  ${bold(cyan(job.name))} ${dim("-")} ${job.description}`,
        );
        if (job.steps.length > 0) {
          lines.push(`    ${cyan("Steps:")}`);
          for (const step of job.steps) {
            lines.push(
              `      ${step.name} ${dim(`(${step.taskType})`)} ${
                dim("-")
              } ${step.description}`,
            );
          }
        }
      }
    }

    writeOutput(lines.join("\n"));
  }
}
