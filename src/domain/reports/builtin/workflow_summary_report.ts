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

import type {
  ReportContext,
  WorkflowReportContext,
} from "../report_context.ts";
import type { ReportDefinition, ReportResult } from "../report.ts";

function isWorkflowContext(ctx: ReportContext): ctx is WorkflowReportContext {
  return ctx.scope === "workflow";
}

export const workflowSummaryReport: ReportDefinition = {
  description:
    "Built-in summary of a workflow execution including step statuses, failures, and data produced.",
  scope: "workflow",
  labels: ["summary"],

  execute(context: ReportContext): Promise<ReportResult> {
    if (!isWorkflowContext(context)) {
      throw new Error(
        "workflow-summary report requires workflow scope context",
      );
    }

    const {
      workflowStatus,
      workflowName,
      workflowRunId,
      workflowId,
      stepExecutions,
    } = context;

    const succeeded = stepExecutions.filter((s) => s.status === "succeeded")
      .length;
    const failed = stepExecutions.filter((s) => s.status === "failed").length;
    const skipped = stepExecutions.filter((s) => s.status === "skipped").length;
    const failures = stepExecutions.filter((s) => s.status === "failed");

    // Build markdown
    const lines: string[] = [
      `# ${workflowName}: ${workflowStatus}`,
      "",
      `${succeeded} succeeded \u00B7 ${failed} failed \u00B7 ${skipped} skipped`,
    ];

    // Failures section — only if any failed steps
    if (failures.length > 0) {
      lines.push("", "## Failures", "");
      lines.push("| Job | Step | Model | Retrieval Commands |");
      lines.push("| --- | ---- | ----- | ------------------ |");
      for (const step of failures) {
        const model = `${step.modelName} \u2192 ${step.methodName}`;
        if (step.dataHandles.length === 0) {
          lines.push(
            `| ${step.jobName} | **${step.stepName}** | ${model} | No data output. |`,
          );
        } else {
          const firstHandle = step.dataHandles[0];
          const firstCmd =
            `swamp data get ${step.modelName} ${firstHandle.name}`;
          lines.push(
            `| ${step.jobName} | **${step.stepName}** | ${model} | \`${firstCmd}\` |`,
          );
          for (let i = 1; i < step.dataHandles.length; i++) {
            const cmd = `swamp data get ${step.modelName} ${
              step.dataHandles[i].name
            }`;
            lines.push(`| | | | \`${cmd}\` |`);
          }
        }
      }
    }

    // Per-job sections
    const jobGroups = new Map<
      string,
      typeof stepExecutions
    >();
    for (const step of stepExecutions) {
      const group = jobGroups.get(step.jobName) ?? [];
      group.push(step);
      jobGroups.set(step.jobName, group);
    }

    for (const [jobName, steps] of jobGroups) {
      const jobStatus = steps.some((s) => s.status === "failed")
        ? "failed"
        : "succeeded";
      lines.push("", `## Job: ${jobName} (${jobStatus})`, "");
      lines.push("| Step | Model | Status |");
      lines.push("| ---- | ----- | ------ |");
      for (const step of steps) {
        const model = `${step.modelName} \u2192 ${step.methodName}`;
        if (step.status === "failed") {
          lines.push(
            `| **${step.stepName}** | **${model}** | **${step.status}** |`,
          );
        } else {
          lines.push(
            `| ${step.stepName} | ${model} | ${step.status} |`,
          );
        }
      }
    }

    const markdown = lines.join("\n");

    // Build JSON
    const json: Record<string, unknown> = {
      status: workflowStatus,
      workflowId,
      workflowRunId,
      workflowName,
      totalSteps: stepExecutions.length,
      succeeded,
      failed,
      skipped,
      failures: failures.map((s) => ({
        jobName: s.jobName,
        stepName: s.stepName,
        modelName: s.modelName,
        methodName: s.methodName,
        retrievalCommands: s.dataHandles.map((h) =>
          `swamp data get ${s.modelName} ${h.name}`
        ),
      })),
      steps: stepExecutions.map((s) => ({
        jobName: s.jobName,
        stepName: s.stepName,
        modelName: s.modelName,
        modelType: s.modelType,
        methodName: s.methodName,
        status: s.status,
        retrievalCommands: s.dataHandles.map((h) =>
          `swamp data get ${s.modelName} ${h.name}`
        ),
      })),
    };

    return Promise.resolve({ markdown, json });
  },
};
