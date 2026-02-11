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

    // Check marker file exists
    const markerPath = join(tempDir, ".swamp.yaml");
    const stat = await Deno.stat(markerPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("RepoService.init creates CLAUDE.md", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.claudeMdCreated, true);

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

    assertEquals(result.claudeMdCreated, false);

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

Deno.test("RepoService.init creates settings.local.json", async () => {
  await withTempDir(async (tempDir) => {
    const service = new RepoService("0.1.0");
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.claudeSettingsCreated, true);

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

    assertEquals(result.claudeSettingsCreated, false);

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

    assertEquals(result.claudeSettingsUpdated, true);

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

    assertEquals(result.claudeSettingsUpdated, true);

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

    assertEquals(result.claudeSettingsUpdated, false);
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
