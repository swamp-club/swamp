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

import type { WorkflowRun } from "./workflow_run.ts";

export interface RunCheckpointer {
  /**
   * never rejects: a failed checkpoint is logged, the run goes on, and the
   * operation's own commit tries again
   */
  checkpoint(run: WorkflowRun): Promise<void>;
}

export const NO_RUN_CHECKPOINTS: RunCheckpointer = {
  checkpoint: () => Promise.resolve(),
};
