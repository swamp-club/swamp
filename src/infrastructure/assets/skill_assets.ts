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
import { markErrorPaths } from "../../domain/errors.ts";

export interface SkillInfo {
  relativePath: string;
  name: string;
}

const BUNDLED_SKILLS: SkillInfo[] = [
  { relativePath: "swamp/SKILL.md", name: "swamp" },
  { relativePath: "swamp/references/data/guide.md", name: "swamp" },
  { relativePath: "swamp/references/data/reference.md", name: "swamp" },
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
  { relativePath: "swamp/references/architecture/guide.md", name: "swamp" },
  { relativePath: "swamp/references/behavior/guide.md", name: "swamp" },
  { relativePath: "swamp/references/behavior/reference.md", name: "swamp" },
  {
    relativePath: "swamp/references/behavior/references/concurrency.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/data-chaining.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/data-ownership.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/direct-execution.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/examples.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/expressions.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/outputs.md",
    name: "swamp",
  },
  {
    relativePath:
      "swamp/references/behavior/references/disposable-instances.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/scenarios.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/behavior/references/troubleshooting.md",
    name: "swamp",
  },
  { relativePath: "swamp/references/workflow/guide.md", name: "swamp" },
  { relativePath: "swamp/references/workflow/reference.md", name: "swamp" },
  {
    relativePath: "swamp/references/workflow/references/data-chaining.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/direct-execution.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/execution-semantics.md",
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
    relativePath: "swamp/references/workflow/references/remote-execution.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/workflow/references/scenarios.md",
    name: "swamp",
  },
  { relativePath: "swamp/references/repo/guide.md", name: "swamp" },
  { relativePath: "swamp/references/repo/reference.md", name: "swamp" },
  {
    relativePath: "swamp/references/repo/references/ci-integration.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/repo/references/namespaces.md",
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
  { relativePath: "swamp/references/report/guide.md", name: "swamp" },
  { relativePath: "swamp/references/report/reference.md", name: "swamp" },
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
  { relativePath: "swamp/references/extension/guide.md", name: "swamp" },
  { relativePath: "swamp/references/extension/reference.md", name: "swamp" },
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
    relativePath: "swamp/references/extension/references/model/api.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/webhook/api.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension/references/model/checks.md",
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
  {
    relativePath: "swamp/references/extension-publish/guide.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension-publish/reference.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/extension-publish/references/publishing.md",
    name: "swamp",
  },
  { relativePath: "swamp/references/vault/guide.md", name: "swamp" },
  { relativePath: "swamp/references/vault/reference.md", name: "swamp" },
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
  { relativePath: "swamp/references/issue/guide.md", name: "swamp" },
  { relativePath: "swamp/references/issue/reference.md", name: "swamp" },
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
  { relativePath: "swamp/references/troubleshooting/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/troubleshooting/reference.md",
    name: "swamp",
  },
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
  {
    relativePath:
      "swamp/references/troubleshooting/references/version-check.md",
    name: "swamp",
  },
  { relativePath: "swamp/references/serve/guide.md", name: "swamp" },
  {
    relativePath: "swamp/references/share/guide.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/share/reference.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/share/references/joiner-instructions.md",
    name: "swamp",
  },
  {
    relativePath: "swamp/references/share/references/troubleshooting.md",
    name: "swamp",
  },
  {
    relativePath: "swamp-getting-started/SKILL.md",
    name: "swamp-getting-started",
  },
  {
    relativePath: "swamp-getting-started/references/tracks.md",
    name: "swamp-getting-started",
  },
];

export class SkillAssets {
  private readonly skillsDir: string;

  constructor() {
    const currentDir = import.meta.dirname ?? ".";
    this.skillsDir = join(currentDir, "..", "..", "..", ".claude", "skills");
  }

  getSkillsDir(): string {
    return this.skillsDir;
  }

  listSkills(): SkillInfo[] {
    return [...BUNDLED_SKILLS];
  }

  getSkillNames(): string[] {
    const names = new Set(BUNDLED_SKILLS.map((s) => s.name));
    return Array.from(names);
  }

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

  getSkillPath(relativePath: string): string {
    return join(this.skillsDir, relativePath);
  }

  async copySkillsTo(targetDir: string): Promise<void> {
    for (const skill of BUNDLED_SKILLS) {
      if (skill.relativePath.includes("..")) {
        throw markErrorPaths(
          new Error(
            `Invalid skill path: ${skill.relativePath} contains path traversal`,
          ),
          [skill.relativePath],
        );
      }

      const sourcePath = join(this.skillsDir, skill.relativePath);
      const targetPath = join(targetDir, skill.relativePath);

      const content = await Deno.readTextFile(sourcePath);

      const targetParent = join(targetPath, "..");
      await Deno.mkdir(targetParent, { recursive: true });

      await Deno.writeTextFile(targetPath, content);
    }
  }
}
