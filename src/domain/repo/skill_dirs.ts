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
  homeDirectory,
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";

/**
 * Maps AI tool names to their skill directory paths (relative to repo root).
 * Used for project-local skill directories and extension skill resolution.
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
 * Maps AI tool names to their global (user-level) skill directory paths,
 * relative to the user's home directory. Tools that read from
 * `~/.agents/skills/` natively share a single copy; Claude Code and Kiro
 * require their own vendor-specific paths.
 */
export const GLOBAL_SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills",
  cursor: ".agents/skills",
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

/**
 * Resolves the absolute global skill directory for a tool, rooted in the
 * user's home directory. Returns null for "none" or unknown tools.
 */
export function resolveGlobalSkillsDir(tool: string): string | null {
  const rel = GLOBAL_SKILL_DIRS[tool];
  if (!rel) return null;
  return join(homeDirectory(), rel);
}

/**
 * Returns deduplicated absolute global skill directory paths for a set of
 * enrolled tools. Since multiple tools may share the same global path
 * (e.g., codex/cursor/opencode/copilot all use ~/.agents/skills/), this
 * deduplicates so each directory is only written to once.
 */
export function resolveUniqueGlobalSkillsDirs(
  tools: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of tools) {
    const dir = resolveGlobalSkillsDir(tool);
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      result.push(dir);
    }
  }
  return result;
}
