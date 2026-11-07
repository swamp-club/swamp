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

import { gateAttemptMatches } from "../../domain/workflows/gate_state.ts";
import type {
  StepRun,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import { type SwampError, validationFailed } from "../errors.ts";

export const GATE_REOPENED_CODE = "gate_reopened";
export const AMBIGUOUS_GATE_CODE = "ambiguous_gate";

/** names the gate a decision is for; a caller sending none decides what waits */
export interface GateTarget {
  stepName: string;
  /** step names are unique only within a job */
  jobName?: string;
  /**
   * the action route's contract: a step name more than one job uses is refused
   * unless jobName picks one, and a refusal says what became of the gate
   */
  strictGate?: boolean;
  /** the attempt being answered, as the gate's approval row reports it */
  suspendedAt?: string;
}

export function ambiguousGateRefusal(
  run: WorkflowRun,
  target: GateTarget,
): SwampError | undefined {
  if (target.strictGate !== true || target.jobName !== undefined) {
    return undefined;
  }
  const jobs = run.jobs.filter((job) => job.getStep(target.stepName));
  return jobs.length > 1
    ? {
      code: AMBIGUOUS_GATE_CODE,
      message:
        `Step "${target.stepName}" is in more than one job; name the job`,
    }
    : undefined;
}

/**
 * a caller naming a time but no job means the gate waiting since then, so a
 * step name in parallel jobs is not read as a gate asked again
 */
export function waitingGate(
  run: WorkflowRun,
  target: GateTarget,
): { step: StepRun; jobName: string } | undefined {
  const waiting = run.jobs.flatMap((job) => {
    if (target.jobName !== undefined && job.jobName !== target.jobName) {
      return [];
    }
    const step = job.getStep(target.stepName);
    // A nested workflow step waiting on its child run is not a gate.
    return step && step.status === "waiting_approval" && !step.isNestedWait
      ? [{ step, jobName: job.jobName }]
      : [];
  });
  const attempt = target.suspendedAt;
  return (attempt !== undefined
    ? waiting.find(({ step }) => gateAttemptMatches(step, attempt))
    : undefined) ?? waiting[0];
}

export function reopenedGateRefusal(
  step: Pick<StepRun, "startedAt">,
  target: GateTarget,
): SwampError | undefined {
  if (target.suspendedAt === undefined) return undefined;
  // a value that names no time says nothing about the gate
  if (Number.isNaN(new Date(target.suspendedAt).getTime())) {
    return validationFailed(
      `suspendedAt must be an ISO 8601 time, as 'swamp workflow approvals --json' reports it`,
    );
  }
  if (gateAttemptMatches(step, target.suspendedAt)) return undefined;
  return {
    code: GATE_REOPENED_CODE,
    message:
      `Step "${target.stepName}" is not waiting on the attempt from ${target.suspendedAt}: it may have been asked again, or the time or run may be wrong. Read its current approval and decide again`,
  };
}
