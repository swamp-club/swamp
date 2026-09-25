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
  StepSkipReasonInfo,
  WorkflowReportContext,
} from "../report_context.ts";
import type { ReportDefinition, ReportResult } from "../report.ts";

function isWorkflowContext(ctx: ReportContext): ctx is WorkflowReportContext {
  return ctx.scope === "workflow";
}

/**
 * One-line rendering of why a step did not run.
 *
 * A skip with no recorded reason reads as `skipped (reason not recorded)`
 * rather than a bare `skipped`: runs persisted before skip reasons existed
 * are legitimately silent, and saying so is honest where an unqualified
 * "skipped" invites the reader to assume a guard.
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
 * Per-run summary of a verification workflow: every step, its result, and why
 * anything was skipped.
 *
 * This used to be called `@swamp/verification-attestation` and label its JSON
 * `type: "verification-attestation"`, which claimed more than it delivered.
 * The attestation is a specific document — it binds a commit, pins the hashes
 * of the files that shaped the verification, and spans all three verify-*
 * workflows — and this report is none of those things: it is `scope:
 * "workflow"`, so it only ever sees one run, and it hashes nothing. With two
 * producers of attestation-shaped JSON in the tree, the one that could not
 * actually produce an attestation had the better claim to the name.
 *
 * The real thing is built by `scripts/build_attestation.ts` and typed by
 * `AttestationSchema`. That one lives in the repo rather than here on purpose:
 * which files get hashed and what a review verdict means are this repository's
 * verification policy, not something swamp should ship to everyone.
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
      taskType: string;
      errorMessage?: string;
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
        const typeLabel = step.taskType !== "model_method"
          ? step.taskType
          : step.modelType;
        lines.push(
          `  ${stepIcon} ${step.stepName}  —  ${typeLabel}  (${step.status})`,
        );

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
            const cmds = step.dataHandles.map((h) =>
              `swamp data get ${step.modelName} ${h.name}`
            );
            failureDetails.push({
              job: step.jobName,
              step: step.stepName,
              taskType: step.taskType,
              retrievalCommands: cmds,
            });
            for (const cmd of cmds) {
              lines.push(`    → \`${cmd}\``);
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

    // -- JSON: structured attestation for CI validation --
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
        // A single skip count cannot separate "a guard correctly excluded
        // this" from "the operator deselected this group", and CI reads the
        // count. The breakdown keeps the two distinguishable downstream.
        skippedByKind: skipBreakdown,
      },
    };

    return Promise.resolve({ markdown, json });
  },
};
