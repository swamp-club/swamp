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

import { join } from "@std/path";

/**
 * Represents a skill that can be bundled with swamp.
 */
export interface SkillInfo {
  /** Relative path from .claude/skills (e.g., "swamp-model/SKILL.md") */
  relativePath: string;
  /** Skill name derived from directory (e.g., "swamp-model") */
  name: string;
}

/**
 * List of skills to bundle with the swamp binary.
 */
const BUNDLED_SKILLS: SkillInfo[] = [
  { relativePath: "swamp-data/SKILL.md", name: "swamp-data" },
  {
    relativePath: "swamp-data/references/examples.md",
    name: "swamp-data",
  },
  {
    relativePath: "swamp-data/references/troubleshooting.md",
    name: "swamp-data",
  },
  { relativePath: "swamp-model/SKILL.md", name: "swamp-model" },
  {
    relativePath: "swamp-model/references/data-chaining.md",
    name: "swamp-model",
  },
  {
    relativePath: "swamp-model/references/examples.md",
    name: "swamp-model",
  },
  {
    relativePath: "swamp-model/references/troubleshooting.md",
    name: "swamp-model",
  },
  {
    relativePath: "swamp-model/references/scenarios.md",
    name: "swamp-model",
  },
  { relativePath: "swamp-repo/SKILL.md", name: "swamp-repo" },
  {
    relativePath: "swamp-repo/references/structure.md",
    name: "swamp-repo",
  },
  {
    relativePath: "swamp-repo/references/troubleshooting.md",
    name: "swamp-repo",
  },
  { relativePath: "swamp-workflow/SKILL.md", name: "swamp-workflow" },
  {
    relativePath: "swamp-workflow/references/data-chaining.md",
    name: "swamp-workflow",
  },
  {
    relativePath: "swamp-workflow/references/scenarios.md",
    name: "swamp-workflow",
  },
  {
    relativePath: "swamp-workflow/references/nested-workflows.md",
    name: "swamp-workflow",
  },
  {
    relativePath: "swamp-workflow/references/expressions-and-foreach.md",
    name: "swamp-workflow",
  },
  {
    relativePath: "swamp-extension-model/SKILL.md",
    name: "swamp-extension-model",
  },
  {
    relativePath: "swamp-extension-model/references/examples.md",
    name: "swamp-extension-model",
  },
  {
    relativePath: "swamp-extension-model/references/troubleshooting.md",
    name: "swamp-extension-model",
  },
  {
    relativePath: "swamp-extension-model/references/scenarios.md",
    name: "swamp-extension-model",
  },
  {
    relativePath: "swamp-extension-model/references/api.md",
    name: "swamp-extension-model",
  },
  {
    relativePath: "swamp-vault/SKILL.md",
    name: "swamp-vault",
  },
  {
    relativePath: "swamp-vault/references/providers.md",
    name: "swamp-vault",
  },
  {
    relativePath: "swamp-vault/references/troubleshooting.md",
    name: "swamp-vault",
  },
  {
    relativePath: "swamp-vault/references/examples.md",
    name: "swamp-vault",
  },
  {
    relativePath: "swamp-issue/SKILL.md",
    name: "swamp-issue",
  },
  {
    relativePath: "swamp-troubleshooting/SKILL.md",
    name: "swamp-troubleshooting",
  },
];

/**
 * SkillAssets provides access to embedded skill files.
 *
 * When running from source, skills are read from the .claude/skills directory.
 * When running from a compiled binary, skills are embedded using Deno's --include flag.
 */
export class SkillAssets {
  private readonly skillsDir: string;

  constructor() {
    // import.meta.dirname gives the directory of this file
    // Navigate up to repo root and then to .claude/skills
    const currentDir = import.meta.dirname ?? ".";
    // From src/infrastructure/assets -> ../../.. -> repo root
    this.skillsDir = join(currentDir, "..", "..", "..", ".claude", "skills");
  }

  /**
   * Gets the base skills directory path.
   */
  getSkillsDir(): string {
    return this.skillsDir;
  }

  /**
   * Lists all bundled skills.
   */
  listSkills(): SkillInfo[] {
    return [...BUNDLED_SKILLS];
  }

  /**
   * Gets unique skill names (directories).
   */
  getSkillNames(): string[] {
    const names = new Set(BUNDLED_SKILLS.map((s) => s.name));
    return Array.from(names);
  }

  /**
   * Reads a skill file by its relative path.
   *
   * @param relativePath - Path relative to .claude/skills (e.g., "swamp-model/SKILL.md")
   * @returns The file content, or null if not found
   */
  async readSkill(relativePath: string): Promise<string | null> {
    const path = join(this.skillsDir, relativePath);
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Gets the full path for a skill file.
   */
  getSkillPath(relativePath: string): string {
    return join(this.skillsDir, relativePath);
  }

  /**
   * Copies all bundled skills to a target directory.
   *
   * @param targetDir - The target .claude/skills directory
   * @throws Error if a skill's relativePath attempts path traversal
   */
  async copySkillsTo(targetDir: string): Promise<void> {
    for (const skill of BUNDLED_SKILLS) {
      // Validate that relativePath doesn't contain path traversal
      if (skill.relativePath.includes("..")) {
        throw new Error(
          `Invalid skill path: ${skill.relativePath} contains path traversal`,
        );
      }

      const sourcePath = join(this.skillsDir, skill.relativePath);
      const targetPath = join(targetDir, skill.relativePath);

      // Read the source file
      const content = await Deno.readTextFile(sourcePath);

      // Ensure target directory exists
      const targetParent = join(targetPath, "..");
      await Deno.mkdir(targetParent, { recursive: true });

      // Write to target
      await Deno.writeTextFile(targetPath, content);
    }
  }
}
