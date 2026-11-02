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

import {
  renderDataPointer,
  retrievalCommands,
  stepDataPointers,
} from "./data_pointers.ts";
import type {
  ReportContext,
  StepSkipReasonInfo,
  WorkflowReportContext,
} from "../report_context.ts";
import type { ReportDefinition, ReportResult } from "../report.ts";

function isWorkflowContext(ctx: ReportContext): ctx is WorkflowReportContext {
  return ctx.scope === "workflow";
}

/**
 * a skip with no recorded reason reads 'reason not recorded', since older
 * persisted runs are legitimately silent and a bare 'skipped' invites the
 * reader to assume a guard
 */
function describeSkipReason(reason: StepSkipReasonInfo | undefined): string {
  if (!reason) return "reason not recorded";
  switch (reason.kind) {
    case "guarded":
      return reason.expression
        ? `guard: ${reason.expression}`
        // Bare "guard", matching the run display exactly. The two surfaces
        // report the same fact and a reader comparing them should not have to
        // decide whether two different phrasings mean two different things.
        : "guard";
    case "dependency":
      return "dependency condition not met";
    case "job_skipped":
      return "job was skipped";
  }
}

/**
 * a per-run summary only, not an attestation: the real one is built by
 * scripts/build_attestation.ts and lives in the repo because what gets hashed
 * is this repository's verification policy
 */
export const verificationSummaryReport: ReportDefinition = {
  description:
    "Built-in summary of a verification workflow run — every step, its result, why anything was skipped, and how to retrieve a failure's output.",
  scope: "workflow",
  labels: ["verification", "summary"],

  execute(context: ReportContext): Promise<ReportResult> {
    if (!isWorkflowContext(context)) {
      throw new Error(
        "verification-summary report requires workflow scope context",
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

    const skipBreakdown: Record<string, number> = {};
    for (const step of stepExecutions) {
      if (step.status !== "skipped") continue;
      const kind = step.skipReason?.kind ?? "unrecorded";
      skipBreakdown[kind] = (skipBreakdown[kind] ?? 0) + 1;
    }

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
      taskType: string;
      errorMessage?: string;
      retrievalCommands: string[];
      dataProduced?: ReturnType<typeof stepDataPointers>;
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
        const typeLabel = step.taskType !== "model_method"
          ? step.taskType
          : step.modelType;
        lines.push(
          `  ${stepIcon} ${step.stepName}  —  ${typeLabel}  (${step.status})`,
        );

        if (step.status !== "failed") {
          for (const pointer of stepDataPointers(workflowRunId, step)) {
            if (pointer.availability === "ephemeral") {
              lines.push(`    ${renderDataPointer(pointer)}`);
            }
          }
        }

        if (step.status === "skipped") {
          lines.push(`    ${describeSkipReason(step.skipReason)}`);
        }

        if (step.status === "failed") {
          if (step.taskType !== "model_method" && step.errorMessage) {
            failureDetails.push({
              job: step.jobName,
              step: step.stepName,
              taskType: step.taskType,
              errorMessage: step.errorMessage,
              retrievalCommands: [],
            });
            lines.push(`    ${step.errorMessage}`);
          } else if (step.dataHandles.length > 0) {
            const cmds = retrievalCommands(
              stepDataPointers(workflowRunId, step),
            );
            failureDetails.push({
              job: step.jobName,
              step: step.stepName,
              taskType: step.taskType,
              retrievalCommands: cmds,
              dataProduced: stepDataPointers(workflowRunId, step),
            });
            for (const pointer of stepDataPointers(workflowRunId, step)) {
              lines.push(`    → ${renderDataPointer(pointer)}`);
            }
          }
        }
      }
      lines.push("");
    }

    lines.push(
      `**Gate:** ${succeeded}/${stepExecutions.length} passed, ${skipped} skipped`,
    );

    const markdown = lines.join("\n");

    const json: Record<string, unknown> = {
      version: "1",
      type: "verification-summary",
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
        taskType: s.taskType,
        model: s.modelType || undefined,
        method: s.methodName || undefined,
        status: s.status,
        errorMessage: s.errorMessage,
        // `skipKind` is the machine-readable discriminator CI can count on;
        // `reason` is the same fact rendered for a human reading the table.
        skipKind: s.status === "skipped" ? s.skipReason?.kind : undefined,
        skipExpression: s.status === "skipped"
          ? s.skipReason?.expression
          : undefined,
        reason: s.status === "skipped"
          ? describeSkipReason(s.skipReason)
          : undefined,
        dataProduced: stepDataPointers(workflowRunId, s),
        retrievalCommands: s.status === "failed"
          ? retrievalCommands(stepDataPointers(workflowRunId, s))
          : undefined,
      })),

      failures: failureDetails.length > 0 ? failureDetails : undefined,

      gate: {
        allPassed: workflowStatus === "succeeded",
        stepsCompleted: succeeded,
        stepsTotal: stepExecutions.length,
        stepsSkipped: skipped,
        stepsFailed: failed,
        // A single skip count cannot separate "a guard correctly excluded
        // this" from "the operator deselected this group", and CI reads the
        // count. The breakdown keeps the two distinguishable downstream.
        skippedByKind: skipBreakdown,
      },
    };

    return Promise.resolve({ markdown, json });
  },
};
