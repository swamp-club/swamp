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

export const verificationAttestationReport: ReportDefinition = {
  description:
    "Structured attestation of a verification workflow run — captures every step, its result, and the environment for CI validation.",
  scope: "workflow",
  labels: ["verification", "attestation"],

  execute(context: ReportContext): Promise<ReportResult> {
    if (!isWorkflowContext(context)) {
      throw new Error(
        "verification-attestation report requires workflow scope context",
      );
    }

    const {
      workflowStatus,
      workflowName,
      workflowRunId,
      workflowId,
      stepExecutions,
      inputs,
    } = context;

    const succeeded = stepExecutions.filter((s) => s.status === "succeeded")
      .length;
    const failed = stepExecutions.filter((s) => s.status === "failed").length;
    const skipped = stepExecutions.filter((s) => s.status === "skipped").length;

    const commit = (inputs?.["commit"] as string) ?? "unknown";
    const branch = (inputs?.["branch"] as string) ?? "unknown";

    const jobGroups = new Map<
      string,
      typeof stepExecutions
    >();
    for (const step of stepExecutions) {
      const group = jobGroups.get(step.jobName) ?? [];
      group.push(step);
      jobGroups.set(step.jobName, group);
    }

    // -- Markdown: human-readable checklist --
    const lines: string[] = [
      `# Verification Attestation`,
      "",
      `**Commit:** \`${commit}\`  `,
      `**Branch:** \`${branch}\`  `,
      `**Status:** ${workflowStatus}  `,
      `**Steps:** ${succeeded} passed · ${failed} failed · ${skipped} skipped`,
      "",
    ];

    const failureDetails: Array<{
      job: string;
      step: string;
      retrievalCommands: string[];
    }> = [];

    for (const [jobName, steps] of jobGroups) {
      const jobPassed = steps.every((s) =>
        s.status === "succeeded" || s.status === "skipped"
      );
      const icon = jobPassed ? "✓" : "✗";
      lines.push(`${icon} **${jobName}**`);
      for (const step of steps) {
        const stepIcon = step.status === "succeeded"
          ? "✓"
          : step.status === "skipped"
          ? "○"
          : "✗";
        lines.push(
          `  ${stepIcon} ${step.stepName}  —  ${step.modelType}  (${step.status})`,
        );

        if (step.status === "failed" && step.dataHandles.length > 0) {
          const cmds = step.dataHandles.map((h) =>
            `swamp data get ${step.modelName} ${h.name}`
          );
          failureDetails.push({
            job: step.jobName,
            step: step.stepName,
            retrievalCommands: cmds,
          });
          for (const cmd of cmds) {
            lines.push(`    → \`${cmd}\``);
          }
        }
      }
      lines.push("");
    }

    lines.push(
      `**Gate:** ${succeeded}/${stepExecutions.length} passed, ${skipped} skipped`,
    );

    const markdown = lines.join("\n");

    // -- JSON: structured attestation for CI validation --
    const json: Record<string, unknown> = {
      version: "1",
      type: "verification-attestation",
      workflowRunId,
      workflowId,
      workflowName,

      subject: {
        commit,
        branch,
      },

      steps: stepExecutions.map((s) => ({
        job: s.jobName,
        step: s.stepName,
        model: s.modelType,
        method: s.methodName,
        status: s.status,
        retrievalCommands: s.status === "failed"
          ? s.dataHandles.map((h) => `swamp data get ${s.modelName} ${h.name}`)
          : undefined,
      })),

      failures: failureDetails.length > 0 ? failureDetails : undefined,

      gate: {
        allPassed: workflowStatus === "succeeded",
        stepsCompleted: succeeded,
        stepsTotal: stepExecutions.length,
        stepsSkipped: skipped,
        stepsFailed: failed,
      },
    };

    return Promise.resolve({ markdown, json });
  },
};
