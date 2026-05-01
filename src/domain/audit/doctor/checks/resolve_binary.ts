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
 * Cross-platform PATH binary resolution port.
 *
 * Domain declares the contract; the CLI layer wires in
 * `defaultCommandResolver()` from `infrastructure/process` (POSIX `which`,
 * Windows `where`) at construction time. Tests inject a fake directly.
 */
export type ResolveBinary = (name: string) => Promise<string | null>;

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
