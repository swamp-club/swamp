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
 * Which replica path a copy of `commits.db` replicates to (swamp-club#3416,
 * Phase 4 D1). Litestream 0.5 has no generations, and a second writer on one
 * path corrupts the replica, so each writer lineage gets its own path,
 * `<replica root>/_litestream/<fence>/`, named by the fence at which the
 * lineage's replication began.
 *
 * A lineage is one copy's unbroken run of writer leases. Every CLI write
 * command takes a new fence (swamp-club#3359), so keying the path by each
 * command's own fence would give every command a new path and a full
 * snapshot. Instead the lineage continues while the fence just before a
 * command's own was this copy's, so no other writer took the lease in
 * between, and restarts at the command's fence otherwise. The record is
 * written when the lease is taken, so a command that crashed is continued by
 * its successor.
 *
 * Pure rules, no I/O. See "What changes for Phase 4D and 4E" in
 * `design/enablers/datastore-litestream.md`.
 *
 * @module
 */

import { join } from "@std/path/posix";
import { padFence } from "./writer_lease.ts";
import type { ReplicaRoot } from "./replica_root.ts";

/** What a copy of `commits.db` records about its replication lineage. */
export interface ReplicationLineage {
  /** The replica root the lineage replicates under. */
  readonly replicaRoot: string;
  /** The fence at which this lineage's replication began: its path. */
  readonly lineageFence: number;
  /** The last fence this copy took. */
  readonly lastFence: number;
  /**
   * The lineages this copy abandoned, oldest first, each under its own
   * root. Their paths keep their last state until a later garbage
   * collection removes them.
   */
  readonly previousLineages: readonly AbandonedLineage[];
}

/** A lineage a copy restarted away from: its replica path's root and fence. */
export interface AbandonedLineage {
  readonly replicaRoot: string;
  readonly fence: number;
}

/** How a lease taken at a fence relates to the copy's lineage. */
export type LineageDecisionKind = "new" | "continue" | "restart";

/** The outcome of {@link decideLineage}. */
export type LineageDecision =
  | {
    readonly kind: LineageDecisionKind;
    /** The record to keep from now on. */
    readonly lineage: ReplicationLineage;
  }
  | {
    /**
     * The fence went back to one this copy already began a lineage at:
     * restarting there would put a second history on a used replica path.
     */
    readonly kind: "conflict";
    /** The record, unchanged. */
    readonly lineage: ReplicationLineage;
  };

/**
 * Decides the lineage of a lease this copy took at `fence`, replicating
 * under `replicaRoot`.
 *
 * - No record: a new lineage at `fence`.
 * - `fence` equal to the last one: the same hold seen again (another
 *   context in the process, or a retake already recorded); nothing changes.
 * - `fence` one above the last one, under the same root: no other writer
 *   took the lease in between, so the lineage continues.
 * - Anything else (a gap, a lower fence, another root): the lineage restarts
 *   at `fence`, and the old one is kept for garbage collection. A lower
 *   fence means the lease's records were recreated; `lastFence` follows it.
 * - A restart at a fence this copy already began a lineage at, under the
 *   same root, is a conflict: that replica path holds an old history.
 */
export function decideLineage(
  previous: ReplicationLineage | undefined,
  replicaRoot: ReplicaRoot,
  fence: number,
): LineageDecision {
  // Validates the fence: an invalid one never reaches a record.
  padFence(fence);
  if (previous === undefined) {
    return {
      kind: "new",
      lineage: {
        replicaRoot: replicaRoot.value,
        lineageFence: fence,
        lastFence: fence,
        previousLineages: [],
      },
    };
  }
  if (replicaRoot.matches(previous.replicaRoot)) {
    if (fence === previous.lastFence) {
      return { kind: "continue", lineage: previous };
    }
    if (fence === previous.lastFence + 1) {
      return { kind: "continue", lineage: { ...previous, lastFence: fence } };
    }
  }
  const used = (at: number) =>
    (replicaRoot.matches(previous.replicaRoot) &&
      previous.lineageFence === at) ||
    previous.previousLineages.some((old) =>
      replicaRoot.matches(old.replicaRoot) && old.fence === at
    );
  if (used(fence)) {
    return { kind: "conflict", lineage: previous };
  }
  return {
    kind: "restart",
    lineage: {
      replicaRoot: replicaRoot.value,
      lineageFence: fence,
      lastFence: fence,
      previousLineages: [...previous.previousLineages, {
        replicaRoot: previous.replicaRoot,
        fence: previous.lineageFence,
      }],
    },
  };
}

/** The replica path, under `replicaRoot`, of the lineage begun at `lineageFence`. */
export function replicaPathFor(
  replicaRoot: string,
  lineageFence: number,
): string {
  // A replica path is a POSIX-style object key or Unix path on every host.
  return join(replicaRoot, "_litestream", padFence(lineageFence));
}

/**
 * Parses a stored lineage record, or returns undefined when it is not one:
 * an unreadable record restarts the lineage, which costs one snapshot.
 */
export function parseReplicationLineage(
  value: unknown,
): ReplicationLineage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const abandoned = record.previousLineages;
  if (
    typeof record.replicaRoot !== "string" ||
    !isFence(record.lineageFence) || !isFence(record.lastFence) ||
    !Array.isArray(abandoned) || !abandoned.every(isAbandonedLineage)
  ) {
    return undefined;
  }
  return {
    replicaRoot: record.replicaRoot,
    lineageFence: record.lineageFence,
    lastFence: record.lastFence,
    previousLineages: abandoned,
  };
}

function isAbandonedLineage(value: unknown): value is AbandonedLineage {
  if (typeof value !== "object" || value === null) return false;
  const old = value as Record<string, unknown>;
  return typeof old.replicaRoot === "string" && isFence(old.fence);
}

function isFence(value: unknown): value is number {
  if (typeof value !== "number") return false;
  try {
    padFence(value);
    return true;
  } catch {
    return false;
  }
}
