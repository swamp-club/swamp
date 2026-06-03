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

import type { StepTaskData } from "./step_task.ts";

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

/**
 * Evaluates the manual-approval deadline for a suspended step.
 *
 * Returns `undefined` when the step has no approval deadline to enforce —
 * either it is not a `manual_approval` task, has no `timeout` configured, or
 * never recorded a start time. In those cases the approval never expires on
 * its own.
 *
 * This is the single source of truth for the deadline check, shared by
 * `workflow approve` (which rejects expired approvals) and
 * `workflow approvals` (which filters them out of the actionable listing) so
 * both apply the identical `now > suspendedAt + timeout` rule.
 */
export function evaluateApprovalTimeout(
  startedAt: Date | undefined,
  taskData: StepTaskData | undefined,
  now: Date,
): ApprovalTimeout | undefined {
  if (
    !startedAt ||
    !taskData ||
    taskData.type !== "manual_approval" ||
    !taskData.timeout
  ) {
    return undefined;
  }

  const elapsedSeconds = (now.getTime() - startedAt.getTime()) / 1000;
  return {
    expired: elapsedSeconds > taskData.timeout,
    elapsedSeconds,
    timeoutSeconds: taskData.timeout,
  };
}
