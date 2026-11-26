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
  CONFIG_PARTITION_RANGE,
  DEFINITION_PARTITION_RANGE,
  PartitionKey,
} from "../../domain/datastore_v3/partition_key.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";
import type { SqliteReadModel } from "./sqlite_read_model.ts";

// past either bound a scoped command drains a slice at its end, which keeps
// commits.db, and what follow compaction waits on, from growing without end
export const SCOPED_BACKLOG_MAX = 2_000;

export const SCOPED_BACKLOG_AGE_MS = 2 * 60 * 1000;

// small, so a slice of other members' writes costs well under a second
export const SCOPED_DRAIN_SLICE = 25;

// a long command's reads, and other processes', lag by at most this much
export const SCOPED_FEED_APPLY_MS = 30_000;

const logger = getSwampLogger(["datastore", "v3", "scoped"]);

export const SCOPED_BACKLOG_MAX_ENV_VAR = "SWAMP_V3_SCOPED_BACKLOG_MAX";

/** an env value that is not a positive integer is ignored */
export function resolveScopedBacklogMax(): number {
  const envValue = Deno.env.get(SCOPED_BACKLOG_MAX_ENV_VAR);
  if (envValue) {
    const parsed = Number(envValue.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return SCOPED_BACKLOG_MAX;
}

/** config (the lockfile among them) and auto-definitions: every command reads them */
export const ALWAYS_APPLIED_RANGES = [
  CONFIG_PARTITION_RANGE,
  DEFINITION_PARTITION_RANGE,
] as const;

const EVERY_PARTITION = [{ from: "", to: "\u{10ffff}" }] as const;

export interface ScopedApplyTarget {
  readonly namespace: string;
  readonly commitStore: Pick<
    SqliteCommitStore,
    | "partitionHeadsSince"
    | "firstChangeAtSince"
    | "headSeq"
    | "countChangesSince"
    | "compactionPoint"
  >;
  readonly readModel: Pick<
    SqliteReadModel,
    | "cursor"
    | "isComplete"
    | "appliedSeq"
    | "settledAppliedSeq"
    | "catchUpPartition"
  >;
}

export async function backlogPastBound(
  target: ScopedApplyTarget,
  now: number = Date.now(),
  ageMs: number = SCOPED_BACKLOG_AGE_MS,
): Promise<boolean> {
  const cursor = target.readModel.cursor();
  if (cursor < await target.commitStore.compactionPoint()) return true;
  const max = resolveScopedBacklogMax();
  if (await target.commitStore.countChangesSince(cursor, max + 1) > max) {
    return true;
  }
  const at = target.commitStore.firstChangeAtSince(cursor);
  if (at === undefined) return false;
  const made = Date.parse(at);
  return !Number.isFinite(made) || now - made > ageMs;
}

function pendingIn(
  target: ScopedApplyTarget,
  ranges: readonly { readonly from: string; readonly to: string }[],
): PartitionKey[] {
  const heads = target.commitStore.partitionHeadsSince(
    target.namespace,
    target.readModel.cursor(),
    ranges,
  );
  const pending: PartitionKey[] = [];
  for (const { partition, seq } of heads) {
    const key = PartitionKey.parse(partition);
    if (seq > target.readModel.appliedSeq(target.namespace, key)) {
      pending.push(key);
    }
  }
  return pending;
}

export function pendingAlwaysApplied(
  target: ScopedApplyTarget,
): PartitionKey[] {
  return pendingIn(target, ALWAYS_APPLIED_RANGES);
}

export function pendingPartitions(target: ScopedApplyTarget): PartitionKey[] {
  return pendingIn(target, EVERY_PARTITION);
}

export async function pendingCommitsIn(
  target: ScopedApplyTarget,
  partitions: readonly PartitionKey[],
): Promise<number> {
  let pending = 0;
  for (const partition of partitions) {
    const head = target.commitStore.headSeq(target.namespace, partition);
    const applied = await target.readModel.settledAppliedSeq(
      target.namespace,
      partition,
    );
    pending += Math.max(0, head - applied);
  }
  return pending;
}

export function partitionPending(
  target: ScopedApplyTarget,
  partition: PartitionKey,
): boolean {
  return target.commitStore.headSeq(target.namespace, partition) >
    target.readModel.appliedSeq(target.namespace, partition);
}

// the cursor stays where it is
export async function applyPartitions(
  target: ScopedApplyTarget,
  partitions: readonly PartitionKey[],
  signal: AbortSignal,
): Promise<void> {
  const seen = new Set<string>();
  for (const partition of partitions) {
    const key = partition.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const head = target.commitStore.headSeq(target.namespace, partition);
    const applied = await target.readModel.settledAppliedSeq(
      target.namespace,
      partition,
    );
    if (head <= applied) continue;
    await target.readModel.catchUpPartition(
      target.namespace,
      partition,
      signal,
    );
  }
}

export interface PeriodicApply {
  stop(): Promise<void>;
}

/** a stopped apply is waited for this long, as a stopped feed watch's catch-up is */
const STOP_WAIT_MS = 500;

export const PERIODIC_FAILURES_WARNED = 3;

// stopping aborts the apply running; exit waits on it for at most STOP_WAIT_MS
export function startPeriodicApply(options: {
  readonly intervalMs: number;
  readonly apply: (signal: AbortSignal) => Promise<unknown>;
  /** awaited before each apply: the lock's catch-up a writer hold left to it */
  readonly ready?: (signal: AbortSignal) => Promise<void>;
  readonly stopWaitMs?: number;
}): PeriodicApply {
  const stopping = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let failures = 0;
  const schedule = () => {
    if (stopping.signal.aborted) return;
    timer = setTimeout(tick, options.intervalMs);
    Deno.unrefTimer(timer);
  };
  const tick = () => {
    timer = undefined;
    running = (async () => {
      await options.ready?.(stopping.signal);
      stopping.signal.throwIfAborted();
      await options.apply(stopping.signal);
      failures = 0;
    })().catch((error) => {
      if (stopping.signal.aborted) return;
      failures++;
      if (failures === PERIODIC_FAILURES_WARNED) {
        logger
          .warn`A long command's catch-up from serve failed ${failures} times in a row, so what it reads of other behaviors may lag: ${error}`;
      } else {
        logger.debug`A scoped command's periodic catch-up failed: ${error}`;
      }
    }).finally(() => {
      running = undefined;
      schedule();
    });
  };
  schedule();
  return {
    async stop() {
      stopping.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (running === undefined) return;
      let bound: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            bound = setTimeout(resolve, options.stopWaitMs ?? STOP_WAIT_MS);
          }),
        ]);
      } finally {
        clearTimeout(bound);
      }
    },
  };
}
