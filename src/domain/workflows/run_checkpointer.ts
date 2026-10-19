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
 * Commits a workflow run's progress while it runs (swamp-club#3587). A
 * datastore that commits a run's writes only when its operation ends (v3)
 * would otherwise lose a crashed run and its completed steps' data to the
 * next command's interrupted-writer recovery; with a checkpoint as the run
 * saves, recovery keeps the run at its last checkpoint for `workflow
 * recover`, `run doctor --fix` and serve's reaper to settle, as v2 does.
 *
 * @module
 */

import type { WorkflowRun } from "./workflow_run.ts";

/** Commits what a run has saved so far. */
export interface RunCheckpointer {
  /**
   * Called after each save of `run`: commits the writes made so far in the
   * operation it runs in, its latest save included, now or soon after (an
   * implementation may pace its commits). Never rejects: a checkpoint that
   * fails is logged and the run goes on, and its operation's own commit
   * tries again.
   */
  checkpoint(run: WorkflowRun): Promise<void>;
}

/** Takes no checkpoints: for datastores whose writes land as they are made. */
export const NO_RUN_CHECKPOINTS: RunCheckpointer = {
  checkpoint: () => Promise.resolve(),
};
