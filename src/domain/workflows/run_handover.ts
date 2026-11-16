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

import type { RunParker, WorkflowRun } from "./workflow_run.ts";

/**
 * a planned restart: once the signal fires a run starts no new work, lets the
 * steps in flight finish, and parks at the next step boundary
 */
export interface RunHandover {
  readonly signal: AbortSignal;
  /** read as the run parks, so the parker names the stream's last event */
  parker(runId: string): RunParker;
  /** told once the parked record is saved; never throws */
  parked?(run: Pick<WorkflowRun, "id" | "workflowId">): Promise<void>;
}

export function handedOver(handover: RunHandover | undefined): boolean {
  return handover?.signal.aborted ?? false;
}

/** work left for the continuation: a job the walk never finished */
export function hasUnfinishedWork(run: Pick<WorkflowRun, "jobs">): boolean {
  return run.jobs.some((job) =>
    job.status === "pending" || job.status === "running"
  );
}

/**
 * a step a planned restart took back before any worker took it: it never
 * started, so it goes back to pending for the run's continuation
 */
export class StepWithdrawnError extends Error {
  constructor() {
    super("Withdrawn by a planned restart before a worker took the step");
    this.name = "StepWithdrawnError";
  }
}
