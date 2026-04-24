// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * POSIX PATH binary resolution port.
 *
 * Production uses `which` via `Deno.Command`; tests inject a fake.
 * Scoped to POSIX (macOS/Linux) — swamp's supported platforms as of v1.
 * Windows support deferred until a user asks.
 */
export type ResolveBinary = (name: string) => Promise<string | null>;

/** Default implementation using POSIX `which`. */
export const resolveBinaryViaWhich: ResolveBinary = async (name) => {
  try {
    const cmd = new Deno.Command("which", {
      args: [name],
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await cmd.output();
    if (!success) return null;
    const path = new TextDecoder().decode(stdout).trim();
    return path || null;
  } catch {
    return null;
  }
};

/** The shell-command binary name for each audit-integrating tool. */
export function binaryNameFor(tool: string): string {
  switch (tool) {
    case "claude":
      return "claude";
    case "cursor":
      return "cursor";
    case "kiro":
      return "kiro-cli";
    case "opencode":
      return "opencode";
    default:
      return tool;
  }
}
