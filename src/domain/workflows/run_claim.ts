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
 * Claims on workflow run records.
 *
 * A command that decides something about a run loads the record, changes it
 * and saves the whole record back. Two such commands on one run at once
 * would each save over the other, and the one that saved first would have
 * reported a result that no longer holds (swamp-club#2919). Holding the
 * run's claim across the load, the decision and the save makes the second
 * command see what the first one saved.
 */
export interface WorkflowRunClaims {
  /**
   * Runs `fn` while the caller is the only claimed writer of the run, and
   * releases the claim however `fn` settles. `fn` must load the run itself:
   * a copy read before the claim was taken may already be out of date.
   */
  withClaim<T>(runId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Claims that exclude nobody. For a caller that already keeps other writers
 * off the run some other way, such as serve's run reservation, and for tests.
 */
export const unclaimedRuns: WorkflowRunClaims = {
  withClaim: (_runId, fn) => fn(),
};
