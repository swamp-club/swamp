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

import { bold, cyan, green, red, yellow } from "@std/fmt/colors";
import {
  type EventHandlers,
  isWorkflowValidateAllData,
  type WorkflowValidateAllData,
  type WorkflowValidateData,
  type WorkflowValidateEvent,
  type WorkflowValidationItemData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const checkmark = "\u2713";
const cross = "\u2717";
const arrow = "\u2192";
const warningSign = "\u26a0";

function formatValidationLines(
  validations: WorkflowValidationItemData[],
): string[] {
  const lines: string[] = [];
  for (const v of validations) {
    if (v.warning) {
      lines.push(`  ${yellow(warningSign)} ${v.name}`);
      if (v.error) {
        lines.push(`    ${yellow(arrow)} ${v.error}`);
      }
    } else if (v.passed) {
      lines.push(`  ${green(checkmark)} ${v.name}`);
    } else {
      lines.push(`  ${red(cross)} ${v.name}`);
      if (v.error) {
        lines.push(`    ${red(arrow)} ${v.error}`);
      }
    }
  }
  return lines;
}

function formatSummary(
  validations: WorkflowValidationItemData[],
  totalWarnings: number,
): string {
  const passedCount = validations.filter((v) => v.passed && !v.warning).length;
  const failedCount = validations.filter((v) => !v.passed).length;
  const parts = [`${passedCount} passed`];
  if (totalWarnings > 0) {
    parts.push(`${totalWarnings} warning(s)`);
  }
  if (failedCount > 0) {
    parts.push(`${failedCount} failed`);
  }
  return parts.join(", ");
}

function formatResult(passed: boolean, label: string): string {
  return passed
    ? `${bold(cyan(`${label}:`))} ${green("PASSED")}`
    : `${bold(cyan(`${label}:`))} ${red("FAILED")}`;
}

export interface WorkflowValidateRenderer
  extends Renderer<WorkflowValidateEvent> {
  passed(): boolean;
}

class LogWorkflowValidateRenderer implements WorkflowValidateRenderer {
  private _passed = true;

  passed(): boolean {
    return this._passed;
  }

  handlers(): EventHandlers<WorkflowValidateEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (isWorkflowValidateAllData(e.data)) {
          this.renderAll(e.data);
        } else {
          this.renderSingle(e.data);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  private renderSingle(data: WorkflowValidateData): void {
    this._passed = data.passed;
    const lines: string[] = [];
    lines.push(
      `${bold(cyan("Validating:"))} ${bold(data.workflowName)}`,
    );
    lines.push(...formatValidationLines(data.validations));

    lines.push(
      `${bold(cyan("Summary:"))} ${
        formatSummary(data.validations, data.totalWarnings)
      }`,
    );
    lines.push(formatResult(data.passed, "Result"));
    writeOutput(lines.join("\n"));
  }

  private renderAll(data: WorkflowValidateAllData): void {
    this._passed = data.passed;
    const lines: string[] = [];
    lines.push(bold(cyan("Validating all workflows...")));

    for (const workflow of data.workflows) {
      lines.push("");
      lines.push(bold(cyan(workflow.workflowName)));
      lines.push(...formatValidationLines(workflow.validations));
      lines.push(formatResult(workflow.passed, "Result"));
    }

    lines.push("");
    const parts = [
      `${data.totalPassed}/${data.workflows.length} workflows passed`,
    ];
    if (data.totalWarnings > 0) {
      parts.push(`${data.totalWarnings} warning(s)`);
    }
    lines.push(`${bold(cyan("Summary:"))} ${parts.join(", ")}`);
    lines.push(formatResult(data.passed, "Overall"));
    writeOutput(lines.join("\n"));
  }
}

class JsonWorkflowValidateRenderer implements WorkflowValidateRenderer {
  private _passed = true;

  passed(): boolean {
    return this._passed;
  }

  handlers(): EventHandlers<WorkflowValidateEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (isWorkflowValidateAllData(e.data)) {
          this._passed = e.data.passed;
        } else {
          this._passed = e.data.passed;
        }
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createWorkflowValidateRenderer(
  mode: OutputMode,
): WorkflowValidateRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowValidateRenderer();
    case "log":
      return new LogWorkflowValidateRenderer();
  }
}
