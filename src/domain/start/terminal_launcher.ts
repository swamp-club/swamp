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

/** What happened when Swamp tried to open the agent's window. */
export interface LaunchOutcome {
  readonly method: LaunchMethod;
  /** False when no window could be opened and the user must paste `command`. */
  readonly opened: boolean;
  /** The copy-paste fallback, always filled in. */
  readonly command: string;
}

/**
 * Writes the launcher script and opens a new terminal window running it.
 * Implementations never throw for "no window possible": they return the
 * `copy_command` outcome instead.
 */
export interface TerminalLauncher {
  open(spec: HarnessLaunchSpec, workspacePath: string): Promise<LaunchOutcome>;
}
