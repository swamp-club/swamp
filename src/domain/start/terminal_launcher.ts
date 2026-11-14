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

import type { HarnessLaunchSpec } from "./harness.ts";
import type { LaunchMethod } from "./start_session.ts";

/** how a terminal came to be tried */
export type TerminalChoice = "set" | "running_here" | "open" | "default";

export type TerminalAttemptResult = "not_found" | "failed" | "couldnt_start";

export interface TerminalAttempt {
  readonly terminal: string;
  readonly chosen: TerminalChoice;
  readonly result: TerminalAttemptResult;
}

/** why no terminal could be tried, or why the ones tried could not work */
export type NoTerminalReason =
  | "container"
  | "no_display"
  | "ssh"
  | "remote_browser";

export interface LaunchOutcome {
  readonly method: LaunchMethod;
  readonly opened: boolean;
  readonly command: string;
  /** set only when no window opened */
  readonly tried?: readonly TerminalAttempt[];
  readonly reason?: NoTerminalReason;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  /** the executable's file name */
  readonly name: string;
}

/** the current user's processes; empty when they cannot be read */
export interface ProcessLister {
  list(): Promise<ProcessInfo[]>;
}

const RESULT_TEXT: Record<TerminalAttemptResult, string> = {
  not_found: "not found",
  failed: "exited with an error",
  couldnt_start: "couldn't start",
};

const REASON_TEXT: Record<NoTerminalReason, string> = {
  container:
    "swamp start is running inside a container (toolbox or distrobox), so your desktop's terminals aren't available to it.",
  no_display: "No graphical display was found to open a terminal on.",
  ssh:
    "swamp start is running over SSH, so a window would open where you can't see it.",
  remote_browser:
    "The page is open on another machine, so a window would open where you can't see it.",
};

export function failedLaunchDetail(
  outcome: Pick<LaunchOutcome, "tried" | "reason">,
): string {
  const parts: string[] = [];
  const tried = outcome.tried ?? [];
  if (tried.length > 0) {
    parts.push(
      `Tried: ${
        tried.map((t) =>
          `${t.terminal} (${
            t.chosen === "open" || t.chosen === "running_here" ? "open, " : ""
          }${RESULT_TEXT[t.result]})`
        ).join(", ")
      }.`,
    );
  } else {
    parts.push("No terminal was tried.");
  }
  if (outcome.reason !== undefined) {
    parts.push(REASON_TEXT[outcome.reason]);
  } else if (tried.some((t) => t.result === "not_found")) {
    parts.push("Set TERMINAL to your terminal, or copy the command.");
  }
  return parts.join(" ");
}

/**
 * implementations never throw for "no window possible": they return the
 * copy_command outcome
 */
export interface TerminalLauncher {
  open(spec: HarnessLaunchSpec, workspacePath: string): Promise<LaunchOutcome>;
}
