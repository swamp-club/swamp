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

export interface ApprovalTimeout {
  expired: boolean;
  elapsedSeconds: number;
  timeoutSeconds: number;
}

export interface GateStepRun {
  readonly stepName: string;
  readonly approvalTimeout?: number;
  readonly forEachTemplate?: string;
}

/**
 * the step run's own timeout wins, so a waiting gate's deadline does not move
 * when the workflow is edited; an older record falls back to the definition
 * step, or the step a forEach expanded from
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
 * single source of truth for the deadline check, shared by workflow approve and
 * approvals so both apply the same now > suspendedAt + timeout rule
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
