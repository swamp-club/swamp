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
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "./approval_timeout.ts";
import type { Workflow } from "./workflow.ts";
import type { StepRun, WorkflowRun } from "./workflow_run.ts";

export type GateState =
  | "absent"
  | "ambiguous"
  | "not_reached"
  | "waiting"
  | "expired"
  | "nested"
  | "decided"
  | "run_active"
  | "closed";

/** explains a refused decision; only the check under the run's claim allows one */
export function classifyGate(
  run: WorkflowRun,
  workflow: Workflow,
  stepName: string,
  options: { jobName?: string; now?: Date } = {},
): GateState {
  const matches = run.jobs.flatMap((job) => {
    if (options.jobName !== undefined && job.jobName !== options.jobName) {
      return [];
    }
    const step = job.getStep(stepName);
    return step ? [{ jobName: job.jobName, step }] : [];
  });
  if (matches.length === 0) return "absent";
  if (matches.length > 1) return "ambiguous";
  const { jobName, step } = matches[0];

  if (step.approvalDecision !== undefined) return "decided";
  if (step.isNestedWait) return "nested";
  if (step.status === "waiting_approval") {
    // a run walking again asks an undecided gate again, so this is not final
    if (run.status === "running") return "run_active";
    if (run.status !== "suspended") return "closed";
    const steps = workflow.jobs.find((job) => job.name === jobName)?.steps;
    const timeout = evaluateApprovalTimeout(
      step.startedAt,
      gateTimeoutSeconds(step, steps),
      options.now ?? new Date(),
    );
    return timeout?.expired ? "expired" : "waiting";
  }
  if (step.status === "pending") {
    return run.status === "suspended" || run.status === "running"
      ? "not_reached"
      : "closed";
  }
  return "closed";
}

/** names one attempt of a gate: a re-opened gate waits from a new start time */
export function gateAttemptMatches(
  step: Pick<StepRun, "startedAt">,
  suspendedAt: string,
): boolean {
  const expected = new Date(suspendedAt).getTime();
  return !Number.isNaN(expected) && step.startedAt?.getTime() === expected;
}
