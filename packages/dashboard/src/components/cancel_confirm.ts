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

/** Where a Cancel button is in its two-step confirm. */
export type CancelStep = "idle" | "confirming" | "cancelling";

/** What moved it: a click on Cancel, Keep or Confirm, or the request ending. */
export type CancelEvent = "ask" | "keep" | "confirm" | "settled";

/**
 * The next step of the confirm. A cancel is sent only from `confirming`, and
 * nothing but the request ending leaves `cancelling`, so a second click
 * never sends a second cancel.
 */
export function nextCancelStep(
  step: CancelStep,
  event: CancelEvent,
): CancelStep {
  if (step === "idle") return event === "ask" ? "confirming" : "idle";
  if (step === "confirming") {
    if (event === "confirm") return "cancelling";
    return event === "keep" ? "idle" : "confirming";
  }
  return event === "settled" ? "idle" : "cancelling";
}

/** A nested run a cancel left suspended, and the command that cancels it. */
export interface NestedRunLeft {
  workflowName: string;
  runId: string;
  cancelCommand: string;
}

/** What a cancel did, for the view to show after the row is gone. */
export interface CancelOutcome {
  message: string;
  /** Nested runs the cancelled run waited on, still suspended. */
  nestedRunsLeft: NestedRunLeft[];
}

/**
 * Describes a `workflow.cancel` reply. A cancelled run that waited on nested
 * runs leaves them suspended, so they are listed with their cancel commands.
 */
export function cancelOutcome(
  workflowName: string,
  reply: unknown,
): CancelOutcome {
  const data = reply && typeof reply === "object"
    ? (reply as { data?: unknown }).data
    : undefined;
  const detached = data && typeof data === "object"
    ? (data as { detachedNestedRuns?: unknown }).detachedNestedRuns
    : undefined;
  const nestedRunsLeft = Array.isArray(detached)
    ? detached.filter((run): run is NestedRunLeft =>
      !!run && typeof run === "object" &&
      typeof (run as NestedRunLeft).workflowName === "string" &&
      typeof (run as NestedRunLeft).runId === "string" &&
      typeof (run as NestedRunLeft).cancelCommand === "string"
    ).map(({ workflowName, runId, cancelCommand }) => ({
      workflowName,
      runId,
      cancelCommand,
    }))
    : [];
  const count = nestedRunsLeft.length;
  return {
    message: count === 0
      ? `${workflowName}: run cancelled`
      : `${workflowName}: run cancelled — ${count} nested ${
        count === 1 ? "run is" : "runs are"
      } still suspended`,
    nestedRunsLeft,
  };
}
