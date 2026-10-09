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

import type { Step } from "./step.ts";

/**
 * Result of evaluating a manual-approval deadline for a suspended step.
 */
export interface ApprovalTimeout {
  /** Whether the approval window has elapsed (`now > suspendedAt + timeout`). */
  expired: boolean;
  /** Seconds the step has been waiting for approval. */
  elapsedSeconds: number;
  /** The configured timeout, in seconds. */
  timeoutSeconds: number;
}

/** The parts of a step run that say which timeout its gate has. */
export interface GateStepRun {
  readonly stepName: string;
  readonly approvalTimeout?: number;
  readonly forEachTemplate?: string;
}

/**
 * The timeout, in seconds, of the gate a step run waits on, or `undefined`
 * when the gate has no deadline.
 *
 * The step run holds the timeout its gate was requested with, and that one
 * wins: the deadline of a waiting gate does not move when the workflow is
 * edited. A run record written before the step run held it (swamp-club#3218)
 * is answered by the definition: the step of the run's name, or, for a step
 * expanded by forEach, the step it was expanded from.
 */
export function gateTimeoutSeconds(
  step: GateStepRun | undefined,
  definitionSteps: ReadonlyArray<Step> | undefined,
): number | undefined {
  if (!step) return undefined;
  if (step.approvalTimeout !== undefined) return step.approvalTimeout;
  const defined = definitionSteps?.find((s) => s.name === step.stepName) ??
    (step.forEachTemplate !== undefined
      ? definitionSteps?.find((s) => s.name === step.forEachTemplate)
      : undefined);
  const taskData = defined?.task.data;
  return taskData?.type === "manual_approval" ? taskData.timeout : undefined;
}

/**
 * Evaluates the manual-approval deadline for a suspended step.
 *
 * Returns `undefined` when the step has no approval deadline to enforce —
 * either its gate has no timeout (see `gateTimeoutSeconds`) or it never
 * recorded a start time. In those cases the approval never expires on its
 * own.
 *
 * This is the single source of truth for the deadline check, shared by
 * `workflow approve` (which rejects expired approvals) and
 * `workflow approvals` (which filters them out of the actionable listing) so
 * both apply the identical `now > suspendedAt + timeout` rule.
 */
export function evaluateApprovalTimeout(
  startedAt: Date | undefined,
  timeoutSeconds: number | undefined,
  now: Date,
): ApprovalTimeout | undefined {
  if (!startedAt || !timeoutSeconds) {
    return undefined;
  }

  const elapsedSeconds = (now.getTime() - startedAt.getTime()) / 1000;
  return {
    expired: elapsedSeconds > timeoutSeconds,
    elapsedSeconds,
    timeoutSeconds,
  };
}
