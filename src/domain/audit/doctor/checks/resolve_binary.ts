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

export type ResolveBinary = (name: string) => Promise<string | null>;

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
    case "copilot":
      return "copilot";
    case "pi":
      return "pi";
    case "antigravity":
      return "agy";
    default:
      return tool;
  }
}
