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
import { parse as parseYaml } from "@std/yaml";

/** A single validation issue found in a skill directory. */
export interface SkillValidationIssue {
  skill: string;
  message: string;
}

/** Per-skill validation info. */
export interface ValidatedSkill {
  name: string;
  hasScripts: boolean;
  fileCount: number;
}

/** Result of validating extension skill directories. */
export interface SkillValidationResult {
  errors: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
  /** All validated file paths (absolute). */
  skillFiles: string[];
  /** Per-skill metadata. */
  skills: ValidatedSkill[];
}

const MAX_INDIVIDUAL_FILE_SIZE = 500 * 1024; // 500KB
const MAX_TOTAL_SKILL_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Recursively collects all file paths and their sizes under a directory.
 */
async function collectFiles(
  dir: string,
): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        files.push(...await collectFiles(fullPath));
      } else if (entry.isFile) {
        const stat = await Deno.stat(fullPath);
        files.push({ path: fullPath, size: stat.size });
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return files;
}

/**
 * Checks whether a directory exists.
 */
async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Parses YAML frontmatter from a SKILL.md file.
 * Frontmatter is delimited by `---` lines at the start of the file.
 *
 * @returns The parsed frontmatter object, or null if no frontmatter found.
 */
function parseFrontmatter(
  content: string,
): Record<string, unknown> | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return null;

  const yamlContent = lines.slice(1, endIndex).join("\n");
  try {
    const parsed = parseYaml(yamlContent);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates skill directories for extension push.
 *
 * Checks:
 * - SKILL.md exists in each skill directory
 * - SKILL.md has valid YAML frontmatter with `name` and `description`
 * - Individual file size limits
 * - Total skill content size limit
 * - Detects presence of scripts/ directory
 *
 * @param skillDirs Array of objects with skill name and absolute path
 */
export async function validateExtensionSkills(
  skillDirs: Array<{ name: string; absolutePath: string }>,
): Promise<SkillValidationResult> {
  const errors: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const allFiles: string[] = [];
  const validatedSkills: ValidatedSkill[] = [];
  let totalSize = 0;

  for (const { name, absolutePath } of skillDirs) {
    // Check SKILL.md exists
    const skillMdPath = join(absolutePath, "SKILL.md");
    let skillMdContent: string;
    try {
      skillMdContent = await Deno.readTextFile(skillMdPath);
    } catch {
      errors.push({
        skill: name,
        message: `Missing SKILL.md in skill directory: ${absolutePath}`,
      });
      continue;
    }

    // Validate frontmatter
    const frontmatter = parseFrontmatter(skillMdContent);
    if (!frontmatter) {
      errors.push({
        skill: name,
        message:
          "SKILL.md is missing YAML frontmatter (must start with --- delimiters)",
      });
    } else {
      if (
        !frontmatter.name || typeof frontmatter.name !== "string" ||
        frontmatter.name.trim() === ""
      ) {
        errors.push({
          skill: name,
          message: "SKILL.md frontmatter is missing required 'name' field",
        });
      }
      if (
        !frontmatter.description ||
        typeof frontmatter.description !== "string" ||
        frontmatter.description.trim() === ""
      ) {
        errors.push({
          skill: name,
          message:
            "SKILL.md frontmatter is missing required 'description' field",
        });
      }
    }

    // Detect scripts/ directory (per-skill)
    const skillHasScripts = await dirExists(join(absolutePath, "scripts"));

    // Collect and validate all files
    const files = await collectFiles(absolutePath);
    validatedSkills.push({
      name,
      hasScripts: skillHasScripts,
      fileCount: files.length,
    });
    for (const file of files) {
      if (file.size > MAX_INDIVIDUAL_FILE_SIZE) {
        errors.push({
          skill: name,
          message: `File exceeds 500KB size limit: ${file.path} (${
            Math.round(file.size / 1024)
          }KB)`,
        });
      }
      totalSize += file.size;
      allFiles.push(file.path);
    }
  }

  if (totalSize > MAX_TOTAL_SKILL_SIZE) {
    errors.push({
      skill: "(all)",
      message: `Total skill content exceeds 2MB limit (${
        Math.round(totalSize / 1024)
      }KB)`,
    });
  }

  return { errors, warnings, skillFiles: allFiles, skills: validatedSkills };
}
