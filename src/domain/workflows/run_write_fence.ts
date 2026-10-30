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
 * The handoff by which another owner takes a run's record over from the
 * executor still running it (swamp-club#4101). Serve's shutdown marks the
 * runs its drain aborted `interrupted`, but an executor that outlived the
 * abort grace (its remote step answered after the abort, and it went on)
 * still holds a `running` copy of the run and saves it over the interrupt.
 * Once the fence is closed for a run, the executor saves its record no more.
 *
 * @module
 */

/** Whether a run's executor may still save its record. */
export interface RunWriteFence {
  /** True once another owner has taken the run's record over. */
  isClosed(runId: string): boolean;
  /**
   * Called with a save of the run's record that passed {@link isClosed}, in
   * the same tick, so the owner closing the fence can wait for it to land
   * before writing the record itself. Returns `write`.
   */
  track(runId: string, write: Promise<void>): Promise<void>;
}

/** Never closes: for callers where no other owner takes a run over. */
export const OPEN_RUN_WRITE_FENCE: RunWriteFence = {
  isClosed: () => false,
  track: (_runId, write) => write,
};
