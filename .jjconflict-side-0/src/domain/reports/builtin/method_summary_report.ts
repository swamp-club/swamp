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
      redactSensitiveArgs,
    } = context;

    const redact = redactSensitiveArgs ??
      ((a: Record<string, unknown>) => a);
    const redactedGlobalArgs = redact(globalArgs ?? {}, "global");
    const redactedMethodArgs = redact(methodArgs ?? {}, "method");

    const hasGlobal = Object.keys(redactedGlobalArgs).length > 0;
    const hasMethod = Object.keys(redactedMethodArgs).length > 0;

    // Build markdown
    const lines: string[] = [
      `# ${definition.name} (${modelType.normalized}) \u2192 ${methodName}: ${executionStatus}`,
      "",
      "## Arguments",
      "",
    ];

    if (!hasGlobal && !hasMethod) {
      lines.push("No arguments.");
    } else {
      if (hasGlobal) {
        lines.push("**Global Arguments**", "", formatArgs(redactedGlobalArgs));
      }
      if (hasGlobal && hasMethod) {
        lines.push("");
      }
      if (hasMethod) {
        lines.push("**Method Arguments**", "", formatArgs(redactedMethodArgs));
      }
    }

    lines.push("", "## Data Output", "");

    if (dataHandles.length === 0) {
      lines.push("No data output.");
    } else {
      lines.push("| Name | Kind | Retrieval Command |");
      lines.push("| ---- | ---- | ----------------- |");
      for (const handle of dataHandles) {
        const cmd = `swamp data get ${definition.name} ${handle.name}`;
        lines.push(
          `| **${handle.name}** | ${handle.kind} | \`${cmd}\` |`,
        );
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
      globalArgs: redactedGlobalArgs,
      methodArgs: redactedMethodArgs,
      dataProduced: dataHandles.map((h) => ({
        name: h.name,
        kind: h.kind,
        retrievalCommand: `swamp data get ${definition.name} ${h.name}`,
      })),
    };

    return Promise.resolve({ markdown, json });
  },
};
