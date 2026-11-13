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

import type { Workflow } from "./workflow.ts";
import {
  type AutoContinuationRefusal,
  isServeDrivenRun,
  type WorkflowRun,
} from "./workflow_run.ts";
import { assessRecoveryForRun } from "./recovery_assessment.ts";
import { fanOutStructure } from "./resume_reset.ts";
import { FAN_OUT_NEEDS_SERVE } from "./fan_out_job.ts";

// a step that takes serve down with it is continued this many times in a row
export const MAX_CONSECUTIVE_AUTO_CONTINUATIONS = 3;

export type AutoContinuationRefusalReason =
  | "workflow_missing"
  | "not_serve_driven"
  | "opted_out"
  | "continued_too_often"
  | "definition_changed"
  | "unguarded_step"
  | "fan_out_changed"
  | "nested_run_unsettled";

export interface AutoContinuationRefusalOf extends AutoContinuationRefusal {
  readonly reason: AutoContinuationRefusalReason;
}

// a refusal stands for its interruption: an operator who later lifts the
// cause decides with recover, except a nested run that settles on its own
const RETRIED_REFUSALS: ReadonlySet<string> = new Set(["nested_run_unsettled"]);

export type AutoContinuationVerdict =
  /** serve never stamped it, or refused it already, so nothing is recorded */
  | { readonly kind: "ineligible" }
  | { readonly kind: "continue"; readonly resetSteps: readonly string[] }
  | { readonly kind: "refuse"; readonly refusal: AutoContinuationRefusalOf };

export interface AutoContinuationChecks {
  readonly fanOutPoolAvailable: boolean;
  /** the unsettled nested run's description, or undefined when all settled */
  nestedRunUnsettled(run: WorkflowRun): Promise<string | undefined>;
}

/**
 * the same rule `swamp workflow recover` applies without
 * --acknowledge-unknown, plus the workflow's opt-out and the repeat cap
 */
export async function decideAutoContinuation(
  workflow: Workflow | null,
  run: WorkflowRun,
  checks: AutoContinuationChecks,
): Promise<AutoContinuationVerdict> {
  if (run.status !== "interrupted" || run.continuableSince === undefined) {
    return { kind: "ineligible" };
  }
  const refused = run.autoContinuation?.refused;
  if (
    refused !== undefined && !RETRIED_REFUSALS.has(refused.reason) &&
    refused.interruptedAt === run.continuableSince.toISOString()
  ) {
    return { kind: "ineligible" };
  }
  const recover =
    `Decide with 'swamp workflow recover ${run.workflowName} --run ${run.id}'.`;
  const refuse = (
    reason: AutoContinuationRefusalReason,
    problem: string,
    steps: readonly string[] = [],
  ): AutoContinuationVerdict => ({
    kind: "refuse",
    refusal: { reason, steps, message: `${problem} ${recover}` },
  });

  if (workflow === null) {
    return refuse(
      "workflow_missing",
      `Workflow ${run.workflowName} no longer exists.`,
    );
  }
  if (!isServeDrivenRun(run)) {
    return refuse(
      "not_serve_driven",
      "The run was not started through serve.",
    );
  }
  if (!workflow.shouldAutoContinue()) {
    return refuse(
      "opted_out",
      "The workflow sets autoContinue: false.",
    );
  }
  const cut = run.unknownSteps();
  if (
    run.consecutiveAutoContinuations() >= MAX_CONSECUTIVE_AUTO_CONTINUATIONS
  ) {
    const previous = run.autoContinuation?.resetSteps ?? [];
    const steps = [...new Set([...previous, ...cut])];
    return refuse(
      "continued_too_often",
      `The run was continued automatically ${MAX_CONSECUTIVE_AUTO_CONTINUATIONS} times in a row without a step finishing${
        steps.length > 0 ? `, each time cut off at ${steps.join(", ")}` : ""
      }.`,
      steps,
    );
  }
  const assessment = await assessRecoveryForRun(workflow, run);
  if (assessment.fingerprintMismatch) {
    return refuse(
      "definition_changed",
      assessment.reason ?? "The workflow definition changed.",
    );
  }
  if (assessment.unguardedSteps.length > 0) {
    const names = assessment.unguardedSteps;
    return refuse(
      "unguarded_step",
      names.length === 1
        ? `Step ${
          names[0]
        } was cut off and has no guard, so it may have done its work already.`
        : `Steps ${
          names.join(", ")
        } were cut off and have no guard, so they may have done their work already.`,
      names,
    );
  }
  const fanOut = fanOutStructure(workflow, run);
  if (fanOut !== undefined) return refuse("fan_out_changed", fanOut);
  const fanOutJob = workflow.jobs.find((job) => job.fanOut !== undefined);
  if (fanOutJob !== undefined && !checks.fanOutPoolAvailable) {
    return refuse(
      "fan_out_changed",
      `Job ${fanOutJob.name} fans out, and ${FAN_OUT_NEEDS_SERVE}.`,
    );
  }
  const nested = await checks.nestedRunUnsettled(run);
  if (nested !== undefined) return refuse("nested_run_unsettled", nested);
  return { kind: "continue", resetSteps: cut };
}
