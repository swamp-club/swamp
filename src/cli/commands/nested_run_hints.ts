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
} from "../../libswamp/workflows/nested_runs.ts";
import type { NestedCascadeResult } from "../../libswamp/workflows/nested_cascade.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import type { CommandContext } from "../context.ts";
import { formatCommandTarget } from "../remote_run.ts";

// The commands in these follow-ups go through writeOutput, not the logger:
// LogTape quotes interpolated values and the pretty sink wraps long lines,
// and either breaks a copy-pasted command (swamp-club#2977). JSON mode prints
// none of them, and `--quiet` hides them as it hides the logger's lines.

/** A command that ran through serve, and the `--server` flag it was given. */
export interface ThroughServe {
  server?: string;
}

/**
 * The command that resumes `parent`. Through serve, both runs live on the
 * server this command reached, so its target replaces the `--server <url>`
 * placeholder serve puts in `resumeCommand` (it cannot know the address the
 * client used).
 */
export function parentResumeCommand(
  parent: AwaitingParentData,
  remote?: ThroughServe,
): string {
  return remote
    ? `swamp workflow resume ${
      quoteShellWord(parent.workflowName)
    } --run ${parent.runId}${formatCommandTarget({ server: remote.server })}`
    : parent.resumeCommand;
}

/** The command that cancels `child`, with the same target as above. */
function detachedCancelCommand(
  child: DetachedNestedRunData,
  remote?: ThroughServe,
): string {
  return remote
    ? `swamp workflow cancel ${
      quoteShellWord(child.workflowName)
    } --run ${child.runId}${formatCommandTarget({ server: remote.server })}`
    : child.cancelCommand;
}

/**
 * Warns about each nested run a cancel or reject left unfinished, with the
 * command that cancels it.
 */
export function renderDetachedNestedRuns(
  cliCtx: CommandContext,
  detached: readonly DetachedNestedRunData[],
  remote?: ThroughServe,
): void {
  if (cliCtx.outputMode === "json") return;
  for (const child of detached) {
    cliCtx.logger
      .warn`Nested run ${child.runId} of workflow ${child.workflowName} was left unfinished.`;
    if (cliCtx.verbosity !== "quiet") {
      writeOutput(
        `Cancel nested run ${child.runId} with: ${
          detachedCancelCommand(child, remote)
        }`,
      );
    }
  }
}

/**
 * Reports what became of the nested runs an ended run waited on: the ones
 * cancelled with it, the running ones asked to stop, and the ones left
 * unfinished with the command that cancels each (swamp-club#2867).
 */
export function renderNestedCascade(
  cliCtx: CommandContext,
  nested: Partial<NestedCascadeResult>,
  remote?: ThroughServe,
): void {
  if (cliCtx.outputMode === "json") return;
  for (const child of nested.cancelledNestedRuns ?? []) {
    cliCtx.logger
      .info`Nested run ${child.runId} of workflow ${child.workflowName} was cancelled with it.`;
  }
  for (const child of nested.stopRequestedNestedRuns ?? []) {
    cliCtx.logger
      .info`Nested run ${child.runId} of workflow ${child.workflowName} is running and was asked to stop.`;
  }
  renderDetachedNestedRuns(cliCtx, nested.detachedNestedRuns ?? [], remote);
}

/** Names the parent run still waiting on this run, with its resume command. */
export function renderAwaitingParent(
  cliCtx: CommandContext,
  parent: AwaitingParentData,
  remote?: ThroughServe,
): void {
  if (cliCtx.outputMode === "json" || cliCtx.verbosity === "quiet") return;
  writeOutput(
    `Parent run ${parent.runId} of workflow ${
      escapeControlCharacters(parent.workflowName)
    } waits on this run. Resume it with: ${
      parentResumeCommand(parent, remote)
    }`,
  );
}
