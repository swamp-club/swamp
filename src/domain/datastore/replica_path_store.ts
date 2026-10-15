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
 * The Litestream lineage paths on a datastore's bucket replica
 * (swamp-club#3531), as its provider's `replicaPaths()` exposes them. See
 * "Phase 4: replica paths" in `design/enablers/datastore-litestream.md`.
 *
 * `packages/testing/replica_path_conformance.ts` checks fences with the
 * same rule; `replica_path_store_test.ts` runs both over one fixture list.
 *
 * @module
 */

/** Digits a writer fence is padded to in keys and replica paths. */
export const FENCE_DIGITS = 12;

/** The largest fence a padded key can carry. */
export const MAX_FENCE = 10 ** FENCE_DIGITS - 1;

/**
 * The lineage paths of a datastore's Litestream replica: the fence
 * directories under `<prefix>/_litestream/`, where `<prefix>` is the
 * replica target's. A fence is always the 12-digit padded form core writes
 * (`000000000042`). Nothing outside `<prefix>/_litestream/<fence>/` is ever
 * listed or touched.
 */
export interface ReplicaPathStore {
  /**
   * The fence directories present under `<prefix>/_litestream/`, without
   * their trailing slash, in any order. A directory whose name is not a
   * fence may be returned; swamp ignores it.
   */
  list(signal: AbortSignal): Promise<string[]>;

  /**
   * Deletes every object under `<prefix>/_litestream/<fence>/`, paging
   * through listings, and resolves once none is left. Resolves when nothing
   * is there. Throws, deleting nothing, when `fence` is not the 12-digit
   * padded form ({@link replicaPathFenceProblem}).
   */
  removePath(fence: string, signal: AbortSignal): Promise<void>;
}

/**
 * Why `value` is not a padded fence, or undefined when it is one: exactly
 * {@link FENCE_DIGITS} ASCII digits, from 1 to {@link MAX_FENCE}. The
 * reason never repeats the value.
 */
export function replicaPathFenceProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "a fence must be a string";
  if (value.length !== FENCE_DIGITS || !/^[0-9]+$/.test(value)) {
    return `a fence must be exactly ${FENCE_DIGITS} digits`;
  }
  if (Number(value) < 1) return "a fence must be from 1";
  return undefined;
}

/**
 * The fence a replica path directory names, or undefined when the name is
 * not a padded fence.
 */
export function parseReplicaPathFence(name: string): number | undefined {
  return replicaPathFenceProblem(name) === undefined ? Number(name) : undefined;
}
