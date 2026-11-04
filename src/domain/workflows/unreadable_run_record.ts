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

import { markErrorPaths, UserError } from "../errors.ts";

export class UnreadableRunRecordError extends UserError {
  constructor(
    readonly runId: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `The record of workflow run ${runId} at ${path} cannot be read: ${reason}. If it is cut short, its owner is gone and it had not finished, 'swamp run doctor --fix' settles it; otherwise restore or remove the file.`,
      "run_record_unreadable",
    );
    this.name = "UnreadableRunRecordError";
    markErrorPaths(this, [path]);
  }
}

/** a run whose record cannot be parsed, as a repository scan found it */
export interface UnreadableRun {
  readonly workflowId: string;
  readonly runId: string;
  readonly path: string;
  readonly reason: string;
  /**
   * the file looks cut short or is empty; one that looks whole but fails the
   * schema may hold everything a newer swamp wrote, so it is never replaced
   */
  readonly damaged: boolean;
  /** from the run index, when it still has an entry for the run */
  readonly workflowName?: string;
}
