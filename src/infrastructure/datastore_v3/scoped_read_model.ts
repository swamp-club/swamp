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

import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";
import type { SqliteReadModel } from "./sqlite_read_model.ts";

/**
 * a scoped command's open applies the whole feed past this many unapplied
 * commits: one tail-netted page (under TAIL_NET_MAX_COMMITS) bounds what
 * commits.db keeps and what follow compaction waits on
 */
export const SCOPED_BACKLOG_MAX = 2_000;

/** or once the oldest unapplied commit is this old, however few there are */
export const SCOPED_BACKLOG_AGE_MS = 60 * 60 * 1000;

/**
 * a scoped command applies the whole feed this often while it runs, so a long
 * command's reads and other processes' lag by at most this much
 */
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
  { from: "config--", to: "config-." },
  { from: "definition--", to: "definition-." },
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

/** whether the read model lags its copy past the bound a scoped open allows */
export async function backlogPastBound(
  target: ScopedApplyTarget,
  now: number = Date.now(),
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
  return !Number.isFinite(made) || now - made > SCOPED_BACKLOG_AGE_MS;
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

/** config, lockfile and auto-definition partitions with commits not applied */
export function pendingAlwaysApplied(
  target: ScopedApplyTarget,
): PartitionKey[] {
  return pendingIn(target, ALWAYS_APPLIED_RANGES);
}

/** every partition with commits past the cursor not applied */
export function pendingPartitions(target: ScopedApplyTarget): PartitionKey[] {
  return pendingIn(target, EVERY_PARTITION);
}

/** commits of these partitions the copy holds and the read model has not applied */
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

/** whether the copy holds a commit of the partition the read model has not applied */
export function partitionPending(
  target: ScopedApplyTarget,
  partition: PartitionKey,
): boolean {
  return target.commitStore.headSeq(target.namespace, partition) >
    target.readModel.appliedSeq(target.namespace, partition);
}

/** applies each partition holding unapplied commits; the cursor stays where it is */
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

/**
 * runs `apply` every `intervalMs` after the last one settled, the first a whole
 * interval in; stopping aborts the one running, so a command's exit never
 * waits on it
 */
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
    })().catch((error) => {
      logger.debug`A scoped command's periodic catch-up failed: ${error}`;
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
