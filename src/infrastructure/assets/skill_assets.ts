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

/**
 * Represents a skill that can be bundled with swamp.
 */
export interface SkillInfo {
  /** Relative path from .claude/skills (e.g., "swamp/SKILL.md") */
  relativePath: string;
  /** Skill name derived from directory (e.g., "swamp") */
  name: string;
}

/**
 * List of skills to bundle with the swamp binary.
 */
const BUNDLED_SKILLS: SkillInfo[] = [
  // Gateway skill
  { relativePath: "swamp/SKILL.md", name: "swamp" },
  // data
  { relativePath: "swamp/references/data/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/data/references/concepts.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/data/references/data-ownership.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/data/references/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/data/references/expressions.md",
    name: "swamp",
  },
  { relativePath: "swamp/references/data/references/fields.md", name: "swamp" },
  {
    relativePath: "swamp/references/data/references/output-shapes.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/data/references/troubleshooting.md",
    name: "swamp",
  },
  // model
  { relativePath: "swamp/references/model/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/model/references/data-chaining.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/data-ownership.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/direct-execution.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/execution-drivers.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/expressions.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/outputs.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/scenarios.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/model/references/troubleshooting.md",
    name: "swamp",
  },
  // workflow
  { relativePath: "swamp/references/workflow/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/workflow/references/data-chaining.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/direct-execution.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/execution-drivers.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/workflow/references/expressions-and-foreach.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/nested-workflows.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/scenarios.md",
    name: "swamp",
  },
  // repo
  { relativePath: "swamp/references/repo/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/repo/references/ci-integration.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/repo/references/structure.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/repo/references/troubleshooting.md",
    name: "swamp",
  },
  // report
  { relativePath: "swamp/references/report/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/report/references/control-model.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/report/references/filtering.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/report/references/report-types.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/report/references/testing.md",
    name: "swamp",
  },
  // extension
  { relativePath: "swamp/references/extension/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/extension/references/adversarial-review.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/datastore/api.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/datastore/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/datastore/testing.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/datastore/troubleshooting.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/driver/api.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/driver/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/driver/testing.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/driver/troubleshooting.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/api.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/checks.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/model/docker-execution.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/scenarios.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/skills.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/model/smoke_testing.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/testing.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/model/troubleshooting.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/typing.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/upgrades.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/quality/rubric.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/quality/templates.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/report/api.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/report/report-types.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/report/testing.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/vault/api.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/vault/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/vault/testing.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/extension/references/vault/troubleshooting.md",
    name: "swamp",
  },
  // extension-publish
  {
    relativePath: "swamp/references/extension-publish/guide.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension-publish/references/publishing.md",
    name: "swamp",
  },
  // vault
  { relativePath: "swamp/references/vault/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/vault/references/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/vault/references/providers.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/vault/references/troubleshooting.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/vault/references/user-defined-vaults.md",
    name: "swamp",
  },
  // issue
  { relativePath: "swamp/references/issue/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/issue/references/extension_routing.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/issue/references/formatting.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/issue/references/output_shapes.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/issue/references/sanitization.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/issue/references/security_routing.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/issue/references/version_check.md",
    name: "swamp",
  },
  // troubleshooting
  { relativePath: "swamp/references/troubleshooting/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/troubleshooting/references/checks.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/troubleshooting/references/error-inspection.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/troubleshooting/references/health-checks.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/troubleshooting/references/source-reading.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/troubleshooting/references/tracing.md",
    name: "swamp",
  },
  // swamp-getting-started (standalone skill)
  {
    relativePath: "swamp-getting-started/SKILL.md",
    name: "swamp-getting-started",
  },
  {
    relativePath: "swamp-getting-started/references/tracks.md",
    name: "swamp-getting-started",
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
