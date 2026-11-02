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
 * a pure scheduling layer: execution and overlap prevention are the caller's
 * responsibility via onFire
 */

import { Cron } from "croner";
import { runDetached } from "../../infrastructure/tracing/mod.ts";
import type { WorkflowId } from "./workflow_id.ts";

/**
 * receives the canonical cron-matched fire time, not wall-clock time, so
 * callers can derive a deterministic key for cross-instance dedup
 */
export type ScheduleFireCallback = (
  workflowId: WorkflowId,
  fireTime: Date,
) => void | Promise<void>;

export interface ScheduleEntry {
  readonly workflowId: WorkflowId;
  readonly cronExpression: string;
  readonly nextRun: Date | null;
}

export class WorkflowScheduler {
  private readonly entries = new Map<WorkflowId, Cron>();
  private onFire: ScheduleFireCallback | null = null;

  register(workflowId: WorkflowId, cronExpression: string): void {
    this.unregister(workflowId);

    // croner arms the timer here and every fire re-arms from it, so arm it
    // detached: a fire is its own unit of work, never part of the registering
    // trace
    const cron = runDetached(() =>
      new Cron(
        cronExpression,
        { paused: this.onFire === null },
        () => {
          const entry = this.entries.get(workflowId);
          if (!entry) return;
          const result = this.onFire?.(workflowId, canonicalFireTime(entry));
          if (result instanceof Promise) {
            result.catch(() => {});
          }
        },
      )
    );

    this.entries.set(workflowId, cron);
  }

  unregister(workflowId: WorkflowId): void {
    const existing = this.entries.get(workflowId);
    if (existing) {
      existing.stop();
      this.entries.delete(workflowId);
    }
  }

  start(onFire: ScheduleFireCallback): void {
    this.onFire = onFire;
    for (const cron of this.entries.values()) {
      cron.resume();
    }
  }

  stop(): void {
    for (const cron of this.entries.values()) {
      cron.stop();
    }
    this.entries.clear();
    this.onFire = null;
  }

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

  get size(): number {
    return this.entries.size;
  }
}

/**
 * croner's currentRun() is wall-clock, so skewed instances could both claim a
 * fire slot; pick the latest pattern match at or before now, snapping forward
 * if the timer fired early
 */
export function canonicalFireTime(cron: Cron, now?: Date): Date {
  const ref = now ?? new Date();
  const lookback = new Date(ref.getTime() - 120_000);
  const runs = cron.nextRuns(200, lookback);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].getTime() <= ref.getTime()) {
      return runs[i];
    }
  }
  // Timer fired slightly before the scheduled second — snap forward
  // to the imminent match if it's within 2 seconds.
  const EARLY_TOLERANCE_MS = 2_000;
  for (const run of runs) {
    if (run.getTime() - ref.getTime() <= EARLY_TOLERANCE_MS) {
      return run;
    }
  }
  return ref;
}

export function effectiveSchedule(
  builtInSchedule: string | null,
  overrideSchedule: string | undefined,
): string | null {
  return overrideSchedule ?? builtInSchedule;
}

export function nextFireTime(cronExpression: string, from: Date): Date | null {
  try {
    return new Cron(cronExpression).nextRun(from);
  } catch {
    return null;
  }
}
