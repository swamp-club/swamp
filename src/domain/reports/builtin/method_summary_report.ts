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
import type { DataHandle } from "../../models/model.ts";
import type { ReportDefinition, ReportResult } from "../report.ts";

function isMethodContext(ctx: ReportContext): ctx is MethodReportContext {
  return ctx.scope === "method";
}

/**
 * Builds a narrative description of what happened during the method execution.
 */
function buildNarrative(
  definition: { name: string },
  modelType: string,
  methodName: string,
  executionStatus: "succeeded" | "failed",
  errorMessage: string | undefined,
  dataHandles: DataHandle[],
): string {
  if (executionStatus === "failed") {
    const reason = errorMessage ? `: ${errorMessage}` : "";
    return `${methodName} on ${definition.name} (${modelType}) failed${reason}`;
  }

  if (dataHandles.length === 0) {
    return `${methodName} on ${definition.name} (${modelType}) succeeded with no data output.`;
  }

  // Group handles by specName
  const groups = new Map<string, { kind: string; count: number }>();
  for (const handle of dataHandles) {
    const existing = groups.get(handle.specName);
    if (existing) {
      existing.count++;
    } else {
      groups.set(handle.specName, { kind: handle.kind, count: 1 });
    }
  }

  const parts: string[] = [];
  for (const [specName, { kind, count }] of groups) {
    parts.push(`${count} ${kind}${count > 1 ? "s" : ""} (${specName})`);
  }

  return `${methodName} on ${definition.name} (${modelType}) succeeded, producing ${
    parts.join(", ")
  }.`;
}

/**
 * Renders the data pointers section: compact resource names grouped by spec,
 * with one example retrieval command.
 */
function renderPointersMarkdown(
  definitionName: string,
  dataHandles: DataHandle[],
): string[] {
  if (dataHandles.length === 0) {
    return ["## Data Output", "", "No data output."];
  }

  const lines: string[] = ["## Data Output", ""];
  lines.push("| Name | Kind | Retrieval Command |");
  lines.push("| ---- | ---- | ----------------- |");
  for (const handle of dataHandles) {
    const cmd =
      `swamp data get ${definitionName} ${handle.name} --version ${handle.version}`;
    lines.push(`| **${handle.name}** | ${handle.kind} | \`${cmd}\` |`);
  }

  return lines;
}

export const methodSummaryReport: ReportDefinition = {
  description:
    "Built-in summary of a model method execution including narrative, output schema, and data pointers.",
  scope: "method",
  labels: ["summary"],

  execute(context: ReportContext): Promise<ReportResult> {
    if (!isMethodContext(context)) {
      throw new Error("method-summary report requires method scope context");
    }

    const {
      executionStatus,
      errorMessage,
      definition,
      modelType,
      methodName,
      globalArgs,
      methodArgs,
      dataHandles,
      outputSpecs,
      redactSensitiveArgs,
      swampSha,
    } = context;

    // Build narrative
    const narrative = buildNarrative(
      definition,
      modelType.normalized,
      methodName,
      executionStatus,
      errorMessage,
      dataHandles,
    );

    // Build markdown — compact for human terminal display.
    // Schema lives in the JSON for agent retrieval.
    const versionSuffix = swampSha ? ` | git sha: ${swampSha}` : "";
    const lines: string[] = [
      `# ${definition.name} (${modelType.normalized}) \u2192 ${methodName}: ${executionStatus}${versionSuffix}`,
      "",
      narrative,
      "",
    ];

    if (errorMessage) {
      lines.push("## Error", "", errorMessage, "");
    }

    // Arguments section
    const redactedGlobal = redactSensitiveArgs
      ? redactSensitiveArgs(globalArgs, "global")
      : globalArgs;
    const redactedMethod = redactSensitiveArgs
      ? redactSensitiveArgs(methodArgs, "method")
      : methodArgs;

    lines.push("## Arguments", "");
    lines.push("**Global Arguments**", "");
    lines.push("```json", JSON.stringify(redactedGlobal, null, 2), "```", "");
    lines.push("**Method Arguments**", "");
    lines.push("```json", JSON.stringify(redactedMethod, null, 2), "```", "");

    if (dataHandles.length > 0) {
      lines.push(...renderPointersMarkdown(definition.name, dataHandles));
    }

    const markdown = lines.join("\n");

    // Build JSON
    const json: Record<string, unknown> = {
      status: executionStatus,
      ...(errorMessage ? { error: errorMessage } : {}),
      modelName: definition.name,
      modelType: modelType.normalized,
      methodName,
      ...(swampSha ? { swampSha } : {}),
      narrative,
      globalArgs: redactedGlobal,
      methodArgs: redactedMethod,
      ...(outputSpecs && outputSpecs.length > 0 ? { outputSpecs } : {}),
      dataProduced: dataHandles.map((h) => ({
        name: h.name,
        kind: h.kind,
        specName: h.specName,
        version: h.version,
      })),
    };

    return Promise.resolve({ markdown, json });
  },
};
