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
   * a failed progress checkpoint is logged and the run goes on; rejects only
   * with StepStartUnrecordedError, when a start could not commit
   */
  checkpoint(run: WorkflowRun): Promise<void>;
  committedLatest?(runId: string): boolean;
  /**
   * true when a step's start commits remotely, so the step's lock request is
   * worth sending while it does; otherwise the start is saved first
   */
  overlapsStarts?(): boolean;
}

export const NO_RUN_CHECKPOINTS: RunCheckpointer = {
  checkpoint: () => Promise.resolve(),
};
