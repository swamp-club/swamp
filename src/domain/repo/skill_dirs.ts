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

export const SKILL_DIRS: Record<string, string> = {
  amp: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  copilot: ".agents/skills",
  kiro: ".kiro/skills",
  pi: ".agents/skills",
  antigravity: ".agents/skills",
};

/**
 * tools that read ~/.agents/skills natively share one copy; Claude Code and
 * Kiro require their own vendor-specific paths
 */
export const GLOBAL_SKILL_DIRS: Record<string, string> = {
  amp: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".agents/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  copilot: ".agents/skills",
  kiro: ".kiro/skills",
  pi: ".agents/skills",
  antigravity: ".agents/skills",
};

/**
 * falls back to .swamp/pulled-extensions/skills/ when the tool is none or
 * unknown
 */
export function resolveSkillsDir(
  repoDir: string,
  tool: string,
  pulledExtensionsRoot?: string,
): string {
  if (tool !== "none" && SKILL_DIRS[tool]) {
    return join(repoDir, SKILL_DIRS[tool]);
  }
  if (pulledExtensionsRoot) {
    return join(pulledExtensionsRoot, "skills");
  }
  return swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills);
}

/**
 * homeDir overrides the ambient home; callers that own a home directory pass it
 * so the write target never depends on the process-wide HOME
 */
export function resolveGlobalSkillsDir(
  tool: string,
  homeDir?: string,
): string | null {
  const rel = GLOBAL_SKILL_DIRS[tool];
  if (!rel) return null;
  return join(homeDir ?? homeDirectory(), rel);
}

/**
 * tools sharing a path are deduplicated so each directory is written once; with
 * no tools it returns the pulled-extensions fallback, so there is always one
 * target
 */
export function resolveUniqueLocalSkillsDirs(
  repoDir: string,
  tools: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of tools) {
    const dir = resolveSkillsDir(repoDir, tool);
    if (!seen.has(dir)) {
      seen.add(dir);
      result.push(dir);
    }
  }
  if (result.length === 0) {
    result.push(swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills));
  }
  return result;
}

/**
 * tools sharing a global path are deduplicated so each directory is written
 * once
 */
export function resolveUniqueGlobalSkillsDirs(
  tools: readonly string[],
  homeDir?: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of tools) {
    const dir = resolveGlobalSkillsDir(tool, homeDir);
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      result.push(dir);
    }
  }
  return result;
}

/**
 * returns only members of the fixed skill-dir set, never a path taken from
 * files, so a hand-edited lockfile cannot point an install elsewhere
 */
export function recordedSkillsDirs(files: readonly string[]): string[] {
  const known = new Set([
    ...Object.values(SKILL_DIRS),
    `.swamp/${SWAMP_SUBDIRS.pulledSkills}`,
  ]);
  const result: string[] = [];
  for (const dir of known) {
    const recorded = files.some((file) =>
      file.replaceAll("\\", "/").startsWith(`${dir}/`)
    );
    if (recorded) result.push(dir);
  }
  return result;
}
