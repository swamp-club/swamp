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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { RepoService } from "./repo_service.ts";
import { RepoPath } from "./repo_path.ts";
import type { AiTool } from "../../infrastructure/persistence/repo_marker_repository.ts";

// Helper to create a temp directory for testing
async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_repo_test_" });
  try {
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("RepoService.init creates marker file", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.version, "0.1.0");
    assertEquals(result.path, tempDir);
    assertEquals(result.tool, "claude");

    // Check marker file exists
    const markerPath = join(tempDir, ".swamp.yaml");
    const stat = await Deno.stat(markerPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("RepoService.init creates CLAUDE.md by default", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.instructionsFileCreated, true);

    // Check CLAUDE.md exists
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(content, "swamp");
  });
});

Deno.test("RepoService.init does not overwrite existing CLAUDE.md", async () => {
  await withTempDir(async (tempDir) => {
    // Create existing CLAUDE.md
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    await Deno.writeTextFile(claudeMdPath, "# Existing Content");

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.instructionsFileCreated, false);

    // Check content is unchanged
    const content = await Deno.readTextFile(claudeMdPath);
    assertEquals(content, "# Existing Content");
  });
});

Deno.test("RepoService.init copies skills", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.skillsCopied.length > 0, true);

    // Check skills directory exists
    const skillsDir = join(tempDir, ".claude", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("RepoService.init creates data directory structure", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Check all data subdirectories exist
    const expectedDirs = [
      ".swamp/workflows",
      ".swamp/data",
      ".swamp/outputs",
      ".swamp/workflow-runs",
      ".swamp/workflows-evaluated",
      ".swamp/definitions",
      ".swamp/definitions-evaluated",
      ".swamp/vault",
      ".swamp/secrets",
      ".swamp/telemetry",
    ];

    for (const dir of expectedDirs) {
      const dirPath = join(tempDir, dir);
      const stat = await Deno.stat(dirPath);
      assertEquals(stat.isDirectory, true, `${dir} should exist`);
    }
  });
});

Deno.test("RepoService.init throws if already initialized without force", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // First init succeeds
    await service.init(repoPath);

    // Second init should throw
    await assertRejects(
      () => service.init(repoPath),
      Error,
      "already initialized",
    );
  });
});

Deno.test("RepoService.init succeeds with force on existing repo", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // First init
    await service.init(repoPath);

    // Second init with force
    const result = await service.init(repoPath, { force: true });

    assertEquals(result.version, "0.1.0");
  });
});

Deno.test("RepoService.init creates directory if not exists", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const newDir = join(tempDir, "new-repo");
    const repoPath = RepoPath.create(newDir);

    await service.init(repoPath);

    const stat = await Deno.stat(newDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("RepoService.isInitialized returns false for empty dir", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.isInitialized(repoPath);

    assertEquals(result, false);
  });
});

Deno.test("RepoService.isInitialized returns true after init", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);
    const result = await service.isInitialized(repoPath);

    assertEquals(result, true);
  });
});

Deno.test("RepoService.upgrade throws on non-initialized repo", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await assertRejects(
      () => service.upgrade(repoPath),
      Error,
      "Not a swamp repository",
    );
  });
});

Deno.test("RepoService.upgrade updates version", async () => {
  await withTempDir(async (tempDir) => {
    // Init with old version
    const oldService = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Upgrade with new version
    const newService = new RepoService("0.2.0");
    const result = await newService.upgrade(repoPath);

    assertEquals(result.previousVersion, "0.1.0");
    assertEquals(result.newVersion, "0.2.0");
    assertEquals(result.skillsUpdated.length > 0, true);
  });
});

Deno.test("RepoService.getMarker returns null for non-initialized", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const marker = await service.getMarker(repoPath);

    assertEquals(marker, null);
  });
});

Deno.test("RepoService.getMarker returns data after init", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);
    const marker = await service.getMarker(repoPath);

    assertEquals(marker !== null, true);
    assertEquals(marker!.swampVersion, "0.1.0");
  });
});

Deno.test("RepoService.init creates settings.local.json for claude", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.settingsCreated, true);

    // Check settings.local.json exists and has expected content
    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const content = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(content);

    assertEquals(Array.isArray(settings.permissions?.allow), true);
    assertStringIncludes(
      JSON.stringify(settings.permissions.allow),
      "swamp model",
    );
  });
});

Deno.test("RepoService.init does not overwrite existing settings.local.json", async () => {
  await withTempDir(async (tempDir) => {
    // Create existing settings
    const claudeDir = join(tempDir, ".claude");
    await Deno.mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");
    const existingSettings = {
      permissions: { allow: ["Bash(custom command:*)"] },
    };
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify(existingSettings, null, 2),
    );

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.settingsCreated, false);

    // Check content is unchanged
    const content = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(content);
    assertEquals(settings.permissions.allow, ["Bash(custom command:*)"]);
  });
});

Deno.test("RepoService.upgrade merges new permissions into existing settings", async () => {
  await withTempDir(async (tempDir) => {
    // Init first
    const oldService = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Modify settings to add custom permission and remove some default ones
    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const customSettings = {
      permissions: {
        allow: ["Bash(custom command:*)", "Bash(swamp model search:*)"],
      },
    };
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify(customSettings, null, 2),
    );

    // Upgrade
    const newService = new RepoService("0.2.0");
    const result = await newService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, true);

    // Check that custom permission is preserved and new ones are added
    const content = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(content);

    // Custom permission preserved
    assertStringIncludes(
      JSON.stringify(settings.permissions.allow),
      "Bash(custom command:*)",
    );
    // Default permissions added
    assertStringIncludes(
      JSON.stringify(settings.permissions.allow),
      "Bash(swamp vault:*)",
    );
  });
});

Deno.test("RepoService.upgrade creates settings if they do not exist", async () => {
  await withTempDir(async (tempDir) => {
    // Init first
    const oldService = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Remove settings file
    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    await Deno.remove(settingsPath);

    // Upgrade
    const newService = new RepoService("0.2.0");
    const result = await newService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, true);

    // Check settings created
    const content = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(content);
    assertEquals(Array.isArray(settings.permissions?.allow), true);
  });
});

Deno.test("RepoService.upgrade returns false if settings unchanged", async () => {
  await withTempDir(async (tempDir) => {
    // Init first
    const oldService = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Upgrade immediately (settings already have all permissions)
    const newService = new RepoService("0.2.0");
    const result = await newService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, false);
  });
});

Deno.test("RepoService.init generates CLAUDE.md with skills section", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);

    assertStringIncludes(content, "## Skills");
    assertStringIncludes(content, "swamp-model");
    assertStringIncludes(content, "swamp-workflow");
    assertStringIncludes(content, "plan mode");
  });
});

Deno.test("RepoService.init creates .gitignore", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.gitignoreCreated, true);

    // Check .gitignore exists and has expected content
    const gitignorePath = join(tempDir, ".gitignore");
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".swamp/telemetry/");
    assertStringIncludes(content, ".swamp/secrets/keyfile");
    assertStringIncludes(content, ".claude/");
  });
});

Deno.test("RepoService.init does not overwrite existing .gitignore", async () => {
  await withTempDir(async (tempDir) => {
    // Create existing .gitignore
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(
      gitignorePath,
      "# My existing gitignore\nnode_modules/\n",
    );

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.gitignoreCreated, false);

    // Check content is unchanged
    const content = await Deno.readTextFile(gitignorePath);
    assertEquals(content, "# My existing gitignore\nnode_modules/\n");
  });
});

Deno.test("RepoService.init with force does not overwrite existing .gitignore", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // First init
    await service.init(repoPath);

    // Modify .gitignore with custom content
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(
      gitignorePath,
      "# Custom gitignore\nmy-custom-file.txt\n",
    );

    // Second init with force
    const result = await service.init(repoPath, { force: true });

    assertEquals(result.gitignoreCreated, false);

    // Check content is unchanged
    const content = await Deno.readTextFile(gitignorePath);
    assertEquals(content, "# Custom gitignore\nmy-custom-file.txt\n");
  });
});

// Multi-tool tests

Deno.test("RepoService.init with cursor creates .cursor/skills/ and .cursor/rules/swamp.mdc", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "cursor" });

    assertEquals(result.tool, "cursor");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, false);

    // Check skills copied to .cursor/skills/
    const skillsDir = join(tempDir, ".cursor", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Check instructions file is .cursor/rules/swamp.mdc with MDC frontmatter
    const mdcPath = join(tempDir, ".cursor", "rules", "swamp.mdc");
    const content = await Deno.readTextFile(mdcPath);
    assertStringIncludes(content, "alwaysApply: true");
    assertStringIncludes(content, "swamp");
    assertStringIncludes(content, "## Skills");

    // Check .gitignore has cursor-specific entries
    const gitignorePath = join(tempDir, ".gitignore");
    const gitignoreContent = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(gitignoreContent, ".cursor/skills/");

    // Check no .claude/ settings created
    const claudeSettingsPath = join(
      tempDir,
      ".claude",
      "settings.local.json",
    );
    let settingsExist = false;
    try {
      await Deno.stat(claudeSettingsPath);
      settingsExist = true;
    } catch {
      // expected
    }
    assertEquals(settingsExist, false);
  });
});

Deno.test("RepoService.init with opencode creates .agents/skills/ and AGENTS.md", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "opencode" });

    assertEquals(result.tool, "opencode");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, false);

    // Check skills copied to .agents/skills/
    const skillsDir = join(tempDir, ".agents", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Check AGENTS.md created
    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(content, "swamp");
    assertStringIncludes(content, "## Skills");

    // Check .gitignore has agents-specific entries
    const gitignorePath = join(tempDir, ".gitignore");
    const gitignoreContent = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(gitignoreContent, ".agents/skills/");
  });
});

Deno.test("RepoService.init with codex creates .agents/skills/ and AGENTS.md", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "codex" });

    assertEquals(result.tool, "codex");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, false);

    // Check skills copied to .agents/skills/
    const skillsDir = join(tempDir, ".agents", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Check AGENTS.md created
    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(content, "swamp");

    // Check .gitignore has agents-specific entries
    const gitignorePath = join(tempDir, ".gitignore");
    const gitignoreContent = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(gitignoreContent, ".agents/skills/");
  });
});

Deno.test("RepoService.init stores tool in marker", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "cursor" });

    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.tool, "cursor");
  });
});

Deno.test("RepoService.upgrade reads tool from marker", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with cursor
    await service.init(repoPath, { tool: "cursor" });

    // Upgrade without specifying tool
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.tool, "cursor");

    // Verify skills updated in cursor dir
    const skillsDir = join(tempDir, ".cursor", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("RepoService.upgrade allows switching tool via --tool", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to cursor
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "cursor" });

    assertEquals(result.tool, "cursor");

    // Verify skills exist in cursor dir
    const skillsDir = join(tempDir, ".cursor", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Verify marker updated with new tool
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.tool, "cursor");

    // Verify instructions file created for cursor
    const instructionsPath = join(tempDir, ".cursor", "rules", "swamp.mdc");
    const instructionsStat = await Deno.stat(instructionsPath);
    assertEquals(instructionsStat.isFile, true);
    const content = await Deno.readTextFile(instructionsPath);
    assertStringIncludes(content, "---");
    assertStringIncludes(content, "alwaysApply: true");
  });
});

Deno.test("RepoService.upgrade creates AGENTS.md when switching to codex", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to codex
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "codex" });

    assertEquals(result.tool, "codex");

    // Verify AGENTS.md created
    const instructionsPath = join(tempDir, "AGENTS.md");
    const instructionsStat = await Deno.stat(instructionsPath);
    assertEquals(instructionsStat.isFile, true);
    const content = await Deno.readTextFile(instructionsPath);
    assertStringIncludes(content, "# Project");
    assertStringIncludes(content, "swamp");
  });
});

Deno.test("RepoService.upgrade does not overwrite existing instructions file", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with claude
    await service.init(repoPath);

    // Create custom AGENTS.md before switching
    const instructionsPath = join(tempDir, "AGENTS.md");
    const customContent = "# My Custom Instructions\nDo not overwrite me!";
    await Deno.writeTextFile(instructionsPath, customContent);

    // Upgrade with tool switch to codex
    const upgradeService = new RepoService("0.2.0");
    await upgradeService.upgrade(repoPath, { tool: "codex" });

    // Verify AGENTS.md was NOT overwritten
    const content = await Deno.readTextFile(instructionsPath);
    assertEquals(content, customContent);
  });
});

Deno.test("RepoService.upgrade defaults to claude for pre-existing repos without tool", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with default (claude) - simulate old marker without tool field
    await service.init(repoPath);

    // Manually remove tool from marker to simulate old repo
    const markerPath = join(tempDir, ".swamp.yaml");
    const markerContent = await Deno.readTextFile(markerPath);
    const updatedMarker = markerContent.replace(/tool:.*\n/, "");
    await Deno.writeTextFile(markerPath, updatedMarker);

    // Upgrade without specifying tool
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.tool, "claude");
  });
});

Deno.test("RepoService.upgrade skips settings for non-claude tools", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "cursor" });

    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, false);
  });
});

Deno.test("RepoService.upgrade creates .gitignore if missing", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init (creates .gitignore), then delete it
    await service.init(repoPath);
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.remove(gitignorePath);

    // Upgrade should recreate .gitignore
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreCreated, true);

    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".swamp/telemetry/");
    assertStringIncludes(content, ".swamp/secrets/keyfile");
    assertStringIncludes(content, ".claude/");
  });
});

Deno.test("RepoService.upgrade does not overwrite existing .gitignore", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init creates .gitignore
    await service.init(repoPath);

    // Upgrade should leave .gitignore unchanged
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreCreated, false);
  });
});

Deno.test("RepoService.init cursor instructions have MDC frontmatter", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "cursor" });

    const mdcPath = join(tempDir, ".cursor", "rules", "swamp.mdc");
    const content = await Deno.readTextFile(mdcPath);

    // Check MDC frontmatter
    assertStringIncludes(content, "---\n");
    assertStringIncludes(content, "description: Swamp automation rules");
    assertStringIncludes(content, "alwaysApply: true");
  });
});

Deno.test("RepoService.init tool-specific gitignore entries", async () => {
  const toolGitignoreEntries: Record<AiTool, string> = {
    claude: ".claude/",
    cursor: ".cursor/skills/",
    opencode: ".agents/skills/",
    codex: ".agents/skills/",
  };

  for (
    const [tool, expectedEntry] of Object.entries(
      toolGitignoreEntries,
    ) as [AiTool, string][]
  ) {
    await withTempDir(async (tempDir) => {
      const service = new RepoService("0.1.0");
      const repoPath = RepoPath.create(tempDir);

      await service.init(repoPath, { tool });

      const gitignorePath = join(tempDir, ".gitignore");
      const content = await Deno.readTextFile(gitignorePath);
      assertStringIncludes(
        content,
        expectedEntry,
        `${tool} gitignore should include ${expectedEntry}`,
      );
      // All tools should have common entries
      assertStringIncludes(content, ".swamp/telemetry/");
      assertStringIncludes(content, ".swamp/secrets/keyfile");
    });
  }
});
