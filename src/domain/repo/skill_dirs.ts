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

import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";

/**
 * Maps AI tool names to their skill directory paths (relative to repo root).
 * Used for both project-local and global (user-level) skill directories
 * since the relative path within each tool's config dir is the same.
 */
export const SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  copilot: ".agents/skills",
  kiro: ".kiro/skills",
};

/**
 * Resolves the absolute skill directory for a repo, based on the active AI tool.
 * Falls back to `.swamp/pulled-extensions/skills/` when tool is "none" or unknown.
 */
export function resolveSkillsDir(repoDir: string, tool: string): string {
  if (tool !== "none" && SKILL_DIRS[tool]) {
    return join(repoDir, SKILL_DIRS[tool]);
  }
  return swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills);
}
