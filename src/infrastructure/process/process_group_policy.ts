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
 * When a spawn that asked for its process tree to be terminated gets its own
 * process group on POSIX.
 *
 * - `auto`: only when swamp has no controlling terminal (CI, agents, system
 *   services). A child in its own session cannot open `/dev/tty`, so
 *   interactive runs keep terminal prompts and the kernel's Ctrl-C delivery to
 *   the whole tree.
 * - `always`: regardless of the terminal. Set by processes whose runs are
 *   triggered remotely, so nobody at their terminal answers prompts: the
 *   `swamp serve` action and the worker `exec-dispatch` runner.
 */
export type ProcessGroupIsolation = "auto" | "always";

let isolation: ProcessGroupIsolation = "auto";
let controllingTerminal: boolean | undefined;

/**
 * Sets the process-wide isolation policy. Returns the previous policy so
 * callers (tests) can restore it.
 */
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

/** Applies the current policy to this process. */
export function shouldIsolateProcessGroup(): boolean {
  return resolveProcessGroupIsolation({
    mode: isolation,
    os: Deno.build.os,
    hasControllingTerminal,
  });
}

/**
 * Whether this process has a controlling terminal, probed once by opening
 * `/dev/tty`. `Deno.stdin.isTerminal()` is not a substitute: it reports false
 * for piped stdin while a terminal is still attached. Any error counts as no
 * terminal, so an unknown environment isolates rather than orphaning.
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
