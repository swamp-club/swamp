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

import type { MethodReportContext, ReportContext } from "../report_context.ts";
import type { ReportDefinition, ReportResult } from "../report.ts";

function isMethodContext(ctx: ReportContext): ctx is MethodReportContext {
  return ctx.scope === "method";
}

function formatArgs(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) {
    return "";
  }
  return "```json\n" + JSON.stringify(args, null, 2) + "\n```";
}

export const methodSummaryReport: ReportDefinition = {
  description:
    "Built-in summary of a model method execution including status, arguments, and data produced.",
  scope: "method",
  labels: ["summary"],

  execute(context: ReportContext): Promise<ReportResult> {
    if (!isMethodContext(context)) {
      throw new Error("method-summary report requires method scope context");
    }

    const {
      executionStatus,
      definition,
      modelType,
      methodName,
      globalArgs,
      methodArgs,
      dataHandles,
    } = context;

    // Build markdown
    const lines: string[] = [
      "# Method Summary",
      "",
      `**Status**: ${executionStatus}`,
      `**Model**: ${definition.name} (${definition.id})`,
      `**Type**: ${modelType.normalized}`,
      `**Method**: ${methodName}`,
      "",
      "## Arguments",
      "",
      "### Global Arguments",
      "",
    ];

    if (!globalArgs || Object.keys(globalArgs).length === 0) {
      lines.push("No global arguments.");
    } else {
      lines.push(formatArgs(globalArgs));
    }

    lines.push("", "### Method Arguments", "");

    if (!methodArgs || Object.keys(methodArgs).length === 0) {
      lines.push("No method arguments.");
    } else {
      lines.push(formatArgs(methodArgs));
    }

    lines.push("", "## Data Produced", "");

    if (dataHandles.length === 0) {
      lines.push("No data produced.");
    } else {
      lines.push("| Name | Kind | Size |");
      lines.push("| ---- | ---- | ---- |");
      for (const handle of dataHandles) {
        lines.push(`| ${handle.name} | ${handle.kind} | ${handle.size} |`);
      }
    }

    const markdown = lines.join("\n");

    // Build JSON
    const json: Record<string, unknown> = {
      status: executionStatus,
      modelId: definition.id,
      modelName: definition.name,
      modelType: modelType.normalized,
      methodName,
      globalArgs: globalArgs ?? {},
      methodArgs: methodArgs ?? {},
      dataProduced: dataHandles.map((h) => ({
        name: h.name,
        kind: h.kind,
        size: h.size,
      })),
    };

    return Promise.resolve({ markdown, json });
  },
};
