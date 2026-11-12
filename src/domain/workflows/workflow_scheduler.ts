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
import { nextSlotAfter } from "./cron_slots.ts";
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

/** the clock and timers a scheduler arms with; real ones unless a test injects */
export interface SchedulerClock {
  now(): number;
  /** runs `fn` after `ms`; the returned function cancels it */
  setTimer(fn: () => void, ms: number): () => void;
}

export interface WorkflowSchedulerOptions {
  /** the zone patterns are matched in; the host zone when absent */
  readonly timezone?: string;
  readonly clock?: SchedulerClock;
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

// re-reads the wall clock at least this often, as croner does, and keeps a
// distant slot under the setTimeout limit
const MAX_TIMER_MS = 30_000;

interface Entry {
  readonly cron: Cron;
  cancel?: () => void;
}

export class WorkflowScheduler {
  private readonly entries = new Map<WorkflowId, Entry>();
  private onFire: ScheduleFireCallback | null = null;
  private readonly timezone: string | undefined;
  private readonly clock: SchedulerClock;

  constructor(options: WorkflowSchedulerOptions = {}) {
    this.timezone = options.timezone;
    this.clock = options.clock ?? systemClock;
  }

  register(workflowId: WorkflowId, cronExpression: string): void {
    this.unregister(workflowId);

    // croner only matches patterns: its own timer re-arms from nextRun, which
    // lands before now inside a DST fall-back hour and fires in a loop
    const entry: Entry = {
      cron: new Cron(
        cronExpression,
        this.timezone ? { timezone: this.timezone } : undefined,
      ),
    };
    this.entries.set(workflowId, entry);
    if (this.onFire) this.armDetached(workflowId, entry);
  }

  unregister(workflowId: WorkflowId): void {
    const existing = this.entries.get(workflowId);
    if (existing) {
      this.disarm(existing);
      this.entries.delete(workflowId);
    }
  }

  start(onFire: ScheduleFireCallback): void {
    this.onFire = onFire;
    for (const [workflowId, entry] of this.entries) {
      this.armDetached(workflowId, entry);
    }
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      this.disarm(entry);
    }
    this.entries.clear();
    this.onFire = null;
  }

  listSchedules(): ScheduleEntry[] {
    const now = new Date(this.clock.now());
    const result: ScheduleEntry[] = [];
    for (const [workflowId, entry] of this.entries) {
      result.push({
        workflowId,
        cronExpression: entry.cron.getPattern()!,
        nextRun: nextSlotAfter(entry.cron, now),
      });
    }
    return result;
  }

  get size(): number {
    return this.entries.size;
  }

  // a fire is its own unit of work, never part of the registering trace
  private armDetached(workflowId: WorkflowId, entry: Entry): void {
    runDetached(() => this.arm(workflowId, entry, new Date(this.clock.now())));
  }

  private arm(workflowId: WorkflowId, entry: Entry, from: Date): void {
    this.disarm(entry);
    const slot = nextSlotAfter(entry.cron, from);
    if (slot) this.wait(workflowId, entry, slot);
  }

  private wait(workflowId: WorkflowId, entry: Entry, slot: Date): void {
    const delay = Math.min(
      Math.max(slot.getTime() - this.clock.now(), 0),
      MAX_TIMER_MS,
    );
    entry.cancel = this.clock.setTimer(
      () => this.wake(workflowId, entry, slot),
      delay,
    );
  }

  private wake(workflowId: WorkflowId, entry: Entry, slot: Date): void {
    entry.cancel = undefined;
    if (this.entries.get(workflowId) !== entry || !this.onFire) return;
    const now = new Date(this.clock.now());
    if (now.getTime() < slot.getTime()) {
      this.wait(workflowId, entry, slot);
      return;
    }
    // armed before the callback, which may unregister or replace this entry
    this.arm(workflowId, entry, now);
    try {
      const result = this.onFire(
        workflowId,
        canonicalFireTime(entry.cron, now),
      );
      if (result instanceof Promise) {
        result.catch(() => {});
      }
    } catch {
      // a failing callback must not stop the schedule or escape the timer
    }
  }

  private disarm(entry: Entry): void {
    entry.cancel?.();
    entry.cancel = undefined;
  }
}

/**
 * croner's currentRun() is wall-clock, so skewed instances could both claim a
 * fire slot; pick the latest pattern match at or before now, snapping forward
 * if the timer fired early
 */
export function canonicalFireTime(cron: Cron, now?: Date): Date {
  const ref = now ?? new Date();
  const runs: Date[] = [];
  let cursor = new Date(ref.getTime() - 120_000);
  while (runs.length < 200) {
    const next = nextSlotAfter(cron, cursor);
    if (!next) break;
    runs.push(next);
    if (next.getTime() > ref.getTime()) break;
    cursor = next;
  }
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
    return nextSlotAfter(new Cron(cronExpression), from);
  } catch {
    return null;
  }
}
