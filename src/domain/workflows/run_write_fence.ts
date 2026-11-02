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
 * a closed fence stops a late executor saving its stale record over the
 * interrupt; its commits are withdrawn only once the run is taken over, since a
 * run the owner closed but left alone must still commit its final record
 */

export interface RunWriteFence {
  isClosed(runId: string): boolean;
  isTakenOver(runId: string): boolean;
  /**
   * called with a save that passed isClosed in the same tick, so the owner
   * closing the fence can wait for it to land before writing the record itself
   */
  track(runId: string, write: Promise<void>): Promise<void>;
}

export const OPEN_RUN_WRITE_FENCE: RunWriteFence = {
  isClosed: () => false,
  isTakenOver: () => false,
  track: (_runId, write) => write,
};
