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

import { bold, cyan, green, red } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

export interface WorkflowValidateData {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export interface WorkflowValidateAllData {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

const checkmark = "\u2713";
const cross = "\u2717";
const arrow = "\u2192";

function formatValidationLines(validations: ValidationItemData[]): string[] {
  const lines: string[] = [];
  for (const v of validations) {
    if (v.passed) {
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

function formatResult(passed: boolean, label: string): string {
  return passed
    ? `${bold(cyan(`${label}:`))} ${green("PASSED")}`
    : `${bold(cyan(`${label}:`))} ${red("FAILED")}`;
}

export function renderWorkflowValidate(
  data: WorkflowValidateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const lines: string[] = [];
    lines.push(
      `${bold(cyan("Validating:"))} ${bold(data.workflowName)}`,
    );
    lines.push(...formatValidationLines(data.validations));

    const passedCount = data.validations.filter((v) => v.passed).length;
    const totalCount = data.validations.length;
    lines.push(
      `${
        bold(cyan("Summary:"))
      } ${passedCount}/${totalCount} validations passed`,
    );
    lines.push(formatResult(data.passed, "Result"));
    writeOutput(lines.join("\n"));
  }
}

export function renderWorkflowValidateAll(
  workflows: WorkflowValidateData[],
  mode: OutputMode,
): void {
  const totalPassed = workflows.filter((w) => w.passed).length;
  const totalFailed = workflows.length - totalPassed;
  const passed = totalFailed === 0;

  const data: WorkflowValidateAllData = {
    workflows,
    totalPassed,
    totalFailed,
    passed,
  };

  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const lines: string[] = [];
    lines.push(bold(cyan("Validating all workflows...")));

    for (const workflow of data.workflows) {
      lines.push("");
      lines.push(bold(cyan(workflow.workflowName)));
      lines.push(...formatValidationLines(workflow.validations));
      lines.push(formatResult(workflow.passed, "Result"));
    }

    lines.push("");
    lines.push(
      `${
        bold(cyan("Summary:"))
      } ${totalPassed}/${data.workflows.length} workflows passed`,
    );
    lines.push(formatResult(passed, "Overall"));
    writeOutput(lines.join("\n"));
  }
}
