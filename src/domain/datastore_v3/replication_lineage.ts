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
 * a second writer on one replica path corrupts it, so each lineage gets its own
 * path named by its starting fence; it continues while the prior fence was this
 * copy's and restarts otherwise
 */

import { join } from "@std/path/posix";
import { padFence } from "./writer_lease.ts";
import type { ReplicaRoot } from "./replica_root.ts";

export interface ReplicationLineage {
  readonly replicaRoot: string;
  readonly lineageFence: number;
  readonly lastFence: number;
  readonly previousLineages: readonly AbandonedLineage[];
}

export interface AbandonedLineage {
  readonly replicaRoot: string;
  readonly fence: number;
}

export type LineageDecisionKind = "new" | "continue" | "restart";

export type LineageDecision =
  | {
    readonly kind: LineageDecisionKind;
    readonly lineage: ReplicationLineage;
  }
  | {
    /**
     * The fence went back to one this copy already began a lineage at:
     * restarting there would put a second history on a used replica path.
     */
    readonly kind: "conflict";
    readonly lineage: ReplicationLineage;
  };

/**
 * a gap, lower fence or other root restarts the lineage and keeps the old one
 * for gc; a restart at a fence already used under the same root is a conflict,
 * as that path holds an old history
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
