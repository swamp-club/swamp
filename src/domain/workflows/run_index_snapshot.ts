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

import type { WorkflowRunSummary } from "./workflow_run_summary.ts";

export interface RunIndexRun {
  readonly summary: Readonly<WorkflowRunSummary>;
  readonly startMs?: number;
  readonly completedMs?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

function validMs(date: Date | undefined): number | undefined {
  if (!date) return undefined;
  const ms = date.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function deepFreeze<T>(value: T): T {
  if (
    value === null || typeof value !== "object" || value instanceof Date ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function keyOf(run: RunIndexRun): number {
  return run.startMs ?? 0;
}

/**
 * everything is frozen because one snapshot is shared by every reader until its
 * index changes
 */
export class RunIndexSnapshot {
  readonly recordedNames: ReadonlySet<string>;
  readonly distinctStatuses: ReadonlySet<string>;
  readonly newestStartMs: number | undefined;

  readonly #runs: readonly RunIndexRun[];
  readonly #byId: ReadonlyMap<string, RunIndexRun>;
  readonly #startless: number;

  private constructor(runs: RunIndexRun[]) {
    this.#runs = Object.freeze(runs);
    const byId = new Map<string, RunIndexRun>();
    const names = new Set<string>();
    const statuses = new Set<string>();
    let newest: number | undefined;
    let startless = 0;
    for (const run of runs) {
      const id = run.summary.id.toLowerCase();
      if (!byId.has(id)) byId.set(id, run);
      names.add(run.summary.workflowName);
      statuses.add(run.summary.status);
      if (run.startMs === undefined) startless++;
      else if (newest === undefined || run.startMs > newest) {
        newest = run.startMs;
      }
    }
    this.#byId = byId;
    this.#startless = startless;
    this.recordedNames = names;
    this.distinctStatuses = statuses;
    this.newestStartMs = newest;
  }

  static of(summaries: readonly WorkflowRunSummary[]): RunIndexSnapshot {
    const runs = summaries.map((summary): RunIndexRun => {
      const startMs = validMs(summary.startedAt);
      const completedMs = validMs(summary.completedAt);
      return Object.freeze({
        summary: deepFreeze(summary),
        ...(startMs !== undefined
          ? { startMs, startedAt: new Date(startMs).toISOString() }
          : {}),
        ...(completedMs !== undefined
          ? { completedMs, completedAt: new Date(completedMs).toISOString() }
          : {}),
      });
    });
    // Array.prototype.sort is stable, so equal keys keep the given order.
    runs.sort((a, b) => keyOf(b) - keyOf(a));
    return new RunIndexSnapshot(runs);
  }

  get size(): number {
    return this.#runs.length;
  }

  get runs(): readonly RunIndexRun[] {
    return this.#runs;
  }

  between(sinceMs?: number, untilMs?: number): readonly RunIndexRun[] {
    if (sinceMs === undefined && untilMs === undefined) return this.#runs;
    const runs = this.#runs;
    const lo = untilMs === undefined ? 0 : this.#firstBelow(untilMs);
    const hi = sinceMs === undefined ? runs.length : this.#firstBelow(sinceMs);
    if (lo >= hi) return [];
    const window = runs.slice(lo, hi);
    // Runs without a start time sort at key 0, so they fall in the window
    // only when it spans the epoch.
    return this.#startless > 0 && keyOf(runs[hi - 1]) <= 0 &&
        keyOf(runs[lo]) >= 0
      ? window.filter((run) => run.startMs !== undefined)
      : window;
  }

  get(runId: string): RunIndexRun | undefined {
    return this.#byId.get(runId.toLowerCase());
  }

  #firstBelow(ms: number): number {
    let lo = 0;
    let hi = this.#runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keyOf(this.#runs[mid]) >= ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
