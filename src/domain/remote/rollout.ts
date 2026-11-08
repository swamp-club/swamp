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

import {
  type FanOutMember,
  parsePercent,
  type RolloutBatchSize,
  type RolloutPolicy,
} from "./fan_out.ts";

export interface PlannedRollout {
  readonly batches: readonly (readonly string[])[];
  // null means no budget
  readonly maxFailures: number | null;
}

// failed lanes are also settled, and settled lanes are also started
export interface RolloutProgress {
  readonly started: ReadonlySet<string>;
  readonly settled: ReadonlySet<string>;
  readonly failed: ReadonlySet<string>;
}

export type RolloutDecision =
  | { readonly kind: "start"; readonly batch: number; readonly lanes: string[] }
  | { readonly kind: "wait" }
  | { readonly kind: "halt"; readonly held: string[] }
  | { readonly kind: "complete" };

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function batchSize(size: RolloutBatchSize, lanes: number): number {
  if (typeof size === "number") return size;
  const pct = parsePercent(size);
  if (pct === null) throw new Error(`Invalid batch size '${size}'`);
  // rounds up, so a small percentage of a small fleet is still one lane
  return Math.ceil((pct * lanes) / 100);
}

export function planBatches(
  members: readonly FanOutMember[],
  rollout?: Pick<RolloutPolicy, "batches">,
): string[][] {
  const named = (disposition: FanOutMember["disposition"]) =>
    members.filter((member) => member.disposition === disposition)
      .map((member) => member.worker)
      .sort(byCodeUnit);
  // waiting lanes go last, so the canary is a host that is up
  const lanes = [...named("dispatch"), ...named("waiting")];
  if (lanes.length === 0) return [];
  if (rollout === undefined) return [lanes];
  const batches: string[][] = [];
  let next = 0;
  rollout.batches.forEach((size, index) => {
    if (next >= lanes.length) return;
    const isLast = index === rollout.batches.length - 1;
    const take = isLast
      ? lanes.length - next
      : Math.min(batchSize(size, lanes.length), lanes.length - next);
    if (take > 0) {
      batches.push(lanes.slice(next, next + take));
      next += take;
    }
  });
  return batches;
}

/**
 * a resumed attempt's batches: the lanes the last halt failed run first, then
 * the rest in the frozen plan's batches; lanes not re-run are left out
 */
export function resumeRollout(
  batches: readonly (readonly string[])[],
  rerun: ReadonlySet<string>,
  failedFirst: ReadonlySet<string>,
): string[][] {
  const first = batches.flat().filter((lane) =>
    rerun.has(lane) && failedFirst.has(lane)
  );
  const rest = batches.map((batch) =>
    batch.filter((lane) => rerun.has(lane) && !failedFirst.has(lane))
  ).filter((batch) => batch.length > 0);
  return first.length > 0 ? [first, ...rest] : rest;
}

// the only place the budget is decided; consult it before every lane start, not per batch
export function nextBatch(
  progress: RolloutProgress,
  rollout: PlannedRollout,
): RolloutDecision {
  const notStarted = (lane: string) => !progress.started.has(lane);
  if (
    rollout.maxFailures !== null && progress.failed.size > rollout.maxFailures
  ) {
    return { kind: "halt", held: rollout.batches.flat().filter(notStarted) };
  }
  const current = rollout.batches.findIndex((batch) => batch.some(notStarted));
  if (current === -1) {
    const allSettled = rollout.batches.every((batch) =>
      batch.every((lane) => progress.settled.has(lane))
    );
    return allSettled ? { kind: "complete" } : { kind: "wait" };
  }
  const earlierSettled = rollout.batches.slice(0, current).every((batch) =>
    batch.every((lane) => progress.settled.has(lane))
  );
  if (!earlierSettled) return { kind: "wait" };
  return {
    kind: "start",
    batch: current,
    lanes: rollout.batches[current].filter(notStarted),
  };
}
