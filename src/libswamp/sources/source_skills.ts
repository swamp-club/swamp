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

import { dirname, join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { SKILL_DIRS } from "../../domain/repo/skill_dirs.ts";

const logger = getLogger(["swamp", "sources", "skills"]);

export interface ResolvedSkill {
  name: string;
  absolutePath: string;
}

/**
 * Reads a source extension's manifest.yaml and resolves skill directories
 * relative to the source. Only searches within the source itself — does not
 * search project-local or global skill directories.
 */
export async function resolveSourceSkills(
  sourcePath: string,
  tools: string[],
): Promise<ResolvedSkill[]> {
  const manifestPath = await findManifest(sourcePath);
  if (!manifestPath) return [];

  let content: string;
  try {
    content = await Deno.readTextFile(manifestPath);
  } catch {
    return [];
  }

  let manifest;
  try {
    manifest = parseExtensionManifest(content);
  } catch {
    return [];
  }

  if (manifest.skills.length === 0) return [];

  const manifestDir = dirname(manifestPath);
  const useManifestBase = manifest.paths.base === "manifest";

  const candidateBases: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (dir: string) => {
    if (!seen.has(dir)) {
      seen.add(dir);
      candidateBases.push(dir);
    }
  };

  // Only search within the source — manifest-relative tool dirs
  for (const tool of tools) {
    const rel = SKILL_DIRS[tool];
    if (!rel) continue;
    if (useManifestBase) {
      addCandidate(join(manifestDir, rel));
    }
    addCandidate(join(sourcePath, rel));
  }

  if (candidateBases.length === 0) return [];

  const resolved: ResolvedSkill[] = [];
  for (const skillName of manifest.skills) {
    for (const base of candidateBases) {
      const candidate = join(base, skillName);
      try {
        const stat = await Deno.stat(candidate);
        if (stat.isDirectory) {
          resolved.push({ name: skillName, absolutePath: candidate });
          break;
        }
      } catch { /* not found here */ }
    }
  }

  return resolved;
}

/**
 * Copies resolved skill directories to the target skills directory.
 * Skips skills whose target directory already exists (from another source
 * or user-authored) and logs a warning. Returns the list of skill names
 * that were actually copied.
 */
export async function copySourceSkills(
  skills: ResolvedSkill[],
  targetSkillsDir: string,
): Promise<string[]> {
  if (skills.length === 0) return [];

  await Deno.mkdir(targetSkillsDir, { recursive: true });

  const copied: string[] = [];
  for (const skill of skills) {
    const destDir = join(targetSkillsDir, skill.name);
    try {
      const stat = await Deno.stat(destDir);
      if (stat.isDirectory) {
        logger.warn`Skill ${skill.name} already exists at ${destDir}, skipping`;
        continue;
      }
    } catch { /* not found — safe to copy */ }
    await Deno.mkdir(destDir, { recursive: true });
    await copyDir(skill.absolutePath, destDir);
    copied.push(skill.name);
  }

  return copied;
}

/**
 * Removes named skill directories from the target skills directory.
 * Silently skips directories that don't exist.
 */
export async function removeSourceSkills(
  skillNames: string[],
  targetSkillsDir: string,
): Promise<void> {
  for (const name of skillNames) {
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      continue;
    }
    const skillDir = join(targetSkillsDir, name);
    try {
      await Deno.remove(skillDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}

async function findManifest(sourcePath: string): Promise<string | null> {
  const candidate = join(sourcePath, "manifest.yaml");
  try {
    const stat = await Deno.stat(candidate);
    if (stat.isFile) return candidate;
  } catch { /* not found */ }
  return null;
}

async function copyDir(srcDir: string, destDir: string): Promise<void> {
  for await (const entry of Deno.readDir(srcDir)) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isSymlink) {
      const target = await Deno.readLink(srcPath);
      await Deno.symlink(target, destPath, { type: "file" });
    } else if (entry.isDirectory) {
      await Deno.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else if (entry.isFile) {
      await Deno.copyFile(srcPath, destPath);
    }
  }
}
