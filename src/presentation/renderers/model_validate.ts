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
import {
  type EventHandlers,
  isModelValidateAllData,
  type ModelValidateAllData,
  type ModelValidateData,
  type ModelValidateEvent,
  type ModelValidationItemData,
  type ModelValidationWarningData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import {
  distinctRemedies,
  type ExpressionPathError,
} from "../../domain/models/validation_service.ts";
import { formatAvailableKeys } from "../../domain/expressions/schema_path_validator.ts";

const checkmark = "\u2713";
const cross = "\u2717";
const arrow = "\u2192";
const warning = "\u26A0";

function formatValidationLines(
  validations: ModelValidationItemData[],
): string[] {
  const lines: string[] = [];
  for (const v of validations) {
    if (v.passed) {
      lines.push(`  ${green(checkmark)} ${v.name}`);
    } else {
      lines.push(`  ${red(cross)} ${v.name}`);
      if (v.expressionErrors?.length) {
        for (const line of formatExpressionErrorLines(v.expressionErrors)) {
          lines.push(line);
        }
      } else if (v.error) {
        lines.push(`    ${red(arrow)} ${v.error}`);
      }
    }
  }
  return lines;
}

// The same layout as formatExpressionPathErrors in the domain, with the
// renderer's indent and fail arrows. Keep the two in step.
function formatExpressionErrorLines(
  errors: readonly ExpressionPathError[],
): string[] {
  const lines: string[] = [];
  for (const err of errors) {
    lines.push(`    ${red(arrow)} ${err.expression}`);
    lines.push(`      ${err.error}`);
    if (err.suggestion) lines.push(`      ${err.suggestion}`);
    if (err.availableKeys?.length) {
      lines.push(`      Available: ${formatAvailableKeys(err.availableKeys)}`);
    }
  }
  for (const remedy of distinctRemedies(errors)) {
    lines.push(`    ${remedy}`);
  }
  return lines;
}

function formatWarningLines(
  warnings: ModelValidationWarningData[],
): string[] {
  const lines: string[] = [];
  for (const w of warnings) {
    lines.push(`  ${yellow(warning)} ${yellow(w.name)}`);
    if (w.envVars) {
      for (const detail of w.envVars) {
        lines.push(`    ${detail.path} uses ${bold(detail.envVar)}`);
      }
    }
    if (w.templates) {
      for (const detail of w.templates) {
        lines.push(`    ${detail.path} passes ${bold(detail.text)}`);
      }
    }
    lines.push(`    ${yellow(arrow)} ${w.message}`);
  }
  return lines;
}

function formatResult(passed: boolean, label: string): string {
  return passed
    ? `${bold(cyan(`${label}:`))} ${green("PASSED")}`
    : `${bold(cyan(`${label}:`))} ${red("FAILED")}`;
}

export interface ModelValidateRenderer extends Renderer<ModelValidateEvent> {
  passed(): boolean;
}

class LogModelValidateRenderer implements ModelValidateRenderer {
  private _passed = true;

  passed(): boolean {
    return this._passed;
  }

  handlers(): EventHandlers<ModelValidateEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (isModelValidateAllData(e.data)) {
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

  private renderSingle(data: ModelValidateData): void {
    this._passed = data.passed;
    const lines: string[] = [];
    lines.push(
      `${bold(cyan("Validating:"))} ${bold(data.modelName)} ${
        dim(`(${data.type})`)
      }`,
    );
    lines.push(...formatValidationLines(data.validations));
    if (data.warnings.length > 0) {
      lines.push(...formatWarningLines(data.warnings));
    }

    const passedCount = data.validations.filter((v) => v.passed).length;
    const totalCount = data.validations.length;
    const warningCount = data.warnings.length;
    const summaryParts = [`${passedCount}/${totalCount} validations passed`];
    if (warningCount > 0) {
      summaryParts.push(
        `${yellow(`${warningCount} warning${warningCount > 1 ? "s" : ""}`)}`,
      );
    }
    lines.push(`${bold(cyan("Summary:"))} ${summaryParts.join(", ")}`);
    lines.push(formatResult(data.passed, "Result"));
    writeOutput(lines.join("\n"));
  }

  private renderAll(data: ModelValidateAllData): void {
    this._passed = data.passed;
    const lines: string[] = [];
    lines.push(bold(cyan("Validating all models...")));

    for (const model of data.models) {
      lines.push("");
      lines.push(
        `${bold(cyan(model.modelName))} ${dim(`(${model.type})`)}`,
      );
      lines.push(...formatValidationLines(model.validations));
      if (model.warnings.length > 0) {
        lines.push(...formatWarningLines(model.warnings));
      }
      lines.push(formatResult(model.passed, "Result"));
    }

    lines.push("");
    const summaryParts = [
      `${data.totalPassed}/${data.models.length} models passed`,
    ];
    if (data.totalWarnings > 0) {
      summaryParts.push(
        `${
          yellow(
            `${data.totalWarnings} warning${data.totalWarnings > 1 ? "s" : ""}`,
          )
        }`,
      );
    }
    lines.push(`${bold(cyan("Summary:"))} ${summaryParts.join(", ")}`);
    lines.push(formatResult(data.passed, "Overall"));
    writeOutput(lines.join("\n"));
  }
}

class JsonModelValidateRenderer implements ModelValidateRenderer {
  private _passed = true;

  passed(): boolean {
    return this._passed;
  }

  handlers(): EventHandlers<ModelValidateEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        if (isModelValidateAllData(e.data)) {
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

export function createModelValidateRenderer(
  mode: OutputMode,
): ModelValidateRenderer {
  switch (mode) {
    case "json":
      return new JsonModelValidateRenderer();
    case "log":
      return new LogModelValidateRenderer();
  }
}
