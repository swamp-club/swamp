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
 * When serve moves its writer lease away from a replication lineage found
 * broken (swamp-club#3935), and when it only retries the replacement the
 * move set off.
 *
 * Serve moves its lease to a new fence once per broken lineage: the
 * replacement the move sets off starts a new lineage at that fence. A
 * replacement that fails leaves the lineage where it was, and before
 * swamp-club#4096 that re-armed the move, so an outage lasting several
 * probes moved the lease (and fenced serve's in-flight commits) once per
 * probe. The fence a move took has never started a lineage, so it is
 * enough to restart one: a failed replacement is retried at that fence and
 * the lease moves at most once until a replacement succeeds.
 *
 * Pure rules, no I/O.
 *
 * @module
 */

/** What serve's probe does about a lineage its sidecar found broken. */
export type BrokenLineageMove = "advance" | "replace" | "none";

/**
 * Tracks serve's moves away from broken lineages, for one datastore.
 */
export class BrokenLineageMoveGuard {
  // The broken lineage serve last moved its lease away from.
  #advancedFor: number | undefined;
  // A replacement failed since that move, so the probe retries it.
  #retryOwed = false;

  /** What to do about lineage `lineageFence`, found broken. */
  decide(lineageFence: number): BrokenLineageMove {
    if (this.#advancedFor !== lineageFence) return "advance";
    return this.#retryOwed ? "replace" : "none";
  }

  /** The lease moved away from broken lineage `lineageFence`. */
  advanced(lineageFence: number): void {
    this.#advancedFor = lineageFence;
    this.#retryOwed = false;
  }

  /** A replacement failed: the next probe retries it, without a move. */
  replacementFailed(): void {
    if (this.#advancedFor !== undefined) this.#retryOwed = true;
  }

  /** A replacement succeeded and holds a sidecar again. */
  replacementSucceeded(): void {
    this.#retryOwed = false;
  }
}
