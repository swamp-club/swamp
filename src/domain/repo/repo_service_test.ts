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

Deno.test("RepoService.init skips .gitignore by default", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.gitignoreAction, "skipped");

    // .gitignore should not exist
    const gitignorePath = join(tempDir, ".gitignore");
    let exists = false;
    try {
      await Deno.stat(gitignorePath);
      exists = true;
    } catch {
      // expected
    }
    assertEquals(exists, false);
  });
});

Deno.test("RepoService.init creates .gitignore with managed section when opted in", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { includeGitignore: true });

    assertEquals(result.gitignoreAction, "created");

    // Check .gitignore exists and has expected content with markers
    const gitignorePath = join(tempDir, ".gitignore");
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, "# END swamp managed section");
    assertStringIncludes(content, ".swamp/telemetry/");
    assertStringIncludes(content, ".swamp/secrets/keyfile");
    assertStringIncludes(content, ".claude/");

    // Check marker persists the preference
    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, true);
  });
});

Deno.test("RepoService.init appends managed section to existing .gitignore when opted in", async () => {
  await withTempDir(async (tempDir) => {
    // Create existing .gitignore
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(
      gitignorePath,
      "# My existing gitignore\nnode_modules/\n",
    );

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { includeGitignore: true });

    assertEquals(result.gitignoreAction, "updated");

    // Check user content is preserved and managed section is appended
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, "# My existing gitignore");
    assertStringIncludes(content, "node_modules/");
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, ".swamp/telemetry/");
    assertStringIncludes(content, "# END swamp managed section");
  });
});

Deno.test("RepoService.init with force returns unchanged when section is current", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // First init creates .gitignore with managed section
    await service.init(repoPath, { includeGitignore: true });

    // Second init with force — section already matches
    const result = await service.init(repoPath, {
      force: true,
      includeGitignore: true,
    });

    assertEquals(result.gitignoreAction, "unchanged");
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
    assertEquals(result.settingsCreated, true);
    assertEquals(result.gitignoreAction, "skipped");

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

    // Check .cursor/hooks.json was created
    const hooksPath = join(tempDir, ".cursor", "hooks.json");
    const hooksContent = await Deno.readTextFile(hooksPath);
    assertStringIncludes(
      hooksContent,
      "swamp audit record --from-hook --tool cursor",
    );

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
    assertEquals(result.settingsCreated, true);
    assertEquals(result.gitignoreAction, "skipped");

    // Check skills copied to .agents/skills/
    const skillsDir = join(tempDir, ".agents", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Check AGENTS.md created
    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(content, "swamp");
    assertStringIncludes(content, "## Skills");

    // Check .opencode/plugins/swamp-audit.ts created
    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    const pluginContent = await Deno.readTextFile(pluginPath);
    assertStringIncludes(pluginContent, "--from-hook");
    assertStringIncludes(pluginContent, "--tool");
    assertStringIncludes(pluginContent, "opencode");
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
    assertEquals(result.gitignoreAction, "skipped");

    // Check skills copied to .agents/skills/
    const skillsDir = join(tempDir, ".agents", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Check AGENTS.md created
    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(content, "swamp");
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

Deno.test("RepoService.upgrade skips .gitignore by default", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "skipped");
  });
});

Deno.test("RepoService.upgrade creates .gitignore when marker has gitignoreManaged", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with gitignore opt-in (creates .gitignore and sets marker)
    await service.init(repoPath, { includeGitignore: true });
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.remove(gitignorePath);

    // Upgrade should recreate .gitignore because marker has gitignoreManaged
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "created");

    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, ".swamp/telemetry/");
    assertStringIncludes(content, ".swamp/secrets/keyfile");
    assertStringIncludes(content, ".claude/");
    assertStringIncludes(content, "# END swamp managed section");
  });
});

Deno.test("RepoService.upgrade returns unchanged when section is current", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init creates .gitignore with managed section
    await service.init(repoPath, { includeGitignore: true });

    // Upgrade — section already matches (marker has gitignoreManaged: true)
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "unchanged");
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

Deno.test("RepoService.init tool-specific gitignore entries when opted in", async () => {
  const toolGitignoreEntries: Record<AiTool, string> = {
    claude: ".claude/",
    cursor: ".cursor/skills/",
    opencode: ".agents/skills/",
    codex: ".agents/skills/",
    kiro: ".kiro/skills/",
  };

  for (
    const [tool, expectedEntry] of Object.entries(
      toolGitignoreEntries,
    ) as [AiTool, string][]
  ) {
    await withTempDir(async (tempDir) => {
      const service = new RepoService("0.1.0");
      const repoPath = RepoPath.create(tempDir);

      await service.init(repoPath, { tool, includeGitignore: true });

      const gitignorePath = join(tempDir, ".gitignore");
      const content = await Deno.readTextFile(gitignorePath);
      assertStringIncludes(
        content,
        expectedEntry,
        `${tool} gitignore should include ${expectedEntry}`,
      );
      // All tools should have common entries within managed section
      assertStringIncludes(content, ".swamp/telemetry/");
      assertStringIncludes(content, ".swamp/secrets/keyfile");
      assertStringIncludes(
        content,
        "# BEGIN swamp managed section - DO NOT EDIT",
      );
      assertStringIncludes(content, "# END swamp managed section");
    });
  }
});

// Managed .gitignore section tests

Deno.test("RepoService.init preserves user content before managed section", async () => {
  await withTempDir(async (tempDir) => {
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(gitignorePath, "node_modules/\ndist/\n");

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { includeGitignore: true });

    const content = await Deno.readTextFile(gitignorePath);
    // User content comes first
    const beginIndex = content.indexOf(
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    const userContentIndex = content.indexOf("node_modules/");
    assertEquals(userContentIndex < beginIndex, true);
    assertStringIncludes(content, "dist/");
  });
});

Deno.test("RepoService.init replaces managed section on tool switch", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with claude and gitignore
    await service.init(repoPath, { includeGitignore: true });
    const gitignorePath = join(tempDir, ".gitignore");
    let content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".claude/");

    // Re-init with cursor (force) and gitignore
    const result = await service.init(repoPath, {
      force: true,
      tool: "cursor",
      includeGitignore: true,
    });

    assertEquals(result.gitignoreAction, "updated");
    content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".cursor/skills/");
    // Old tool entry should be replaced
    assertEquals(content.includes(".claude/"), false);
  });
});

Deno.test("RepoService.upgrade updates managed section on tool switch", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with claude and gitignore
    await service.init(repoPath, { includeGitignore: true });

    // Add user content after the managed section
    const gitignorePath = join(tempDir, ".gitignore");
    const original = await Deno.readTextFile(gitignorePath);
    await Deno.writeTextFile(gitignorePath, original + "*.log\n");

    // Upgrade with tool switch to cursor (marker has gitignoreManaged: true)
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "cursor" });

    assertEquals(result.gitignoreAction, "updated");
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".cursor/skills/");
    // User content after section is preserved
    assertStringIncludes(content, "*.log");
  });
});

Deno.test("RepoService.init handles .gitignore without trailing newline", async () => {
  await withTempDir(async (tempDir) => {
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(gitignorePath, "node_modules/"); // no trailing newline

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { includeGitignore: true });

    assertEquals(result.gitignoreAction, "updated");
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, "node_modules/");
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    // Ensure there's separation between user content and managed section
    assertEquals(content.includes("node_modules/\n\n#"), true);
  });
});

Deno.test("RepoService.init migrates legacy gitignore format when opted in", async () => {
  await withTempDir(async (tempDir) => {
    // Create legacy-format .gitignore (as old swamp would have created it)
    const gitignorePath = join(tempDir, ".gitignore");
    const legacyContent = `# Swamp managed defaults
# Feel free to modify this file to suit your needs

# Local telemetry (not needed for reconstruction)
.swamp/telemetry/

# Encryption keyfile (NEVER commit - allows decrypting secrets)
.swamp/secrets/keyfile

# Cached extension bundles (regenerated at runtime)
.swamp/bundles/

# Claude Code configuration (managed by swamp)
.claude/
`;
    await Deno.writeTextFile(gitignorePath, legacyContent);

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { includeGitignore: true });

    assertEquals(result.gitignoreAction, "updated");
    const content = await Deno.readTextFile(gitignorePath);
    // Legacy header should be replaced by markers
    assertEquals(content.includes("# Swamp managed defaults"), false);
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, "# END swamp managed section");
    assertStringIncludes(content, ".swamp/telemetry/");
    assertStringIncludes(content, ".claude/");
  });
});

Deno.test("RepoService.init migrates legacy gitignore with user additions when opted in", async () => {
  await withTempDir(async (tempDir) => {
    // Create legacy-format .gitignore with user additions after it
    const gitignorePath = join(tempDir, ".gitignore");
    const legacyContent = `# Swamp managed defaults
# Feel free to modify this file to suit your needs

# Local telemetry (not needed for reconstruction)
.swamp/telemetry/

# Encryption keyfile (NEVER commit - allows decrypting secrets)
.swamp/secrets/keyfile

# Cached extension bundles (regenerated at runtime)
.swamp/bundles/

# Claude Code configuration (managed by swamp)
.claude/
# My custom additions
*.log
build/
`;
    await Deno.writeTextFile(gitignorePath, legacyContent);

    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { includeGitignore: true });

    assertEquals(result.gitignoreAction, "updated");
    const content = await Deno.readTextFile(gitignorePath);
    // Legacy header should be replaced
    assertEquals(content.includes("# Swamp managed defaults"), false);
    // New markers should be present
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, "# END swamp managed section");
    // User additions should be preserved
    assertStringIncludes(content, "# My custom additions");
    assertStringIncludes(content, "*.log");
    assertStringIncludes(content, "build/");
  });
});

// Opt-in/opt-out gitignore management tests

Deno.test("RepoService.init without includeGitignore does not set gitignoreManaged", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, undefined);
  });
});

Deno.test("RepoService.upgrade with includeGitignore true opts in and persists", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init without gitignore
    await service.init(repoPath);

    // Upgrade with opt-in
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, {
      includeGitignore: true,
    });

    assertEquals(result.gitignoreAction, "created");

    // Marker should persist the preference
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, true);
  });
});

Deno.test("RepoService.upgrade with includeGitignore false opts out and persists", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with gitignore (sets gitignoreManaged: true)
    await service.init(repoPath, { includeGitignore: true });

    // Upgrade with explicit opt-out
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, {
      includeGitignore: false,
    });

    assertEquals(result.gitignoreAction, "skipped");

    // Marker should persist the opt-out
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, false);
  });
});

Deno.test("RepoService.upgrade without flag honors marker gitignoreManaged true", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with gitignore (sets gitignoreManaged: true)
    await service.init(repoPath, { includeGitignore: true });

    // Upgrade without specifying flag — should honor marker
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "unchanged");
  });
});

Deno.test("RepoService.upgrade without flag and no marker gitignoreManaged skips", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init without gitignore (no gitignoreManaged in marker)
    await service.init(repoPath);

    // Upgrade without specifying flag — should skip
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "skipped");
  });
});

// Kiro tool tests

Deno.test("RepoService.init with kiro creates .kiro/skills/ and steering file with frontmatter", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "kiro" });

    assertEquals(result.tool, "kiro");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, true);

    // Check skills copied to .kiro/skills/
    const skillsDir = join(tempDir, ".kiro", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Check steering file with frontmatter
    const steeringPath = join(
      tempDir,
      ".kiro",
      "steering",
      "swamp-rules.md",
    );
    const content = await Deno.readTextFile(steeringPath);
    assertStringIncludes(content, "---\ninclusion: always\n---");
    assertStringIncludes(content, "swamp");
    assertStringIncludes(content, "## Skills");

    // Check .vscode/settings.local.json created with trusted commands
    const settingsPath = join(tempDir, ".vscode", "settings.local.json");
    const settingsContent = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(settingsContent);
    assertEquals(
      Array.isArray(settings["kiroAgent.trustedCommands"]),
      true,
    );
    assertStringIncludes(
      JSON.stringify(settings["kiroAgent.trustedCommands"]),
      "swamp *",
    );
  });
});

Deno.test("RepoService.upgrade allows switching to kiro and creates steering file", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to kiro
    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "kiro" });

    assertEquals(result.tool, "kiro");
    assertEquals(result.settingsUpdated, true);

    // Verify skills exist in kiro dir
    const skillsDir = join(tempDir, ".kiro", "skills");
    const stat = await Deno.stat(skillsDir);
    assertEquals(stat.isDirectory, true);

    // Verify marker updated with new tool
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.tool, "kiro");

    // Verify steering file created
    const steeringPath = join(
      tempDir,
      ".kiro",
      "steering",
      "swamp-rules.md",
    );
    const content = await Deno.readTextFile(steeringPath);
    assertStringIncludes(content, "inclusion: always");

    // Verify kiro settings created
    const settingsPath = join(tempDir, ".vscode", "settings.local.json");
    const settingsContent = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(settingsContent);
    assertStringIncludes(
      JSON.stringify(settings["kiroAgent.trustedCommands"]),
      "swamp *",
    );
  });
});

Deno.test("RepoService.init with kiro does not create claude settings", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "kiro" });

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

Deno.test("RepoService.init kiro gitignore contains .kiro/skills/ when opted in", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "kiro", includeGitignore: true });

    const gitignorePath = join(tempDir, ".gitignore");
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".kiro/skills/");
    assertStringIncludes(content, "# Kiro skills (managed by swamp)");
    assertStringIncludes(content, ".swamp/telemetry/");
  });
});

// Cursor audit hook tests

Deno.test("RepoService.init with cursor creates .cursor/hooks.json", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "cursor" });

    assertEquals(result.tool, "cursor");
    assertEquals(result.settingsCreated, true);

    const hooksPath = join(tempDir, ".cursor", "hooks.json");
    const content = await Deno.readTextFile(hooksPath);
    const hooks = JSON.parse(content);
    assertEquals(hooks.version, 1);
    assertStringIncludes(
      JSON.stringify(hooks.hooks.postToolUse),
      "swamp audit record --from-hook --tool cursor",
    );
    assertStringIncludes(
      JSON.stringify(hooks.hooks.postToolUseFailure),
      "swamp audit record --from-hook --tool cursor",
    );
  });
});

Deno.test("RepoService.init with cursor force reinit merges hooks", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // First init creates hooks
    await service.init(repoPath, { tool: "cursor" });

    // Add a custom hook to existing file
    const hooksPath = join(tempDir, ".cursor", "hooks.json");
    const existing = JSON.parse(await Deno.readTextFile(hooksPath));
    existing.hooks.postToolUse.push({ command: "my-custom-hook" });
    await Deno.writeTextFile(hooksPath, JSON.stringify(existing, null, 2));

    // Force reinit should merge, not overwrite
    await service.init(repoPath, { tool: "cursor", force: true });

    const content = JSON.parse(await Deno.readTextFile(hooksPath));
    // Both our hook and the custom hook should be present
    assertEquals(content.hooks.postToolUse.length, 2);
    assertStringIncludes(
      JSON.stringify(content.hooks.postToolUse),
      "my-custom-hook",
    );
    assertStringIncludes(
      JSON.stringify(content.hooks.postToolUse),
      "swamp audit record --from-hook --tool cursor",
    );
  });
});

Deno.test("RepoService.upgrade with cursor updates hooks", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "cursor" });

    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "cursor" });

    assertEquals(result.tool, "cursor");

    const hooksPath = join(tempDir, ".cursor", "hooks.json");
    const content = await Deno.readTextFile(hooksPath);
    const hooks = JSON.parse(content);
    assertStringIncludes(
      JSON.stringify(hooks.hooks.postToolUse),
      "swamp audit record --from-hook --tool cursor",
    );
  });
});

// Kiro audit hook tests

Deno.test("RepoService.init with kiro creates .kiro/hooks/swamp-audit.json", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "kiro" });

    assertEquals(result.settingsCreated, true);

    const hookPath = join(tempDir, ".kiro", "hooks", "swamp-audit.json");
    const content = await Deno.readTextFile(hookPath);
    const hook = JSON.parse(content);
    assertEquals(hook.name, "Swamp Audit");
    assertEquals(hook.when.type, "postToolUse");
    assertEquals(hook.then.type, "runCommand");
    assertStringIncludes(
      hook.then.command,
      "swamp audit record --from-hook --tool kiro",
    );

    // Also verify .vscode/settings.local.json was created
    const settingsPath = join(tempDir, ".vscode", "settings.local.json");
    const settingsContent = await Deno.readTextFile(settingsPath);
    const settings = JSON.parse(settingsContent);
    assertStringIncludes(
      JSON.stringify(settings["kiroAgent.trustedCommands"]),
      "swamp *",
    );
  });
});

Deno.test("RepoService.upgrade with kiro updates hooks", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "kiro" });

    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "kiro" });

    assertEquals(result.tool, "kiro");

    const hookPath = join(tempDir, ".kiro", "hooks", "swamp-audit.json");
    const content = await Deno.readTextFile(hookPath);
    const hook = JSON.parse(content);
    assertStringIncludes(
      hook.then.command,
      "swamp audit record --from-hook --tool kiro",
    );
  });
});

// OpenCode audit plugin tests

Deno.test("RepoService.init with opencode creates .opencode/plugins/swamp-audit.ts", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tool: "opencode" });

    assertEquals(result.tool, "opencode");
    assertEquals(result.settingsCreated, true);

    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    const content = await Deno.readTextFile(pluginPath);
    assertStringIncludes(content, "SwampAudit");
    assertStringIncludes(content, "tool.execute.before");
    assertStringIncludes(content, "tool.execute.after");
    assertStringIncludes(content, '"--from-hook"');
    assertStringIncludes(content, '"opencode"');
  });
});

Deno.test("RepoService.upgrade with opencode updates plugin", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tool: "opencode" });

    const upgradeService = new RepoService("0.2.0");
    const result = await upgradeService.upgrade(repoPath, { tool: "opencode" });

    assertEquals(result.tool, "opencode");

    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    const content = await Deno.readTextFile(pluginPath);
    assertStringIncludes(content, '"--from-hook"');
    assertStringIncludes(content, '"opencode"');
  });
});

Deno.test("RepoService.init with opencode force reinit overwrites plugin", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    // First init
    await service.init(repoPath, { tool: "opencode" });

    // Modify the plugin
    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    await Deno.writeTextFile(pluginPath, "// custom content");

    // Force reinit should overwrite the managed plugin
    await service.init(repoPath, { tool: "opencode", force: true });

    const content = await Deno.readTextFile(pluginPath);
    assertStringIncludes(content, '"--from-hook"');
    assertStringIncludes(content, '"opencode"');
  });
});
