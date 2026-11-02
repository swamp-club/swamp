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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["process", "group"]);

/**
 * auto isolates only without a controlling terminal, so interactive runs keep
 * prompts and Ctrl-C to the tree; always is for remotely triggered runs (serve
 * action, worker exec-dispatch) where nobody answers prompts
 */
export type ProcessGroupIsolation = "auto" | "always";

let isolation: ProcessGroupIsolation = "auto";
let controllingTerminal: boolean | undefined;

export function setProcessGroupIsolation(
  mode: ProcessGroupIsolation,
): ProcessGroupIsolation {
  const previous = isolation;
  isolation = mode;
  return previous;
}

/**
 * Decides whether a tree-terminating spawn runs in its own process group.
 * Windows never does: its tree kill (`taskkill /T`) needs no group.
 */
export function resolveProcessGroupIsolation(options: {
  mode: ProcessGroupIsolation;
  os: typeof Deno.build.os;
  hasControllingTerminal: () => boolean;
}): boolean {
  if (options.os === "windows") return false;
  if (options.mode === "always") return true;
  return !options.hasControllingTerminal();
}

export function shouldIsolateProcessGroup(): boolean {
  return resolveProcessGroupIsolation({
    mode: isolation,
    os: Deno.build.os,
    hasControllingTerminal,
  });
}

/**
 * probed once via /dev/tty, since stdin.isTerminal() is false for piped stdin
 * with a terminal attached; any error counts as no terminal, so an unknown
 * environment isolates rather than orphaning
 */
function hasControllingTerminal(): boolean {
  if (controllingTerminal === undefined) {
    try {
      Deno.openSync("/dev/tty", { read: true }).close();
      controllingTerminal = true;
    } catch (error) {
      const reason = error instanceof Error ? error.name : String(error);
      logger
        .debug`No controlling terminal (${reason}); isolating command process groups`;
      controllingTerminal = false;
    }
  }
  return controllingTerminal;
}
