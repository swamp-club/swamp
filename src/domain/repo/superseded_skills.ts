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

async function removeSupersededSkill(
  skillsDir: string,
  name: string,
): Promise<void> {
  try {
    await Deno.remove(join(skillsDir, name), { recursive: true });
    logger.info`Removed superseded skill ${name}`;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

export async function removeSupersededSkills(
  skillsDir: string,
): Promise<void> {
  for (const name of SUPERSEDED_SKILLS) {
    await removeSupersededSkill(skillsDir, name);
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
 * Resolves the dirs from {@link supersededSkillDirs} to their real paths and
 * splits them by whether they stay inside the repo. Missing dirs are left out;
 * a dir whose path cannot be resolved for any other reason is returned in
 * `failed` rather than thrown.
 * Only `contained` dirs are checked by the startup warning or cleaned by
 * `repo upgrade`, so a symlink such as a committed `.claude` pointing outside
 * the repo is never reported or touched.
 */
export async function resolveSupersededSkillDirs(
  repoDir: string,
  tools: readonly string[],
): Promise<{
  contained: string[];
  outside: string[];
  failed: { dir: string; message: string }[];
}> {
  const root = await Deno.realPath(repoDir);
  const contained: string[] = [];
  const outside: string[] = [];
  const failed: { dir: string; message: string }[] = [];
  for (const dir of supersededSkillDirs(repoDir, tools)) {
    let real: string;
    try {
      real = await Deno.realPath(dir);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        failed.push({
          dir,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }
    if (real.startsWith(root + SEPARATOR)) {
      contained.push(real);
    } else {
      outside.push(dir);
    }
  }
  return { contained, outside, failed };
}

/**
 * Removes superseded skills from the repo-local skills dirs that resolve
 * inside the repo. Deletes go through the resolved path, and a failure on one
 * entry is logged without stopping the rest.
 */
export async function removeSupersededLocalSkills(
  repoDir: string,
  tools: readonly string[],
): Promise<void> {
  const { contained, outside, failed } = await resolveSupersededSkillDirs(
    repoDir,
    tools,
  );
  for (const { dir, message } of failed) {
    logger.warn`Skipping superseded skill cleanup in ${dir}: ${message}`;
  }
  for (const dir of outside) {
    logger
      .warn`Skipping superseded skill cleanup in ${dir}: it resolves outside the repository`;
  }
  for (const dir of contained) {
    for (const name of SUPERSEDED_SKILLS) {
      try {
        await removeSupersededSkill(dir, name);
      } catch (err) {
        logger.warn`Could not remove superseded skill ${name} from ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }
}
