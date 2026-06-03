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

/**
 * WorkflowScheduler is a domain service that manages cron-based schedule
 * registrations for workflows. It is a pure scheduling layer — all I/O
 * decisions (execution, overlap prevention) are the caller's responsibility
 * via the onFire callback.
 */

import { Cron } from "croner";
import type { WorkflowId } from "./workflow_id.ts";

/**
 * Callback invoked when a scheduled workflow should fire.
 */
export type ScheduleFireCallback = (workflowId: WorkflowId) => void;

/**
 * Information about a registered schedule.
 */
export interface ScheduleEntry {
  readonly workflowId: WorkflowId;
  readonly cronExpression: string;
  readonly nextRun: Date | null;
}

export class WorkflowScheduler {
  private readonly entries = new Map<WorkflowId, Cron>();
  private onFire: ScheduleFireCallback | null = null;

  /**
   * Registers a workflow schedule. If the workflow already has a schedule,
   * it is replaced with the new cron expression.
   */
  register(workflowId: WorkflowId, cronExpression: string): void {
    this.unregister(workflowId);

    const cron = new Cron(
      cronExpression,
      { paused: this.onFire === null },
      () => this.onFire?.(workflowId),
    );

    this.entries.set(workflowId, cron);
  }

  /**
   * Unregisters a workflow schedule. No-op if the workflow has no schedule.
   */
  unregister(workflowId: WorkflowId): void {
    const existing = this.entries.get(workflowId);
    if (existing) {
      existing.stop();
      this.entries.delete(workflowId);
    }
  }

  /**
   * Starts the scheduler. Resumes all registered cron jobs and sets the
   * fire callback. The callback is invoked each time a cron expression matches.
   */
  start(onFire: ScheduleFireCallback): void {
    this.onFire = onFire;
    for (const cron of this.entries.values()) {
      cron.resume();
    }
  }

  /**
   * Stops the scheduler. Pauses all cron jobs but does not unregister them.
   */
  stop(): void {
    for (const cron of this.entries.values()) {
      cron.stop();
    }
    this.entries.clear();
    this.onFire = null;
  }

  /**
   * Returns all currently registered schedules.
   */
  listSchedules(): ScheduleEntry[] {
    const result: ScheduleEntry[] = [];
    for (const [workflowId, cron] of this.entries) {
      result.push({
        workflowId,
        cronExpression: cron.getPattern()!,
        nextRun: cron.nextRun(),
      });
    }
    return result;
  }

  /**
   * Returns the number of registered schedules.
   */
  get size(): number {
    return this.entries.size;
  }
}
