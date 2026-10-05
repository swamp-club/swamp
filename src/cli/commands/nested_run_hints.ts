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

import type {
  AwaitingParentData,
  DetachedNestedRunData,
} from "../../libswamp/mod.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { CommandContext } from "../context.ts";

// The commands in these follow-ups go through writeOutput, not the logger:
// LogTape quotes interpolated values and the pretty sink wraps long lines,
// and either breaks a copy-pasted command (swamp-club#2977). `--quiet` hides
// them, as it hides the logger's lines around them.

/**
 * Warns about each nested run a cancel or reject left unfinished, with the
 * command that cancels it.
 */
export function renderDetachedNestedRuns(
  cliCtx: CommandContext,
  detached: readonly DetachedNestedRunData[],
): void {
  for (const child of detached) {
    cliCtx.logger
      .warn`Nested run ${child.runId} of workflow ${child.workflowName} was left unfinished.`;
    if (cliCtx.verbosity !== "quiet") {
      writeOutput(`  Cancel it with: ${child.cancelCommand}`);
    }
  }
}

/** Names the parent run still waiting on this run, with its resume command. */
export function renderAwaitingParent(
  cliCtx: CommandContext,
  parent: AwaitingParentData,
): void {
  if (cliCtx.verbosity === "quiet") return;
  writeOutput(
    `Parent run ${parent.runId} of workflow ${parent.workflowName} waits on this run. Resume it with: ${parent.resumeCommand}`,
  );
}
