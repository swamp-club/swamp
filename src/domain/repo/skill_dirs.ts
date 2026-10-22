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
 * Maps AI tool names to their global (user-level) skill directory paths,
 * relative to the user's home directory. Tools that read from
 * `~/.agents/skills/` natively share a single copy; Claude Code and Kiro
 * require their own vendor-specific paths.
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
 * Resolves the absolute skill directory for a repo, based on the active AI tool.
 * Falls back to `.swamp/pulled-extensions/skills/` when tool is "none" or unknown.
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
 * Resolves the absolute global skill directory for a tool, rooted in the
 * user's home directory. Returns null for "none" or unknown tools.
 *
 * `homeDir` overrides the ambient home directory. Callers that own a home
 * directory (tests, sandboxed installs) pass it explicitly so the write
 * target never depends on the process-wide `HOME`.
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
 * Returns deduplicated absolute project-local skill directory paths for
 * a set of enrolled tools. Since multiple tools may share the same path
 * (e.g., codex/cursor/opencode/copilot all use `.agents/skills/`), this
 * deduplicates so each directory is only written to once.
 *
 * When tools is empty, returns a single-element array with the fallback
 * `.swamp/pulled-extensions/skills/` directory — there is always at
 * least one target dir so callers don't need to special-case.
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
 * Returns deduplicated absolute global skill directory paths for a set of
 * enrolled tools. Since multiple tools may share the same global path
 * (e.g., codex/cursor/opencode/copilot all use ~/.agents/skills/), this
 * deduplicates so each directory is only written to once.
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
 * Returns the repo-relative project-local skill directories (the
 * `SKILL_DIRS` values and the `.swamp/pulled-extensions/skills/`
 * fallback) that a lockfile entry's `files` record a skill under, in
 * forward-slash form and deduplicated. A skill is recorded as its root
 * (`.claude/skills/foo`) or, when merged into a dir the extension does
 * not own, as the files it wrote there; both name the same dir.
 *
 * Only members of that fixed set are returned, never a path taken from
 * `files`, so a hand-edited lockfile cannot point an install elsewhere.
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
