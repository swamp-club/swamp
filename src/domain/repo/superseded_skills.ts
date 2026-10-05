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

import { join, SEPARATOR } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { resolvePrimaryTool } from "./primary_tool.ts";
import { SKILL_DIRS } from "./skill_dirs.ts";

const logger = getLogger(["swamp", "repo", "skills"]);

export const SUPERSEDED_SKILLS: readonly string[] = [
  "swamp-extension-model",
  "swamp-extension-vault",
  "swamp-extension-datastore",
  "swamp-extension-quality",
  "swamp-data-query",
  "swamp-model",
  "swamp-workflow",
  "swamp-data",
  "swamp-vault",
  "swamp-extension",
  "swamp-extension-publish",
  "swamp-repo",
  "swamp-report",
  "swamp-troubleshooting",
  "swamp-issue",
];

export async function removeSupersededSkills(
  skillsDir: string,
): Promise<void> {
  for (const name of SUPERSEDED_SKILLS) {
    const dir = join(skillsDir, name);
    try {
      await Deno.remove(dir, { recursive: true });
      logger.info`Removed superseded skill ${name}`;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

export async function detectSupersededSkills(
  skillsDir: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const name of SUPERSEDED_SKILLS) {
    try {
      await Deno.stat(join(skillsDir, name));
      found.push(name);
    } catch {
      // Not found — not stale
    }
  }
  return found;
}

/**
 * Returns the repo-local skills dirs that may hold superseded skills: one per
 * built-in tool, de-duplicated. With no tools, falls back to the primary tool.
 * The startup warning and `repo upgrade` both use this list.
 */
export function supersededSkillDirs(
  repoDir: string,
  tools: readonly string[],
): string[] {
  const effective = tools.length > 0 ? tools : [resolvePrimaryTool(null)];
  const dirs = new Set<string>();
  for (const tool of effective) {
    const rel = SKILL_DIRS[tool];
    if (rel) dirs.add(join(repoDir, rel));
  }
  return [...dirs];
}

/**
 * Removes superseded skills from the repo-local skills dirs returned by
 * {@link supersededSkillDirs}. A dir that resolves outside the repo (e.g. a
 * committed `.claude` symlink) is skipped, and a failure in one dir is logged
 * rather than thrown.
 */
export async function removeSupersededLocalSkills(
  repoDir: string,
  tools: readonly string[],
): Promise<void> {
  const root = await Deno.realPath(repoDir);
  for (const dir of supersededSkillDirs(repoDir, tools)) {
    try {
      const real = await Deno.realPath(dir);
      if (!real.startsWith(root + SEPARATOR)) {
        logger
          .warn`Skipping superseded skill cleanup in ${dir}: it resolves outside the repository`;
        continue;
      }
      await removeSupersededSkills(dir);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      logger.warn`Skipping superseded skill cleanup in ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }
}
