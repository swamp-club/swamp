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
 * serve moves its lease once per broken lineage; a failed replacement is
 * retried at the same fence, so an outage over several probes moves the lease
 * at most once
 */

export type BrokenLineageMove = "advance" | "replace" | "none";

export class BrokenLineageMoveGuard {
  #advancedFor: number | undefined;
  #retryOwed = false;

  decide(lineageFence: number): BrokenLineageMove {
    if (this.#advancedFor !== lineageFence) return "advance";
    return this.#retryOwed ? "replace" : "none";
  }

  advanced(lineageFence: number): void {
    this.#advancedFor = lineageFence;
    this.#retryOwed = false;
  }

  replacementFailed(): void {
    if (this.#advancedFor !== undefined) this.#retryOwed = true;
  }

  replacementSucceeded(): void {
    this.#retryOwed = false;
  }
}
