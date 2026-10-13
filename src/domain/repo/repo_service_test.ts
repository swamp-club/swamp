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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import {
  detectLocalBundledSkills,
  detectSupersededSkills,
  removeLocalBundledSkills,
  RepoService,
} from "./repo_service.ts";
import { RepoPath } from "./repo_path.ts";
import { SKILL_DIRS } from "./skill_dirs.ts";
import { SUPERSEDED_SKILLS, supersededSkillDirs } from "./superseded_skills.ts";
import { UserError } from "../errors.ts";
import { BRIEF_HEADER } from "../start/brief.ts";
import { normalizeHookInput } from "../audit/hook_input.ts";
import {
  type AiTool,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { writeCustomTools } from "../../infrastructure/persistence/custom_tools_repository.ts";
import { VaultConfig } from "../vaults/vault_config.ts";
import type { DefaultVaultStore } from "../vaults/default_vault.ts";

// init/upgrade install bundled skills into the user's home and config
// directories. Test files share one process and one `Deno.env`, so a write
// rooted in the ambient HOME both clobbers the developer's real
// ~/.claude/skills and races with tests that repoint HOME at a temp
// directory they are about to delete. Root those writes in the caller's
// temp directory instead.
function testService(version: string, tempDir: string): RepoService {
  const homeDir = join(tempDir, "test-home");
  return new RepoService(version, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  });
}

// Helper to create a temp directory for testing
async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_repo_test_" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("RepoService.init creates marker file", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.version, "0.1.0");
    assertEquals(result.path, tempDir);
    assertEquals(result.tools[0], "claude");

    // Check marker file exists
    const markerPath = join(tempDir, ".swamp.yaml");
    const stat = await Deno.stat(markerPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("RepoService.init creates CLAUDE.md with section markers", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.instructionsFileCreated, true);

    // Check CLAUDE.md exists with markers
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(content, "swamp");
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");
  });
});

Deno.test("RepoService.init merges managed section into existing CLAUDE.md", async () => {
  await withTempDir(async (tempDir) => {
    // Create existing CLAUDE.md with user content
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    await Deno.writeTextFile(claudeMdPath, "# Existing Content\n");

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.instructionsFileCreated, true);

    // Check managed section was prepended and user content preserved
    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");
    assertStringIncludes(content, "# Existing Content");
  });
});

Deno.test("RepoService.init copies skills", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.skillsCopied.length > 0, true);
    assertEquals(result.skillsCopied.includes("swamp"), true);

    // Skills should NOT be in the repo-local dir
    const localSkillsDir = join(tempDir, ".claude", "skills");
    const localExists = await Deno.stat(localSkillsDir).then(() => true).catch(
      () => false,
    );
    assertEquals(localExists, false);
  });
});

Deno.test("RepoService.init roots global skills in the injected user dirs", async () => {
  await withTempDir(async (tempDir) => {
    const homeDir = join(tempDir, "test-home");
    const configDir = join(homeDir, ".config", "swamp");
    const service = new RepoService("0.1.0", { homeDir, configDir });

    await service.init(RepoPath.create(tempDir), { tools: ["claude"] });

    const globalSkillsDir = join(homeDir, ".claude", "skills");
    const skill = await Deno.stat(join(globalSkillsDir, "swamp", "SKILL.md"));
    assertEquals(skill.isFile, true);

    // The registry records only the injected dir. If the ambient HOME leaked
    // in, this is where it would show up — and the suite shares one process
    // and one Deno.env, so an ambient-home write races every test that
    // repoints HOME at a temp directory it is about to delete.
    const registry = JSON.parse(
      await Deno.readTextFile(join(configDir, "builtin-tool-skill-dirs.json")),
    );
    assertEquals(registry, [globalSkillsDir]);
  });
});

Deno.test("RepoService.init creates data directory structure", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Check top-level directories exist
    const topLevelDirs = [
      "models",
      "workflows",
      "vaults",
    ];

    for (const dir of topLevelDirs) {
      const dirPath = join(tempDir, dir);
      const stat = await Deno.stat(dirPath);
      assertEquals(stat.isDirectory, true, `${dir} should exist`);
    }

    // Check runtime data subdirectories exist under .swamp/
    const expectedDirs = [
      ".swamp/data",
      ".swamp/outputs",
      ".swamp/workflow-runs",
      ".swamp/workflows-evaluated",
      ".swamp/definitions-evaluated",
      ".swamp/secrets",
    ];

    for (const dir of expectedDirs) {
      const dirPath = join(tempDir, dir);
      const stat = await Deno.stat(dirPath);
      assertEquals(stat.isDirectory, true, `${dir} should exist`);
    }

    // Telemetry is user-global — init must NOT scaffold a repo-local spool.
    await assertRejects(
      () => Deno.stat(join(tempDir, ".swamp/telemetry")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("RepoService.init throws if already initialized without force", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // First init
    await service.init(repoPath);

    // Second init with force
    const result = await service.init(repoPath, { force: true });

    assertEquals(result.version, "0.1.0");
  });
});

/** An in-memory DefaultVaultStore that records what init saved. */
function memoryVaultStore(
  initial: VaultConfig[] = [],
): DefaultVaultStore & { saved: VaultConfig[] } {
  const configs = [...initial];
  const saved: VaultConfig[] = [];
  return {
    saved,
    findByName: (name) =>
      Promise.resolve(configs.find((c) => c.name === name) ?? null),
    save: (config) => {
      configs.push(config);
      saved.push(config);
      return Promise.resolve();
    },
  };
}

Deno.test("RepoService.init without a vault store sets up no vault", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: [] });

    assertEquals(result.vault, null);
    assertEquals((await service.getMarker(repoPath))?.defaultVault, undefined);
  });
});

Deno.test("RepoService.init creates the default vault and makes it the default", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    const store = memoryVaultStore();

    const result = await service.init(repoPath, {
      tools: [],
      defaultVaultStore: store,
    });

    assertEquals(result.vault, {
      name: "default",
      type: "local_encryption",
      created: true,
    });
    assertEquals(store.saved.length, 1);
    assertEquals(store.saved[0].name, "default");
    assertEquals(store.saved[0].config, { auto_generate: true });
    assertEquals(
      (await service.getMarker(repoPath))?.defaultVault,
      "default",
    );
  });
});

Deno.test("RepoService.init --force keeps an existing vault named default, whatever its type", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: [] });
    const existing = VaultConfig.create(
      "existing-id",
      "default",
      "@swamp/aws-sm",
      { region: "eu-west-1" },
    );
    const store = memoryVaultStore([existing]);

    const result = await service.init(repoPath, {
      force: true,
      tools: [],
      defaultVaultStore: store,
    });

    assertEquals(result.vault, {
      name: "default",
      type: "@swamp/aws-sm",
      created: false,
    });
    assertEquals(store.saved, []);
    assertEquals(
      (await service.getMarker(repoPath))?.defaultVault,
      "default",
    );
  });
});

Deno.test("RepoService.init --force keeps the defaultVault already recorded", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: [] });
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    await markerRepo.write(repoPath, { ...marker!, defaultVault: "prod" });

    const result = await service.init(repoPath, {
      force: true,
      tools: [],
      defaultVaultStore: memoryVaultStore(),
    });

    assertEquals(result.vault?.created, true);
    assertEquals((await service.getMarker(repoPath))?.defaultVault, "prod");
  });
});

Deno.test("RepoService.init --force without a recorded defaultVault records default", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: [] });

    await service.init(repoPath, {
      force: true,
      tools: [],
      defaultVaultStore: memoryVaultStore(),
    });

    assertEquals(
      (await service.getMarker(repoPath))?.defaultVault,
      "default",
    );
  });
});

Deno.test("RepoService.init writes no marker when the default vault cannot be saved", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    const store: DefaultVaultStore = {
      findByName: () => Promise.resolve(null),
      save: () => Promise.reject(new Error("disk full")),
    };

    await assertRejects(
      () => service.init(repoPath, { tools: [], defaultVaultStore: store }),
      Error,
      "disk full",
    );
    assertEquals(await service.isInitialized(repoPath), false);
  });
});

Deno.test("RepoService.init creates directory if not exists", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const newDir = join(tempDir, "new-repo");
    const repoPath = RepoPath.create(newDir);

    await service.init(repoPath);

    const stat = await Deno.stat(newDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("RepoService.isInitialized returns false for empty dir", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.isInitialized(repoPath);

    assertEquals(result, false);
  });
});

Deno.test("RepoService.isInitialized returns true after init", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);
    const result = await service.isInitialized(repoPath);

    assertEquals(result, true);
  });
});

Deno.test("RepoService.upgrade throws on non-initialized repo", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
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
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Upgrade with new version
    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.previousVersion, "0.1.0");
    assertEquals(result.newVersion, "0.2.0");
    assertEquals(result.skillsUpdated.length > 0, true);
  });
});

Deno.test("RepoService.getMarker returns null for non-initialized", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const marker = await service.getMarker(repoPath);

    assertEquals(marker, null);
  });
});

Deno.test("RepoService.getMarker returns data after init", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);
    const marker = await service.getMarker(repoPath);

    assertEquals(marker !== null, true);
    assertEquals(marker!.swampVersion, "0.1.0");
  });
});

Deno.test("RepoService.init creates settings.local.json for claude", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
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

    const service = testService("0.1.0", tempDir);
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
    const oldService = testService("0.1.0", tempDir);
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
    const newService = testService("0.2.0", tempDir);
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
      "Bash(swamp vault get:*)",
    );
  });
});

Deno.test("RepoService.upgrade creates settings if they do not exist", async () => {
  await withTempDir(async (tempDir) => {
    // Init first
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Remove settings file
    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    await Deno.remove(settingsPath);

    // Upgrade
    const newService = testService("0.2.0", tempDir);
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
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Upgrade immediately (settings already have all permissions)
    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, false);
  });
});

Deno.test("RepoService.upgrade includes .swamp.yaml in changedFiles", async () => {
  await withTempDir(async (tempDir) => {
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.changedFiles.includes(".swamp.yaml"), true);
  });
});

Deno.test("RepoService.upgrade includes CLAUDE.md in changedFiles when instructions change", async () => {
  await withTempDir(async (tempDir) => {
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Remove CLAUDE.md so the upgrade recreates it
    await Deno.remove(join(tempDir, "CLAUDE.md"));

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);
    assertEquals(result.changedFiles.includes("CLAUDE.md"), true);
  });
});

Deno.test("RepoService.upgrade includes settings file in changedFiles when settings change", async () => {
  await withTempDir(async (tempDir) => {
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Remove settings so the upgrade recreates them
    await Deno.remove(join(tempDir, ".claude", "settings.local.json"));

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, true);
    assertEquals(
      result.changedFiles.includes(".claude/settings.local.json"),
      true,
    );
  });
});

Deno.test("RepoService.upgrade omits settings from changedFiles when unchanged", async () => {
  await withTempDir(async (tempDir) => {
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(
      result.changedFiles.includes(".claude/settings.local.json"),
      false,
    );
  });
});

// Audit hook merging (swamp-club#2881): an existing audit hook in any form
// counts as present, so upgrade never wires a second one beside it.

const CLAUDE_AUDIT = "swamp audit record --from-hook";
const BACKGROUNDED_AUDIT =
  "payload=$(cat); (printf '%s' \"$payload\" | swamp audit record --from-hook >/dev/null 2>&1 &)";

function claudeEntry(
  command: string,
  matcher: unknown = "Bash",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { matcher, hooks: [{ type: "command", command, ...extra }] };
}

const CLAUDE_SWAMP_ENTRY = claudeEntry(CLAUDE_AUDIT);

/**
 * Inits a Claude repo, replaces its hooks, then runs `act` (an upgrade by
 * default) and a second upgrade, returning the hooks after each.
 */
async function claudeHooksAfterUpgrade(
  hooks: unknown,
  act?: (repoPath: RepoPath, tempDir: string) => Promise<unknown>,
): Promise<{
  first: Record<string, unknown[]>;
  second: Record<string, unknown[]>;
  secondUpdated: boolean;
}> {
  let result!: {
    first: Record<string, unknown[]>;
    second: Record<string, unknown[]>;
    secondUpdated: boolean;
  };
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath);
    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const settings = JSON.parse(await Deno.readTextFile(settingsPath));
    settings.hooks = hooks;
    await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));

    await (act
      ? act(repoPath, tempDir)
      : testService("0.2.0", tempDir).upgrade(repoPath));
    const first = JSON.parse(await Deno.readTextFile(settingsPath)).hooks;
    const again = await testService("0.2.0", tempDir).upgrade(repoPath);
    const second = JSON.parse(await Deno.readTextFile(settingsPath)).hooks;
    result = { first, second, secondUpdated: again.settingsUpdated };
  });
  return result;
}

Deno.test("RepoService.upgrade keeps an existing backgrounded Claude audit hook without adding swamp's", async () => {
  const hooks = {
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT)],
    PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT)],
  };
  const { first, secondUpdated } = await claudeHooksAfterUpgrade(hooks);
  assertEquals(first, hooks);
  assertEquals(secondUpdated, false);
});

Deno.test("RepoService.upgrade removes swamp's Claude audit hook added beside a user variant", async () => {
  const { first, second, secondUpdated } = await claudeHooksAfterUpgrade({
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT), CLAUDE_SWAMP_ENTRY],
    PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT), CLAUDE_SWAMP_ENTRY],
  });
  const repaired = {
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT)],
    PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT)],
  };
  assertEquals(first, repaired);
  assertEquals(second, repaired);
  assertEquals(secondUpdated, false);
});

Deno.test("RepoService.init with force removes swamp's Claude audit hook added beside a user variant", async () => {
  const { first } = await claudeHooksAfterUpgrade(
    {
      PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT), CLAUDE_SWAMP_ENTRY],
      PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT), CLAUDE_SWAMP_ENTRY],
    },
    (repoPath, tempDir) =>
      testService("0.2.0", tempDir).init(repoPath, {
        tools: ["claude"],
        force: true,
      }),
  );
  assertEquals(first, {
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT)],
    PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT)],
  });
});

Deno.test("RepoService.upgrade does not duplicate a Claude audit hook that has extra fields", async () => {
  const hooks = {
    PostToolUse: [claudeEntry(CLAUDE_AUDIT, "Bash", { timeout: 5 })],
    PostToolUseFailure: [claudeEntry(CLAUDE_AUDIT, "Bash", { timeout: 5 })],
  };
  assertEquals((await claudeHooksAfterUpgrade(hooks)).first, hooks);
});

Deno.test("RepoService.upgrade treats a Claude audit hook under matcher * as present", async () => {
  const hooks = {
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT, "*")],
    PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT, "Bash|Edit")],
  };
  assertEquals((await claudeHooksAfterUpgrade(hooks)).first, hooks);
});

Deno.test("RepoService.upgrade treats a Claude audit hook under a matcher list or unanchored regex as present", async () => {
  for (const matcher of ["Bash, Edit", "Edit | Bash", "^Bas", "B.sh"]) {
    const hooks = {
      PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT, matcher)],
      PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT, matcher)],
    };
    assertEquals((await claudeHooksAfterUpgrade(hooks)).first, hooks);
  }
});

Deno.test("RepoService.upgrade adds swamp's Claude audit hook when a matcher list names other tools", async () => {
  for (const matcher of ["Bashful", "Edit, Write", "Bas"]) {
    const { first } = await claudeHooksAfterUpgrade({
      PostToolUse: [claudeEntry(CLAUDE_AUDIT, matcher)],
      PostToolUseFailure: [claudeEntry(CLAUDE_AUDIT, matcher)],
    });
    assertEquals(first.PostToolUse, [
      claudeEntry(CLAUDE_AUDIT, matcher),
      CLAUDE_SWAMP_ENTRY,
    ]);
  }
});

Deno.test("RepoService.upgrade adds swamp's Claude audit hook when the only one does not match Bash", async () => {
  const { first } = await claudeHooksAfterUpgrade({
    PostToolUse: [claudeEntry(CLAUDE_AUDIT, "Edit")],
    PostToolUseFailure: [claudeEntry(CLAUDE_AUDIT, "Edit")],
  });
  assertEquals(first.PostToolUse, [
    claudeEntry(CLAUDE_AUDIT, "Edit"),
    CLAUDE_SWAMP_ENTRY,
  ]);
});

Deno.test("RepoService.upgrade keeps unrelated Claude hooks in order", async () => {
  const formatter = claudeEntry("prettier --write", "Edit|Write");
  const { first } = await claudeHooksAfterUpgrade({
    PostToolUse: [
      formatter,
      claudeEntry(BACKGROUNDED_AUDIT),
      CLAUDE_SWAMP_ENTRY,
    ],
    PostToolUseFailure: [CLAUDE_SWAMP_ENTRY, CLAUDE_SWAMP_ENTRY],
    Stop: [formatter],
  });
  assertEquals(first, {
    PostToolUse: [formatter, claudeEntry(BACKGROUNDED_AUDIT)],
    PostToolUseFailure: [CLAUDE_SWAMP_ENTRY],
    Stop: [formatter],
  });
});

Deno.test("RepoService.upgrade passes malformed Claude hook entries through", async () => {
  const malformed = [
    "junk",
    null,
    { matcher: "Bash", hooks: "not-a-list" },
    { matcher: 7, hooks: [{ command: 3 }] },
  ];
  const { first } = await claudeHooksAfterUpgrade({
    PostToolUse: malformed,
    PostToolUseFailure: "not-a-list",
  });
  assertEquals(first, {
    PostToolUse: [...malformed, CLAUDE_SWAMP_ENTRY],
    PostToolUseFailure: [CLAUDE_SWAMP_ENTRY],
  });
});

for (
  const { tool, file, swampEntry } of [
    {
      tool: "cursor",
      file: [".cursor", "hooks.json"],
      swampEntry: { command: "swamp audit record --from-hook --tool cursor" },
    },
    {
      tool: "copilot",
      file: [".github", "hooks", "swamp-audit.json"],
      swampEntry: {
        type: "command",
        command: "swamp audit record --from-hook --tool copilot",
      },
    },
  ]
) {
  const variant = { ...swampEntry, timeout: 5 };

  const hooksAfterUpgrade = async (hooks: unknown) => {
    let result!: {
      first: Record<string, unknown[]>;
      second: Record<string, unknown[]>;
    };
    await withTempDir(async (tempDir) => {
      const repoPath = RepoPath.create(tempDir);
      await testService("0.1.0", tempDir).init(repoPath, { tools: [tool] });
      const hooksPath = join(tempDir, ...file);
      await Deno.writeTextFile(
        hooksPath,
        JSON.stringify({ version: 1, hooks }, null, 2),
      );
      await testService("0.2.0", tempDir).upgrade(repoPath);
      const first = JSON.parse(await Deno.readTextFile(hooksPath)).hooks;
      await testService("0.2.0", tempDir).upgrade(repoPath);
      const second = JSON.parse(await Deno.readTextFile(hooksPath)).hooks;
      result = { first, second };
    });
    return result;
  };

  Deno.test(`RepoService.upgrade keeps an existing ${tool} audit hook variant without adding swamp's`, async () => {
    const hooks = { postToolUse: [variant], postToolUseFailure: [variant] };
    assertEquals((await hooksAfterUpgrade(hooks)).first, hooks);
  });

  Deno.test(`RepoService.upgrade removes swamp's ${tool} audit hook added beside a user variant`, async () => {
    const { first, second } = await hooksAfterUpgrade({
      postToolUse: [variant, swampEntry],
      postToolUseFailure: [swampEntry, variant],
    });
    const repaired = { postToolUse: [variant], postToolUseFailure: [variant] };
    assertEquals(first, repaired);
    assertEquals(second, repaired);
  });

  Deno.test(`RepoService.upgrade leaves swamp's ${tool} audit hook and unrelated hooks unchanged`, async () => {
    const other = { command: "echo done" };
    const hooks = {
      postToolUse: [other, swampEntry],
      postToolUseFailure: [swampEntry],
      stop: [other],
    };
    assertEquals((await hooksAfterUpgrade(hooks)).first, hooks);
  });

  Deno.test(`RepoService.upgrade passes malformed ${tool} hook entries through`, async () => {
    const malformed = ["junk", null, { command: 3 }];
    const { first } = await hooksAfterUpgrade({
      postToolUse: malformed,
      postToolUseFailure: [swampEntry],
    });
    assertEquals(first, {
      postToolUse: [...malformed, swampEntry],
      postToolUseFailure: [swampEntry],
    });
  });
}

Deno.test("RepoService.upgrade includes .gitignore in changedFiles when managed", async () => {
  await withTempDir(async (tempDir) => {
    const oldService = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await oldService.init(repoPath);

    // Enable gitignore management via first upgrade, then remove the file
    const midService = testService("0.1.1", tempDir);
    await midService.upgrade(repoPath, { includeGitignore: true });
    await Deno.remove(join(tempDir, ".gitignore"));

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.changedFiles.includes(".gitignore"), true);
  });
});

Deno.test("RepoService.init generates CLAUDE.md with skills section", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);

    assertStringIncludes(content, "## Skills");
    assertStringIncludes(content, "`swamp`");
    assertStringIncludes(content, "plan mode");
  });
});

Deno.test("RepoService.init: instruction rule points agents at the swamp start brief header", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["claude", "codex"] });

    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const content = await Deno.readTextFile(join(tempDir, file));
      assertStringIncludes(content, `\`${BRIEF_HEADER}\``, file);
      assertStringIncludes(content, "task brief under `tasks/`", file);
      assert(!content.includes("TASK.md"), file);
      assertStringIncludes(content, "brief entry point", file);
    }
  });
});

Deno.test("RepoService.init generates CLAUDE.md with extension search guidance", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);

    assertStringIncludes(content, "extension search");
    assertStringIncludes(content, "Search before you build");
    assertStringIncludes(content, "swamp model type search");
  });
});

Deno.test("RepoService.init generates CLAUDE.md disambiguating workflow to swamp workflow", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);

    assertStringIncludes(content, '"Workflow" means a swamp workflow');
    assertStringIncludes(content, "swamp workflow create");
    assertStringIncludes(content, "do the work yourself step by step");
  });
});

Deno.test("RepoService.init generates CLAUDE.md with anti-bypass guidance", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const content = await Deno.readTextFile(claudeMdPath);

    assertStringIncludes(content, "Use swamp, don't bypass it");
    assertStringIncludes(content, "swamp data query");
    assertStringIncludes(content, "swamp model type search");
    assertStringIncludes(
      content,
      "the anti-pattern is bypassing swamp entirely",
    );
  });
});

/** Returns the body of the managed `## Getting Started` section. */
function gettingStartedSection(content: string): string {
  const start = content.indexOf("## Getting Started");
  const end = content.indexOf("## Commands", start);
  return content.substring(start, end);
}

Deno.test("RepoService.init generates CLAUDE.md without a session-start model search", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const content = await Deno.readTextFile(join(tempDir, "CLAUDE.md"));
    const section = gettingStartedSection(content);

    assertEquals(content.includes("At the start of every conversation"), false);
    assertEquals(section.includes("swamp model search"), false);
    assertStringIncludes(section, "invoke the\n`swamp-getting-started` skill");
    assertStringIncludes(section, "use the `swamp` skill");
  });
});

Deno.test("RepoService.init: path-style custom tool instructions point at getting-started without a session-start model search", async () => {
  await withTempDir(async (tempDir) => {
    await writeCustomTools(tempDir, [{
      name: "myagent",
      skillsDir: ".myagent/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["myagent"] });

    const content = await Deno.readTextFile(join(tempDir, "AGENTS.md"));
    const section = gettingStartedSection(content);

    assertEquals(content.includes("At the start of every conversation"), false);
    assertEquals(section.includes("swamp model search"), false);
    assertStringIncludes(
      section,
      "`.myagent/skills/swamp-getting-started/SKILL.md`",
    );
    assertStringIncludes(section, "`.myagent/skills/swamp/SKILL.md`");
  });
});

Deno.test("RepoService.upgrade replaces the old session-start model search instruction", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Swap the current Getting Started body for the pre-#3206 wording
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const current = await Deno.readTextFile(claudeMdPath);
    const section = gettingStartedSection(current);
    const legacy = current.replace(
      section,
      `## Getting Started

**IMPORTANT:** At the start of every conversation, run
\`swamp model search --json\`. If no models are returned (empty result), you MUST
immediately invoke the \`swamp-getting-started\` skill before doing anything else.
This walks new users through an interactive onboarding tutorial.

If models already exist, start by using the \`swamp\` skill to work with
swamp models.

`,
    );
    await Deno.writeTextFile(claudeMdPath, legacy);

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);
    const upgraded = await Deno.readTextFile(claudeMdPath);
    assertEquals(
      upgraded.includes("At the start of every conversation"),
      false,
    );
    assertEquals(gettingStartedSection(upgraded), section);
  });
});

Deno.test("RepoService.init always creates .gitignore with managed section", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.gitignoreAction, "created");

    // .gitignore should exist with managed section
    const gitignorePath = join(tempDir, ".gitignore");
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, "# END swamp managed section");
    assertStringIncludes(content, ".swamp/");
    assertStringIncludes(content, ".swamp-sources.yaml");
    assertStringIncludes(content, ".claude/worktrees/");
    assertStringIncludes(content, ".claude/settings.local.json");
    assertStringIncludes(content, ".claude/scheduled_tasks.lock");
    assertStringIncludes(content, ".claude/scheduled_tasks.json");
    assertEquals(content.split("\n").includes(".claude/"), false);

    // Check marker persists the preference
    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, true);
  });
});

Deno.test("RepoService.init sets gitignoreManaged in marker", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Check marker persists the preference for future upgrades
    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, true);
  });
});

Deno.test("RepoService.init appends managed section to existing .gitignore", async () => {
  await withTempDir(async (tempDir) => {
    // Create existing .gitignore
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(
      gitignorePath,
      "# My existing gitignore\nnode_modules/\n",
    );

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.gitignoreAction, "updated");

    // Check user content is preserved and managed section is appended
    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, "# My existing gitignore");
    assertStringIncludes(content, "node_modules/");
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, ".swamp/");
    assertStringIncludes(content, "# END swamp managed section");
  });
});

Deno.test("RepoService.init with force returns unchanged when section is current", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // First init creates .gitignore with managed section
    await service.init(repoPath);

    // Second init with force — section already matches
    const result = await service.init(repoPath, {
      force: true,
    });

    assertEquals(result.gitignoreAction, "unchanged");
  });
});

// Multi-tool tests

Deno.test("RepoService.init with cursor creates .cursor/skills/ and .cursor/rules/swamp.mdc", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["cursor"] });

    assertEquals(result.tools[0], "cursor");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, true);
    assertEquals(result.gitignoreAction, "created");

    // Skills are now installed globally, not in repo
    assertEquals(result.skillsCopied.includes("swamp"), true);

    // Check instructions file is .cursor/rules/swamp.mdc with MDC frontmatter at byte 0
    const mdcPath = join(tempDir, ".cursor", "rules", "swamp.mdc");
    const content = await Deno.readTextFile(mdcPath);
    assertEquals(content.startsWith("---\n"), true);
    assertStringIncludes(content, "alwaysApply: true");
    assertStringIncludes(content, "swamp");
    assertStringIncludes(content, "## Skills");
    assertStringIncludes(content, "<!-- BEGIN swamp managed section");

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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["opencode"] });

    assertEquals(result.tools[0], "opencode");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, true);
    assertEquals(result.gitignoreAction, "created");

    // Skills are now installed globally, not in repo
    assertEquals(result.skillsCopied.includes("swamp"), true);

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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["codex"] });

    assertEquals(result.tools[0], "codex");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, false);
    assertEquals(result.gitignoreAction, "created");

    // Skills are now installed globally, not in repo
    assertEquals(result.skillsCopied.includes("swamp"), true);

    // Check AGENTS.md created
    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(content, "swamp");
  });
});

Deno.test("RepoService.init with copilot creates .agents/skills/, AGENTS.md, and .github/hooks/", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["copilot"] });

    assertEquals(result.tools[0], "copilot");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, true);
    assertEquals(result.gitignoreAction, "created");

    // Skills are now installed globally, not in repo
    assertEquals(result.skillsCopied.includes("swamp"), true);

    // Check AGENTS.md created with section markers (shared file)
    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(content, "swamp");
    assertStringIncludes(content, "## Skills");

    // Check .github/hooks/swamp-audit.json created
    const hooksPath = join(tempDir, ".github", "hooks", "swamp-audit.json");
    const hooksContent = await Deno.readTextFile(hooksPath);
    const hooks = JSON.parse(hooksContent);
    assertEquals(hooks.version, 1);
    assertStringIncludes(
      JSON.stringify(hooks),
      "swamp audit record --from-hook --tool copilot",
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

Deno.test("RepoService.init stores tool in marker", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["cursor"] });

    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.tools?.[0], "cursor");
  });
});

Deno.test("RepoService.init stores serverAddress in marker", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, {
      serverAddress: "wss://team-serve.internal:4000",
    });

    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.serverAddress, "wss://team-serve.internal:4000");
  });
});

Deno.test("RepoService.init refuses a credential-bearing serverAddress before touching the filesystem", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoDir = join(tempDir, "repo");
    const repoPath = RepoPath.create(repoDir);

    const error = await assertRejects(
      () =>
        service.init(repoPath, {
          tools: [],
          serverAddress:
            "https://zz9user:zz9password@serve.example.com/base?token=zz9token",
        }),
      UserError,
      "Refusing to store the --server URL 'https://serve.example.com/base'",
    );
    assertEquals(error.message.includes("zz9"), false);

    const repoDirExists = await Deno.stat(repoDir).then(
      () => true,
      () => false,
    );
    assertEquals(repoDirExists, false);
  });
});

Deno.test("RepoService.init --force with a credential-bearing serverAddress leaves the existing marker unchanged", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, {
      tools: [],
      serverAddress: "wss://team-serve.internal:4000",
    });
    const markerPath = join(tempDir, ".swamp.yaml");
    const before = await Deno.readTextFile(markerPath);

    await assertRejects(
      () =>
        service.init(repoPath, {
          force: true,
          tools: [],
          serverAddress: "wss://team-serve.internal:4000/?token=zz9token",
        }),
      UserError,
    );

    assertEquals(await Deno.readTextFile(markerPath), before);
  });
});

Deno.test("RepoService.init omits serverAddress when not provided", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    const marker = await service.getMarker(repoPath);
    assertEquals(marker!.serverAddress, undefined);
  });
});

Deno.test("RepoService.upgrade reads tool from marker", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with cursor
    await service.init(repoPath, { tools: ["cursor"] });

    // Upgrade without specifying tool
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.tools[0], "cursor");

    // Skills are now installed globally
    assertEquals(result.skillsUpdated.includes("swamp"), true);
  });
});

Deno.test("RepoService.upgrade allows switching tool via --tool", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to cursor
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["cursor"],
    });

    assertEquals(result.tools[0], "cursor");

    // Skills are now installed globally
    assertEquals(result.skillsUpdated.includes("swamp"), true);

    // Verify marker updated with new tool
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.tools?.[0], "cursor");

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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to codex
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, { tools: ["codex"] });

    assertEquals(result.tools[0], "codex");

    // Verify AGENTS.md created
    const instructionsPath = join(tempDir, "AGENTS.md");
    const instructionsStat = await Deno.stat(instructionsPath);
    assertEquals(instructionsStat.isFile, true);
    const content = await Deno.readTextFile(instructionsPath);
    assertStringIncludes(content, "# Project");
    assertStringIncludes(content, "swamp");
  });
});

Deno.test("RepoService.upgrade creates AGENTS.md when switching to copilot", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to copilot
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["copilot"],
    });

    assertEquals(result.tools[0], "copilot");

    // Verify AGENTS.md created
    const instructionsPath = join(tempDir, "AGENTS.md");
    const instructionsStat = await Deno.stat(instructionsPath);
    assertEquals(instructionsStat.isFile, true);
    const content = await Deno.readTextFile(instructionsPath);
    assertStringIncludes(content, "# Project");
    assertStringIncludes(content, "swamp");
  });
});

Deno.test("RepoService.upgrade prepends managed section when file has no swamp content", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude
    await service.init(repoPath);

    // Replace CLAUDE.md with unrelated content (no swamp signature, no markers)
    const instructionsPath = join(tempDir, "CLAUDE.md");
    await Deno.writeTextFile(instructionsPath, "# Old content\n");

    // Upgrade — should prepend managed section
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(instructionsPath);
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "# Project");
    assertStringIncludes(content, "# Old content");

    // Managed section should come before user content
    const beginIdx = content.indexOf(
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    const userIdx = content.indexOf("# Old content");
    assertEquals(beginIdx < userIdx, true);
  });
});

Deno.test("RepoService.upgrade returns instructionsUpdated false when content is current", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude — instructions file is created with markers
    await service.init(repoPath);

    // Upgrade with same version — managed section hasn't changed
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, false);

    // Verify markers are still present
    const content = await Deno.readTextFile(join(tempDir, "CLAUDE.md"));
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");
  });
});

Deno.test("RepoService.upgrade defaults to claude for pre-existing repos without tool", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with default (claude) - simulate old marker without tool field
    await service.init(repoPath);

    // Manually remove tool from marker to simulate old repo
    const markerPath = join(tempDir, ".swamp.yaml");
    const markerContent = await Deno.readTextFile(markerPath);
    const updatedMarker = markerContent.replace(/tool:.*\n/, "");
    await Deno.writeTextFile(markerPath, updatedMarker);

    // Upgrade without specifying tool
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.tools[0], "claude");
  });
});

Deno.test("RepoService.upgrade skips settings for non-claude tools", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["cursor"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.settingsUpdated, false);
  });
});

Deno.test("RepoService.upgrade manages .gitignore when marker has gitignoreManaged from init", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init always sets gitignoreManaged: true
    await service.init(repoPath);

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "unchanged");
  });
});

Deno.test("RepoService.upgrade creates .gitignore when marker has gitignoreManaged", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init creates .gitignore and sets marker
    await service.init(repoPath);
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.remove(gitignorePath);

    // Upgrade should recreate .gitignore because marker has gitignoreManaged
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "created");

    const content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, ".swamp/");
    assertStringIncludes(content, ".claude/worktrees/");
    assertStringIncludes(content, "# END swamp managed section");
  });
});

Deno.test("RepoService.upgrade returns unchanged when section is current", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init creates .gitignore with managed section
    await service.init(repoPath);

    // Upgrade — section already matches (marker has gitignoreManaged: true)
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "unchanged");
  });
});

Deno.test("RepoService.init cursor instructions have MDC frontmatter at byte 0 with managed section", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["cursor"] });

    const mdcPath = join(tempDir, ".cursor", "rules", "swamp.mdc");
    const content = await Deno.readTextFile(mdcPath);

    // Frontmatter at byte 0
    assertEquals(content.startsWith("---\n"), true);
    assertStringIncludes(content, "description: Swamp automation rules");
    assertStringIncludes(content, "alwaysApply: true");
    // Managed section markers present
    assertStringIncludes(content, "<!-- BEGIN swamp managed section");
    assertStringIncludes(content, "<!-- END swamp managed section");
  });
});

Deno.test("RepoService.init includes tool-specific gitignore entries", async () => {
  // Claude has tool-specific gitignore entries for local config files
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude"] });
    const content = await Deno.readTextFile(join(tempDir, ".gitignore"));
    assertStringIncludes(content, ".claude/worktrees/");
    assertStringIncludes(content, ".claude/settings.local.json");
    assertStringIncludes(content, ".claude/scheduled_tasks.lock");
    assertStringIncludes(content, ".claude/scheduled_tasks.json");
    // Skills must NOT be gitignored — they should be checked in
    assertEquals(content.includes(".claude/skills/"), false);
    assertStringIncludes(content, ".swamp/");
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, "# END swamp managed section");
  });

  // Non-claude tools: skills must NOT be gitignored — they should be checked in
  const toolsWithNoSkillsIgnore: AiTool[] = [
    "cursor",
    "opencode",
    "codex",
    "kiro",
  ];
  for (const tool of toolsWithNoSkillsIgnore) {
    await withTempDir(async (tempDir) => {
      const service = testService("0.1.0", tempDir);
      const repoPath = RepoPath.create(tempDir);

      await service.init(repoPath, { tools: [tool] });

      const gitignorePath = join(tempDir, ".gitignore");
      const content = await Deno.readTextFile(gitignorePath);
      assertEquals(
        content.includes("skills/"),
        false,
        `${tool} gitignore must not include skills/ — skills should be checked in`,
      );
      // All tools should have common entries within managed section
      assertStringIncludes(content, ".swamp/");
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

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude
    await service.init(repoPath);
    const gitignorePath = join(tempDir, ".gitignore");
    let content = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(content, ".claude/worktrees/");

    // Re-init with cursor (force) — cursor has no tool-specific gitignore
    const result = await service.init(repoPath, {
      force: true,
      tools: ["cursor"],
    });

    assertEquals(result.gitignoreAction, "updated");
    content = await Deno.readTextFile(gitignorePath);
    // Old tool entries should be replaced
    assertEquals(content.includes(".claude/worktrees/"), false);
    assertEquals(content.includes(".claude/settings.local.json"), false);
    // Common entries still present
    assertStringIncludes(content, ".swamp/");
  });
});

Deno.test("RepoService.upgrade updates managed section on tool switch", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude
    await service.init(repoPath);

    // Add user content after the managed section
    const gitignorePath = join(tempDir, ".gitignore");
    const original = await Deno.readTextFile(gitignorePath);
    await Deno.writeTextFile(gitignorePath, original + "*.log\n");

    // Upgrade with tool switch to cursor (marker has gitignoreManaged: true)
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["cursor"],
    });

    assertEquals(result.gitignoreAction, "updated");
    const content = await Deno.readTextFile(gitignorePath);
    // Claude-specific entries removed after tool switch
    assertEquals(content.includes(".claude/worktrees/"), false);
    // Common entries still present
    assertStringIncludes(content, ".swamp/");
    // User content after section is preserved
    assertStringIncludes(content, "*.log");
  });
});

Deno.test("RepoService.init handles .gitignore without trailing newline", async () => {
  await withTempDir(async (tempDir) => {
    const gitignorePath = join(tempDir, ".gitignore");
    await Deno.writeTextFile(gitignorePath, "node_modules/"); // no trailing newline

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

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

Deno.test("RepoService.init migrates legacy gitignore format", async () => {
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

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

    assertEquals(result.gitignoreAction, "updated");
    const content = await Deno.readTextFile(gitignorePath);
    // Legacy header should be replaced by markers
    assertEquals(content.includes("# Swamp managed defaults"), false);
    assertStringIncludes(
      content,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    assertStringIncludes(content, "# END swamp managed section");
    assertStringIncludes(content, ".swamp/");
    assertStringIncludes(content, ".claude/worktrees/");
  });
});

Deno.test("RepoService.init migrates legacy gitignore with user additions", async () => {
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

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath);

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

// Opt-in/opt-out gitignore management tests (upgrade only)

Deno.test("RepoService.upgrade with includeGitignore true opts in and persists", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Upgrade with explicit opt-in
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      includeGitignore: true,
    });

    assertEquals(result.gitignoreAction, "unchanged");

    // Marker should persist the preference
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.gitignoreManaged, true);
  });
});

Deno.test("RepoService.upgrade with includeGitignore false opts out and persists", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init (always sets gitignoreManaged: true)
    await service.init(repoPath);

    // Upgrade with explicit opt-out
    const upgradeService = testService("0.2.0", tempDir);
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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init (always sets gitignoreManaged: true)
    await service.init(repoPath);

    // Upgrade without specifying flag — should honor marker
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "unchanged");
  });
});

Deno.test("RepoService.upgrade without flag honors marker from init", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init always sets gitignoreManaged: true
    await service.init(repoPath);

    // Upgrade without specifying flag — should honor marker and manage gitignore
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.gitignoreAction, "unchanged");
  });
});

// Kiro tool tests

Deno.test("RepoService.init with kiro creates steering file with name-based skill references", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["kiro"] });

    assertEquals(result.tools[0], "kiro");
    assertEquals(result.instructionsFileCreated, true);
    assertEquals(result.settingsCreated, true);

    // Skills are now installed globally, not in repo
    assertEquals(result.skillsCopied.includes("swamp"), true);

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
    // Must use name-based references, not project-local paths
    assertStringIncludes(content, "the `swamp` skill");
    assertEquals(content.includes(".kiro/skills/swamp/SKILL.md"), false);

    // Kiro IDE 1.0 no longer reads the 0.x settings, so none are written.
    await assertRejects(
      () => Deno.stat(join(tempDir, ".vscode", "settings.local.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("RepoService.upgrade allows switching to kiro and creates steering file", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with claude (default)
    await service.init(repoPath);

    // Upgrade with tool switch to kiro
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(result.tools[0], "kiro");
    assertEquals(result.settingsUpdated, true);

    // Skills are now installed globally
    assertEquals(result.skillsUpdated.includes("swamp"), true);

    // Verify marker updated with new tool
    const marker = await upgradeService.getMarker(repoPath);
    assertEquals(marker!.tools?.[0], "kiro");

    // Verify steering file created
    const steeringPath = join(
      tempDir,
      ".kiro",
      "steering",
      "swamp-rules.md",
    );
    const content = await Deno.readTextFile(steeringPath);
    assertStringIncludes(content, "inclusion: always");

    // Verify kiro audit hook and agent config created
    assertEquals(
      result.changedFiles.includes(".kiro/hooks/swamp-audit.json"),
      true,
    );
    assertEquals(
      result.changedFiles.includes(".kiro/agents/swamp.json"),
      true,
    );
    await assertRejects(
      () => Deno.stat(join(tempDir, ".vscode", "settings.local.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("RepoService.init with kiro does not create claude settings", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["kiro"] });

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

Deno.test("RepoService.init kiro gitignore does not include skills", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["kiro"] });

    const gitignorePath = join(tempDir, ".gitignore");
    const content = await Deno.readTextFile(gitignorePath);
    assertEquals(content.includes(".kiro/skills/"), false);
    assertStringIncludes(content, ".swamp/");
  });
});

// Cursor audit hook tests

Deno.test("RepoService.init with cursor creates .cursor/hooks.json", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["cursor"] });

    assertEquals(result.tools[0], "cursor");
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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // First init creates hooks
    await service.init(repoPath, { tools: ["cursor"] });

    // Add a custom hook to existing file
    const hooksPath = join(tempDir, ".cursor", "hooks.json");
    const existing = JSON.parse(await Deno.readTextFile(hooksPath));
    existing.hooks.postToolUse.push({ command: "my-custom-hook" });
    await Deno.writeTextFile(hooksPath, JSON.stringify(existing, null, 2));

    // Force reinit should merge, not overwrite
    await service.init(repoPath, { tools: ["cursor"], force: true });

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
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["cursor"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["cursor"],
    });

    assertEquals(result.tools[0], "cursor");

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

const KIRO_AUDIT_COMMAND = "swamp audit record --from-hook --tool kiro";

// The Kiro IDE 0.x hook file earlier versions wrote.
const LEGACY_KIRO_HOOK = {
  name: "Swamp Audit",
  description: "Records agent tool usage for swamp audit tracking",
  version: "1",
  when: { type: "postToolUse", toolTypes: ["*"] },
  then: { type: "runCommand", command: KIRO_AUDIT_COMMAND, timeout: 5 },
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("RepoService.init with kiro creates .kiro/hooks/swamp-audit.json in the v1 hook schema", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["kiro"] });

    assertEquals(result.settingsCreated, true);

    const hookPath = join(tempDir, ".kiro", "hooks", "swamp-audit.json");
    assertEquals(await readJson(hookPath), {
      version: "v1",
      hooks: [{
        name: "swamp-audit",
        trigger: "PostToolUse",
        action: { type: "command", command: KIRO_AUDIT_COMMAND },
        timeout: 5,
      }],
    });
    assertEquals(
      await pathExists(
        join(tempDir, ".kiro", "hooks", "swamp-audit.kiro.hook"),
      ),
      false,
    );
  });
});

Deno.test("RepoService.upgrade with kiro is a no-op for current kiro files", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["kiro"],
    });

    assertEquals(result.tools[0], "kiro");
    assertEquals(
      result.changedFiles.filter((f) =>
        f.startsWith(".kiro/") || f.startsWith(".vscode/")
      ),
      [],
    );
  });
});

Deno.test("RepoService.upgrade with kiro replaces the legacy .kiro.hook with the v1 hook file", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const hooksDir = join(tempDir, ".kiro", "hooks");
    const legacyPath = join(hooksDir, "swamp-audit.kiro.hook");
    const newPath = join(hooksDir, "swamp-audit.json");
    await Deno.writeTextFile(legacyPath, JSON.stringify(LEGACY_KIRO_HOOK));
    await Deno.remove(newPath);

    const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["kiro"],
    });

    assertEquals(await pathExists(legacyPath), false);
    assertEquals((await readJson(newPath)).version, "v1");
    assertEquals(
      result.changedFiles.includes(".kiro/hooks/swamp-audit.kiro.hook"),
      true,
    );
    assertEquals(
      result.changedFiles.includes(".kiro/hooks/swamp-audit.json"),
      true,
    );
  });
});

Deno.test("RepoService.upgrade with kiro removes a legacy .kiro.hook that ran swamp by absolute path", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const legacyPath = join(tempDir, ".kiro", "hooks", "swamp-audit.kiro.hook");
    await Deno.writeTextFile(
      legacyPath,
      JSON.stringify({
        ...LEGACY_KIRO_HOOK,
        then: {
          ...LEGACY_KIRO_HOOK.then,
          command: "/usr/local/bin/swamp audit record --from-hook --tool kiro",
        },
      }),
    );

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(await pathExists(legacyPath), false);
  });
});

Deno.test("RepoService.upgrade with kiro keeps a legacy .kiro.hook whose audit command the user extended", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const legacyPath = join(tempDir, ".kiro", "hooks", "swamp-audit.kiro.hook");
    const extended = JSON.stringify({
      ...LEGACY_KIRO_HOOK,
      then: {
        ...LEGACY_KIRO_HOOK.then,
        command: `${KIRO_AUDIT_COMMAND} && ./notify.sh`,
      },
    });
    await Deno.writeTextFile(legacyPath, extended);

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(await Deno.readTextFile(legacyPath), extended);
  });
});

Deno.test("RepoService.upgrade with kiro keeps a swamp-audit.kiro.hook that is not swamp's", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const legacyPath = join(tempDir, ".kiro", "hooks", "swamp-audit.kiro.hook");
    const userHook = JSON.stringify({
      ...LEGACY_KIRO_HOOK,
      then: { type: "runCommand", command: "npm run lint" },
    });
    await Deno.writeTextFile(legacyPath, userHook);

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(await Deno.readTextFile(legacyPath), userHook);
  });
});

Deno.test("RepoService.upgrade with kiro overwrites a pre-#584 swamp-audit.json", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const hookPath = join(tempDir, ".kiro", "hooks", "swamp-audit.json");
    await Deno.writeTextFile(hookPath, "{}");

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals((await readJson(hookPath)).hooks[0].name, "swamp-audit");
  });
});

Deno.test("RepoService.upgrade with kiro removes audit hook copies Kiro IDE migrated into other hook files", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const hooksDir = join(tempDir, ".kiro", "hooks");
    const auditCopy = {
      name: "Swamp Audit",
      trigger: "PostToolUse",
      action: { type: "command", command: KIRO_AUDIT_COMMAND },
    };
    const userHook = {
      name: "lint",
      trigger: "PostFileSave",
      action: { type: "command", command: "npm run lint" },
    };
    const mixedPath = join(hooksDir, "migrated-mixed.json");
    const onlyCopyPath = join(hooksDir, "migrated-audit.json");
    const withSettingsPath = join(hooksDir, "migrated-settings.json");
    const userOnlyPath = join(hooksDir, "user.json");
    await Deno.writeTextFile(
      mixedPath,
      JSON.stringify({ version: "v1", hooks: [auditCopy, userHook] }),
    );
    await Deno.writeTextFile(
      onlyCopyPath,
      JSON.stringify({ version: "v1", hooks: [auditCopy] }),
    );
    await Deno.writeTextFile(
      withSettingsPath,
      JSON.stringify({ version: "v1", hooks: [auditCopy], note: "keep" }),
    );
    const userOnly = JSON.stringify({ version: "v1", hooks: [userHook] });
    await Deno.writeTextFile(userOnlyPath, userOnly);

    const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["kiro"],
    });

    assertEquals(await readJson(mixedPath), {
      version: "v1",
      hooks: [userHook],
    });
    assertEquals(await pathExists(onlyCopyPath), false);
    assertEquals(await readJson(withSettingsPath), {
      version: "v1",
      hooks: [],
      note: "keep",
    });
    assertEquals(await Deno.readTextFile(userOnlyPath), userOnly);
    assertEquals(
      result.changedFiles.filter((f) => f.startsWith(".kiro/hooks/")),
      [
        ".kiro/hooks/migrated-audit.json",
        ".kiro/hooks/migrated-mixed.json",
        ".kiro/hooks/migrated-settings.json",
      ],
    );
    // swamp's own hook file is untouched.
    assertEquals(
      (await readJson(join(hooksDir, "swamp-audit.json"))).hooks.length,
      1,
    );
  });
});

Deno.test("RepoService.upgrade with kiro removes migrated audit hook copies that run swamp by absolute path", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const hooksDir = join(tempDir, ".kiro", "hooks");
    const otherTrigger = {
      name: "audit on save",
      trigger: "PostFileSave",
      action: { type: "command", command: KIRO_AUDIT_COMMAND },
    };
    const migratedPath = join(hooksDir, "migrated.json");
    await Deno.writeTextFile(
      migratedPath,
      JSON.stringify({
        version: "v1",
        hooks: [
          {
            name: "Swamp Audit",
            trigger: "PostToolUse",
            action: {
              type: "command",
              command:
                '"/usr/local/bin/swamp" audit record --from-hook --tool kiro',
            },
          },
          otherTrigger,
        ],
      }),
    );

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    // The post-tool copy goes; a hook on another trigger is the user's own.
    assertEquals(await readJson(migratedPath), {
      version: "v1",
      hooks: [otherTrigger],
    });
  });
});

Deno.test("RepoService.upgrade with kiro recognises swamp's audit command however the binary is spelled", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const hooksDir = join(tempDir, ".kiro", "hooks");
    const auditHook = (command: string) => ({
      name: "Swamp Audit",
      trigger: "PostToolUse",
      action: { type: "command", command },
    });
    const kept = [
      auditHook(`${KIRO_AUDIT_COMMAND} && ./notify.sh`),
      auditHook(`not-swamp audit record --from-hook --tool kiro`),
      auditHook(`swamp audit record --from-hook --tool kiro --verbose`),
    ];
    const migratedPath = join(hooksDir, "migrated.json");
    await Deno.writeTextFile(
      migratedPath,
      JSON.stringify({
        version: "v1",
        hooks: [
          auditHook(KIRO_AUDIT_COMMAND),
          auditHook(
            '"C:\\Program Files\\swamp\\swamp.exe" audit record --from-hook --tool kiro',
          ),
          auditHook(
            "/opt/swamp/bin/swamp audit record --from-hook --tool kiro",
          ),
          ...kept,
        ],
      }),
    );

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(await readJson(migratedPath), { version: "v1", hooks: kept });
  });
});

Deno.test("RepoService.upgrade with kiro leaves hook files it cannot read alone", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const hooksDir = join(tempDir, ".kiro", "hooks");
    const invalidPath = join(hooksDir, "broken.json");
    const otherSchemaPath = join(hooksDir, "other.json");
    const arrayPath = join(hooksDir, "array.json");
    const otherSchema = JSON.stringify({
      hooks: [{ action: { command: KIRO_AUDIT_COMMAND } }],
    });
    await Deno.writeTextFile(invalidPath, "{ not json");
    await Deno.writeTextFile(otherSchemaPath, otherSchema);
    await Deno.writeTextFile(arrayPath, "[]");

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(await Deno.readTextFile(invalidPath), "{ not json");
    assertEquals(await Deno.readTextFile(otherSchemaPath), otherSchema);
    assertEquals(await Deno.readTextFile(arrayPath), "[]");
  });
});

Deno.test({
  name: "RepoService.upgrade with kiro does not follow a symlinked hook file",
  // Creating symlinks on Windows needs a privilege CI runners lack.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (tempDir) => {
      const repoPath = RepoPath.create(tempDir);
      await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

      const outside = join(tempDir, "outside.json");
      const outsideContent = JSON.stringify({
        version: "v1",
        hooks: [{ action: { type: "command", command: KIRO_AUDIT_COMMAND } }],
      });
      await Deno.writeTextFile(outside, outsideContent);
      const linkPath = join(tempDir, ".kiro", "hooks", "linked.json");
      await Deno.symlink(outside, linkPath, { type: "file" });

      await testService("0.2.0", tempDir).upgrade(repoPath, {
        tools: ["kiro"],
      });

      assertEquals(await Deno.readTextFile(outside), outsideContent);
      assertEquals((await Deno.lstat(linkPath)).isSymlink, true);
    });
  },
});

// Kiro CLI agent config tests

// The universal format `kiro-cli agent upgrade` (kiro-cli 2.29) writes for
// swamp's agent, which both its 2.x and 3.0 engines load.
const KIRO_AGENT_CONFIG = {
  name: "swamp",
  description: "Swamp automation agent with audit tracking",
  tools: ["glob", "grep", "read", "shell", "thinking", "todo_list", "write"],
  resources: [
    "file://.kiro/steering/**/*.md",
    "skill://~/.kiro/skills/**/SKILL.md",
  ],
  toolsSettings: {
    shell: {
      allowedCommands: ["swamp .*"],
      deniedCommands: [".*read-secret.*"],
    },
  },
  permissions: {
    rules: [
      { capability: "shell", match: ["swamp *"], effect: "allow" },
      { capability: "shell", match: ["*read-secret*"], effect: "deny" },
    ],
  },
  hooks: [{
    name: "swamp-audit",
    trigger: "postToolUse",
    action: { type: "command", command: KIRO_AUDIT_COMMAND },
    timeout: 10,
  }],
};

Deno.test("RepoService.init with kiro creates .kiro/agents/swamp.json in kiro-cli's universal format", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["kiro"] });

    const config = await readJson(
      join(tempDir, ".kiro", "agents", "swamp.json"),
    );
    assertEquals(config, KIRO_AGENT_CONFIG);
    // kiro-cli reports a reordered tools list as out of sync.
    assertEquals(config.tools, [...config.tools].sort());
  });
});

Deno.test("RepoService.upgrade with kiro replaces a 2.x-format agent config", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const configPath = join(tempDir, ".kiro", "agents", "swamp.json");
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        name: "swamp",
        description: "Swamp automation agent with audit tracking",
        tools: ["read", "write", "shell", "grep", "glob", "thinking", "todo"],
        resources: KIRO_AGENT_CONFIG.resources,
        toolsSettings: { shell: { allowedCommands: ["swamp .*"] } },
        hooks: { postToolUse: [{ command: KIRO_AUDIT_COMMAND }] },
      }),
    );

    const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["kiro"],
    });

    assertEquals(await readJson(configPath), KIRO_AGENT_CONFIG);
    assertEquals(result.changedFiles.includes(".kiro/agents/swamp.json"), true);
  });
});

// Kiro CLI workspace default agent tests (.kiro/settings/cli.json)

Deno.test("RepoService.init with kiro produces hook, agent, and cli.json together", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["kiro"] });

    // Hook file
    const hookPath = join(tempDir, ".kiro", "hooks", "swamp-audit.json");
    await Deno.stat(hookPath);

    // Agent config with explicit tools list (no "*")
    const agentPath = join(tempDir, ".kiro", "agents", "swamp.json");
    const agent = JSON.parse(await Deno.readTextFile(agentPath));
    assertEquals(Array.isArray(agent.tools), true);
    assertEquals((agent.tools as string[]).includes("*"), false);
    assertEquals((agent.tools as string[]).includes("shell"), true);

    // Workspace default-agent wiring
    const cliPath = join(tempDir, ".kiro", "settings", "cli.json");
    const cli = JSON.parse(await Deno.readTextFile(cliPath));
    assertEquals(cli["chat.defaultAgent"], "swamp");
  });
});

Deno.test("RepoService.init with kiro merges existing cli.json preserving unrelated keys", async () => {
  await withTempDir(async (tempDir) => {
    // Pre-create cli.json with an unrelated key
    const settingsDir = join(tempDir, ".kiro", "settings");
    await Deno.mkdir(settingsDir, { recursive: true });
    const cliPath = join(settingsDir, "cli.json");
    await Deno.writeTextFile(
      cliPath,
      JSON.stringify({ "some.unrelated.setting": 42 }, null, 2) + "\n",
    );

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["kiro"] });

    const cli = JSON.parse(await Deno.readTextFile(cliPath));
    assertEquals(cli["chat.defaultAgent"], "swamp");
    assertEquals(cli["some.unrelated.setting"], 42);
  });
});

Deno.test("RepoService.init with kiro leaves existing non-swamp defaultAgent alone", async () => {
  await withTempDir(async (tempDir) => {
    const settingsDir = join(tempDir, ".kiro", "settings");
    await Deno.mkdir(settingsDir, { recursive: true });
    const cliPath = join(settingsDir, "cli.json");
    await Deno.writeTextFile(
      cliPath,
      JSON.stringify({ "chat.defaultAgent": "my-custom-agent" }, null, 2) +
        "\n",
    );

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["kiro"] });

    const cli = JSON.parse(await Deno.readTextFile(cliPath));
    assertEquals(cli["chat.defaultAgent"], "my-custom-agent");
  });
});

// OpenCode audit plugin tests

Deno.test("RepoService.init with opencode creates .opencode/plugins/swamp-audit.ts", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: ["opencode"] });

    assertEquals(result.tools[0], "opencode");
    assertEquals(result.settingsCreated, true);

    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    const content = await Deno.readTextFile(pluginPath);
    // OpenCode 1 entry points
    assertStringIncludes(content, "export const SwampAudit");
    assertStringIncludes(content, "tool.execute.before");
    assertStringIncludes(content, "tool.execute.after");
    assertStringIncludes(content, "server: SwampAudit");
    // OpenCode 2 entry point
    assertStringIncludes(content, "export default {");
    assertStringIncludes(content, 'id: "swamp.audit"');
    assertStringIncludes(content, 'ctx.tool.hook("execute.after"');
    assertStringIncludes(content, '"shell"');
    assertStringIncludes(content, '"--from-hook"');
    assertStringIncludes(content, '"opencode"');
  });
});

Deno.test("RepoService.upgrade with opencode updates plugin", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["opencode"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["opencode"],
    });

    assertEquals(result.tools[0], "opencode");

    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    const content = await Deno.readTextFile(pluginPath);
    assertStringIncludes(content, '"--from-hook"');
    assertStringIncludes(content, '"opencode"');
  });
});

Deno.test("RepoService.init with opencode force reinit overwrites plugin", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // First init
    await service.init(repoPath, { tools: ["opencode"] });

    // Modify the plugin
    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    await Deno.writeTextFile(pluginPath, "// custom content");

    // Force reinit should overwrite the managed plugin
    await service.init(repoPath, { tools: ["opencode"], force: true });

    const content = await Deno.readTextFile(pluginPath);
    assertStringIncludes(content, '"--from-hook"');
    assertStringIncludes(content, '"opencode"');
  });
});

interface OpenCodeV1Hooks {
  "tool.execute.before": (
    input: { tool: string; sessionID: string },
    output: { args: { command?: string } },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID: string },
  ) => Promise<void>;
}

type OpenCodeV1Plugin = (input: { directory: string }) => Promise<
  OpenCodeV1Hooks
>;

interface OpenCodeV2ToolEvent {
  tool: string;
  sessionID: string;
  input: unknown;
}

interface OpenCodePluginModule {
  SwampAudit: OpenCodeV1Plugin;
  default: {
    id: string;
    server: OpenCodeV1Plugin;
    setup: (ctx: {
      location: { directory: string };
      tool: {
        hook: (
          name: string,
          fn: (event: OpenCodeV2ToolEvent) => Promise<void>,
        ) => Promise<void>;
      };
    }) => Promise<void>;
  };
}

interface RecordedSpawn {
  argv: string[];
  payload: Record<string, unknown>;
}

/**
 * Imports the generated OpenCode plugin with `Bun.spawn` stubbed, so its
 * hooks can be driven in Deno. Each spawn's argv and stdin payload is
 * recorded.
 */
async function withOpenCodePlugin(
  pluginPath: string,
  fn: (mod: OpenCodePluginModule, spawns: RecordedSpawn[]) => Promise<void>,
): Promise<void> {
  const spawns: RecordedSpawn[] = [];
  const g = globalThis as Record<string, unknown>;
  const hadBun = "Bun" in g;
  const originalBun = g.Bun;
  g.Bun = {
    spawn: (argv: string[], opts: { stdin: Blob }) => ({
      exited: opts.stdin.text().then((text) => {
        spawns.push({ argv, payload: JSON.parse(text) });
        return 0;
      }),
    }),
  };
  try {
    const mod: OpenCodePluginModule = await import(toFileUrl(pluginPath).href);
    await fn(mod, spawns);
  } finally {
    if (hadBun) g.Bun = originalBun;
    else delete g.Bun;
  }
}

const AUDIT_RECORD_ARGV = [
  "swamp",
  "audit",
  "record",
  "--from-hook",
  "--tool",
  "opencode",
];

Deno.test("RepoService.init with opencode writes a plugin whose OpenCode 1 hooks record one bash call", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    await service.init(RepoPath.create(tempDir), { tools: ["opencode"] });
    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");

    await withOpenCodePlugin(pluginPath, async (mod, spawns) => {
      // OpenCode 1.3.4+ loads default.server; older loaders call SwampAudit.
      assertEquals(mod.default.server, mod.SwampAudit);

      const hooks = await mod.SwampAudit({ directory: tempDir });
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "s1" },
        { args: { command: "cat x" } },
      );
      await hooks["tool.execute.after"]({ tool: "read", sessionID: "s1" });
      assertEquals(spawns.length, 0);

      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s1" },
        { args: { command: "echo one" } },
      );
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1" });

      assertEquals(spawns.length, 1);
      assertEquals(spawns[0].argv, AUDIT_RECORD_ARGV);
      const normalized = normalizeHookInput("opencode", spawns[0].payload);
      assertEquals(normalized?.command, "echo one");
      assertEquals(normalized?.cwd, tempDir);
      assertEquals(normalized?.sessionId, "s1");
    });
  });
});

Deno.test("RepoService.init with opencode writes a plugin whose OpenCode 2 setup records one shell call", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    await service.init(RepoPath.create(tempDir), { tools: ["opencode"] });
    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");

    await withOpenCodePlugin(pluginPath, async (mod, spawns) => {
      // OpenCode 2 rejects a default export that is not a plain object.
      assertEquals(typeof mod.default, "object");
      assertEquals(mod.default.id, "swamp.audit");

      const hooks = new Map<
        string,
        (event: OpenCodeV2ToolEvent) => Promise<void>
      >();
      await mod.default.setup({
        location: { directory: tempDir },
        tool: {
          hook: (name, fn) => {
            hooks.set(name, fn);
            return Promise.resolve();
          },
        },
      });
      const after = hooks.get("execute.after");
      assert(after, "setup must register an execute.after hook");

      await after({ tool: "read", sessionID: "s2", input: { path: "x" } });
      assertEquals(spawns.length, 0);

      await after({
        tool: "shell",
        sessionID: "s2",
        input: { command: "echo two", workdir: "/elsewhere" },
      });

      assertEquals(spawns.length, 1);
      assertEquals(spawns[0].argv, AUDIT_RECORD_ARGV);
      const normalized = normalizeHookInput("opencode", spawns[0].payload);
      assertEquals(normalized?.command, "echo two");
      assertEquals(normalized?.cwd, tempDir);
      assertEquals(normalized?.sessionId, "s2");
    });
  });
});

Deno.test("RepoService.upgrade with opencode replaces a plugin written before OpenCode 2 support", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["opencode"] });

    const pluginPath = join(tempDir, ".opencode", "plugins", "swamp-audit.ts");
    await Deno.writeTextFile(
      pluginPath,
      `import type { Plugin } from "@opencode-ai/plugin";
export const SwampAudit: Plugin = async ({ directory }) => ({});
`,
    );

    const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["opencode"],
    });

    assertEquals(
      result.changedFiles.includes(".opencode/plugins/swamp-audit.ts"),
      true,
    );
    const content = await Deno.readTextFile(pluginPath);
    assertStringIncludes(content, "export default {");
    assertStringIncludes(content, 'ctx.tool.hook("execute.after"');
  });
});

// Managed instructions section tests

Deno.test("RepoService.upgrade with markers preserves user content before and after section", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Add user content before and after the managed section
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const original = await Deno.readTextFile(claudeMdPath);
    const withUserContent = "# My Project Notes\n\n" + original +
      "\n## My Custom Rules\n\nDo things my way.\n";
    await Deno.writeTextFile(claudeMdPath, withUserContent);

    // Upgrade — should replace only managed section
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    // Content hasn't actually changed in the managed section, so no update
    assertEquals(result.instructionsUpdated, false);

    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(content, "# My Project Notes");
    assertStringIncludes(content, "## My Custom Rules");
    assertStringIncludes(content, "Do things my way.");
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
  });
});

Deno.test("RepoService.upgrade with markers replaces only managed section when template changes", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Add user content after the managed section
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const original = await Deno.readTextFile(claudeMdPath);
    const withUserContent = original + "\n## My Custom Rules\n\nDo my thing.\n";
    await Deno.writeTextFile(claudeMdPath, withUserContent);

    // Tamper with the managed section to simulate old template
    const tampered = withUserContent.replace(
      "Use `swamp --help` to see available commands.",
      "Use `swamp help` to see available commands.",
    );
    await Deno.writeTextFile(claudeMdPath, tampered);

    // Upgrade — should replace managed section, preserve user content
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(claudeMdPath);
    // Template restored
    assertStringIncludes(
      content,
      "Use `swamp --help` to see available commands.",
    );
    // User content preserved
    assertStringIncludes(content, "## My Custom Rules");
    assertStringIncludes(content, "Do my thing.");
  });
});

Deno.test("RepoService.upgrade migrates legacy content (template-only) to markers", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate legacy CLAUDE.md (no markers, just raw template)
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const legacyContent = `# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Rules

1. **Extension models for service integrations.** Old rule text.

## Skills

- \`swamp\` - Swamp CLI

## Getting Started

Always start by using the \`swamp\` skill to work with swamp models.

## Commands

Use \`swamp --help\` to see available commands.
`;
    await Deno.writeTextFile(claudeMdPath, legacyContent);

    // Upgrade — should migrate to markers
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");
    // Updated template content
    assertStringIncludes(content, "`swamp`");
  });
});

Deno.test("RepoService.upgrade migrates legacy content and preserves user additions after template", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate legacy CLAUDE.md with user additions after
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const legacyWithUserContent = `# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Commands

Use \`swamp --help\` to see available commands.

## My Team Standards

Always write tests.
`;
    await Deno.writeTextFile(claudeMdPath, legacyWithUserContent);

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    // User content preserved
    assertStringIncludes(content, "## My Team Standards");
    assertStringIncludes(content, "Always write tests.");
  });
});

Deno.test("RepoService.upgrade migrates legacy content and preserves user additions before template", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate legacy CLAUDE.md with user additions before
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const legacyWithUserBefore = `## My Project Setup

Run npm install first.

# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Commands

Use \`swamp --help\` to see available commands.
`;
    await Deno.writeTextFile(claudeMdPath, legacyWithUserBefore);

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(claudeMdPath);
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    // User content before preserved
    assertStringIncludes(content, "## My Project Setup");
    assertStringIncludes(content, "Run npm install first.");
  });
});

Deno.test("RepoService.upgrade cursor uses shared mode with managed section markers", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["cursor"] });

    const mdcPath = join(tempDir, ".cursor", "rules", "swamp.mdc");

    // Add user content after the managed section
    const original = await Deno.readTextFile(mdcPath);
    await Deno.writeTextFile(
      mdcPath,
      original + "\n## My Custom Rules\n\nUse TypeScript strict mode.\n",
    );

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["cursor"],
    });

    assertEquals(result.instructionsUpdated, false);

    const content = await Deno.readTextFile(mdcPath);
    // Should have managed section markers
    assertStringIncludes(content, "<!-- BEGIN swamp managed section");
    assertStringIncludes(content, "<!-- END swamp managed section");
    // Frontmatter at byte 0
    assertEquals(content.startsWith("---\n"), true);
    assertStringIncludes(content, "alwaysApply: true");
    // User content preserved
    assertStringIncludes(content, "## My Custom Rules");
    assertStringIncludes(content, "Use TypeScript strict mode.");
  });
});

Deno.test("RepoService.upgrade kiro uses shared mode with managed section markers", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["kiro"] });

    const steeringPath = join(
      tempDir,
      ".kiro",
      "steering",
      "swamp-rules.md",
    );

    // Add user content after the managed section
    const original = await Deno.readTextFile(steeringPath);
    await Deno.writeTextFile(
      steeringPath,
      original + "\n## My Custom Rules\n\nUse TypeScript strict mode.\n",
    );

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(result.instructionsUpdated, false);

    const content = await Deno.readTextFile(steeringPath);
    // Should have managed section markers
    assertStringIncludes(content, "<!-- BEGIN swamp managed section");
    assertStringIncludes(content, "<!-- END swamp managed section");
    // Frontmatter at byte 0
    assertEquals(content.startsWith("---\n"), true);
    assertStringIncludes(content, "inclusion: always");
    // User content preserved
    assertStringIncludes(content, "## My Custom Rules");
    assertStringIncludes(content, "Use TypeScript strict mode.");
  });
});

Deno.test("RepoService.init with opencode creates AGENTS.md with markers", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["opencode"] });

    const agentsMdPath = join(tempDir, "AGENTS.md");
    const content = await Deno.readTextFile(agentsMdPath);
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");
    assertStringIncludes(content, "swamp");
  });
});

Deno.test("RepoService.upgrade recovers when END marker is missing from CLAUDE.md", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate user accidentally deleting the END marker
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const original = await Deno.readTextFile(claudeMdPath);
    const corrupted = original.replace(
      "<!-- END swamp managed section -->",
      "",
    );
    await Deno.writeTextFile(claudeMdPath, corrupted);

    // Upgrade should recover — falls through to prepend
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(claudeMdPath);
    // Both markers now present
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");

    // Must have exactly one of each marker (no duplicates)
    const beginCount =
      content.split("<!-- BEGIN swamp managed section - DO NOT EDIT -->")
        .length - 1;
    assertEquals(
      beginCount,
      1,
      "Expected exactly one BEGIN marker, not duplicated",
    );
    const endCount =
      content.split("<!-- END swamp managed section -->").length - 1;
    assertEquals(
      endCount,
      1,
      "Expected exactly one END marker, not duplicated",
    );
  });
});

Deno.test("RepoService.upgrade legacy migration with partial template match preserves user content", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate legacy CLAUDE.md where user modified the end of the template
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const legacyWithEditedEnd = `# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Commands

Use \`swamp --help\` to see commands.

## My Custom Section

User content here.
`;
    await Deno.writeTextFile(claudeMdPath, legacyWithEditedEnd);

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath);

    assertEquals(result.instructionsUpdated, true);

    const content = await Deno.readTextFile(claudeMdPath);
    // Should have markers (new managed section was prepended)
    assertStringIncludes(
      content,
      "<!-- BEGIN swamp managed section - DO NOT EDIT -->",
    );
    assertStringIncludes(content, "<!-- END swamp managed section -->");

    // Exactly one set of markers (no duplicates)
    const beginCount =
      content.split("<!-- BEGIN swamp managed section - DO NOT EDIT -->")
        .length - 1;
    assertEquals(beginCount, 1, "Expected exactly one BEGIN marker");
    const endCount =
      content.split("<!-- END swamp managed section -->").length - 1;
    assertEquals(endCount, 1, "Expected exactly one END marker");

    // User content MUST be preserved — this is the critical invariant.
    // When the legacy template end marker can't be found, we prepend
    // the new section rather than risk deleting user content.
    assertStringIncludes(
      content,
      "## My Custom Section",
      "User section heading should be preserved after migration",
    );
    assertStringIncludes(
      content,
      "User content here.",
      "User content body should be preserved after migration",
    );
  });
});

Deno.test("RepoService.upgrade with duplicate managed sections throws clear error", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate duplicate markers (e.g., from a bad merge)
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const original = await Deno.readTextFile(claudeMdPath);
    const duplicated = original + "\n" + original;
    await Deno.writeTextFile(claudeMdPath, duplicated);

    const upgradeService = testService("0.2.0", tempDir);
    await assertRejects(
      () => upgradeService.upgrade(repoPath),
      Error,
      "multiple swamp managed sections",
    );
  });
});

Deno.test("RepoService.upgrade with duplicate END markers throws clear error", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath);

    // Simulate duplicate END marker (e.g., from a bad merge)
    const claudeMdPath = join(tempDir, "CLAUDE.md");
    const original = await Deno.readTextFile(claudeMdPath);
    const withDuplicateEnd = original +
      "\n<!-- END swamp managed section -->\n";
    await Deno.writeTextFile(claudeMdPath, withDuplicateEnd);

    const upgradeService = testService("0.2.0", tempDir);
    await assertRejects(
      () => upgradeService.upgrade(repoPath),
      Error,
      "multiple swamp managed sections",
    );
  });
});

// --tool none tests

Deno.test("RepoService.init with tool none creates core structure but skips skills and instructions", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, { tools: [] });

    // Core structure should exist
    assertEquals(result.tools, []);
    const swampDir = join(tempDir, ".swamp");
    const stat = await Deno.stat(swampDir);
    assertEquals(stat.isDirectory, true);

    // .swamp.yaml should exist with empty tools array
    const markerPath = join(tempDir, ".swamp.yaml");
    const markerContent = await Deno.readTextFile(markerPath);
    assertStringIncludes(markerContent, "tools: []");

    // Models/workflows/vaults dirs should exist
    for (const dir of ["models", "workflows", "vaults"]) {
      const dirStat = await Deno.stat(join(tempDir, dir));
      assertEquals(dirStat.isDirectory, true);
    }

    // No skills should be copied
    assertEquals(result.skillsCopied, []);

    // No instructions file should be created
    assertEquals(result.instructionsFileCreated, false);

    // No settings should be created
    assertEquals(result.settingsCreated, false);

    // .gitignore should have .swamp/ but no tool-specific entry
    const gitignorePath = join(tempDir, ".gitignore");
    const gitignoreContent = await Deno.readTextFile(gitignorePath);
    assertStringIncludes(gitignoreContent, ".swamp/");
    assertStringIncludes(
      gitignoreContent,
      "# BEGIN swamp managed section - DO NOT EDIT",
    );
    // Should not contain any tool-specific entries
    assertEquals(gitignoreContent.includes(".claude/"), false);
    assertEquals(gitignoreContent.includes(".cursor/"), false);
    assertEquals(gitignoreContent.includes(".agents/"), false);
    assertEquals(gitignoreContent.includes(".kiro/"), false);
  });
});

Deno.test("RepoService.upgrade with tool none skips skills and instructions", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    // Init with none first
    await service.init(repoPath, { tools: [] });

    // Upgrade
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, { tools: [] });

    assertEquals(result.tools, []);
    assertEquals(result.skillsUpdated, []);
    assertEquals(result.instructionsUpdated, false);
    assertEquals(result.settingsUpdated, false);
  });
});

Deno.test("RepoService.init with multiple tools writes scaffolding for each", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, {
      tools: ["claude", "kiro"],
    });

    assertEquals(result.tools, ["claude", "kiro"]);

    // Skills are installed globally, not in repo
    assertEquals(result.skillsCopied.includes("swamp"), true);

    // Marker should list both
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    assertEquals(marker!.tools, ["claude", "kiro"]);
    assertEquals(marker!.tool, undefined);

    // .gitignore should contain claude-specific entries (kiro has no gitignore entries)
    const gitignore = await Deno.readTextFile(join(tempDir, ".gitignore"));
    assertStringIncludes(gitignore, ".claude/worktrees/");
    assertEquals(gitignore.includes(".kiro/skills/"), false);
  });
});

Deno.test("RepoService.init with duplicate --tool values dedupes", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const result = await service.init(repoPath, {
      tools: ["claude", "claude", "kiro"],
    });

    assertEquals(result.tools, ["claude", "kiro"]);
  });
});

Deno.test("RepoService.init with shared-dir tools (opencode + codex) does not gitignore skills", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    await service.init(repoPath, { tools: ["opencode", "codex", "copilot"] });

    const gitignore = await Deno.readTextFile(join(tempDir, ".gitignore"));
    assertEquals(gitignore.includes(".agents/skills/"), false);
    assertStringIncludes(gitignore, ".swamp/");
  });
});

Deno.test("RepoService.upgrade with no tool flag preserves marker.tools", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude", "kiro"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {});

    assertEquals(result.tools, ["claude", "kiro"]);
    assertEquals(result.addedTools, []);
    assertEquals(result.removedTools, []);
    assertEquals(result.extensionsToReinstall, []);
  });
});

Deno.test("RepoService.upgrade replacing the tool list computes the diff", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude", "kiro"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["claude", "opencode"],
    });

    assertEquals(result.tools, ["claude", "opencode"]);
    assertEquals(result.addedTools, ["opencode"]);
    assertEquals(result.removedTools, ["kiro"]);
  });
});

Deno.test("RepoService.upgrade clears the tool list when given an empty tools array", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude", "kiro"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, { tools: [] });

    assertEquals(result.tools, []);
    assertEquals(result.addedTools, []);
    assertEquals(result.removedTools, ["claude", "kiro"]);
  });
});

Deno.test("RepoService.upgrade adding a tool flags pulled extensions to reinstall", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude"] });

    // Simulate a pulled extension in the primary tool's skills dir
    const pulledDir = join(tempDir, ".claude", "skills", "swamp-foo");
    await Deno.mkdir(pulledDir, { recursive: true });
    await Deno.writeTextFile(
      join(pulledDir, "SKILL.md"),
      "# pulled extension",
    );

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["claude", "kiro"],
    });

    assertEquals(result.addedTools, ["kiro"]);
    assertEquals(result.extensionsToReinstall, [
      { tool: "kiro", names: ["swamp-foo"] },
    ]);
  });
});

Deno.test("RepoService.upgrade walks the OLD primary skills dir when primary changes", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude"] });

    // Pulled extension lives under .claude/skills/, the OLD primary
    const pulledDir = join(tempDir, ".claude", "skills", "swamp-foo");
    await Deno.mkdir(pulledDir, { recursive: true });
    await Deno.writeTextFile(
      join(pulledDir, "SKILL.md"),
      "# pulled extension",
    );

    // Replace claude entirely with kiro — primary becomes kiro after the
    // upgrade, but the walk must still hit .claude/skills/ to find the
    // existing pulled extension.
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["kiro"],
    });

    assertEquals(result.addedTools, ["kiro"]);
    assertEquals(result.removedTools, ["claude"]);
    assertEquals(result.extensionsToReinstall, [
      { tool: "kiro", names: ["swamp-foo"] },
    ]);
  });
});

Deno.test("RepoService.upgrade suppresses extensions warning for shared skills dir", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["opencode"] });

    const pulledDir = join(tempDir, ".agents", "skills", "swamp-foo");
    await Deno.mkdir(pulledDir, { recursive: true });
    await Deno.writeTextFile(
      join(pulledDir, "SKILL.md"),
      "# pulled extension",
    );

    // opencode and codex share `.agents/skills/`, so adding codex should
    // not emit a reinstall warning — the extension is already there.
    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["opencode", "codex"],
    });

    assertEquals(result.addedTools, ["codex"]);
    assertEquals(result.extensionsToReinstall, []);
  });
});

Deno.test("RepoService.upgrade adding a tool with no pulled extensions emits no warning", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["claude"] });

    const upgradeService = testService("0.2.0", tempDir);
    const result = await upgradeService.upgrade(repoPath, {
      tools: ["claude", "kiro"],
    });

    assertEquals(result.addedTools, ["kiro"]);
    assertEquals(result.extensionsToReinstall, []);
  });
});

Deno.test("detectSupersededSkills: returns empty when no superseded dirs exist", async () => {
  await withTempDir(async (tempDir) => {
    const result = await detectSupersededSkills(tempDir);
    assertEquals(result, []);
  });
});

Deno.test("detectSupersededSkills: detects superseded skill directories", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp-extension-model"));
    await Deno.mkdir(join(tempDir, "swamp-data-query"));
    // Non-superseded dir should be ignored
    await Deno.mkdir(join(tempDir, "swamp"));

    const result = await detectSupersededSkills(tempDir);
    assertEquals(result.sort(), ["swamp-data-query", "swamp-extension-model"]);
  });
});

Deno.test("detectSupersededSkills: returns empty for nonexistent directory", async () => {
  const result = await detectSupersededSkills("/tmp/nonexistent-dir-326");
  assertEquals(result, []);
});

async function seedSupersededSkills(dir: string): Promise<void> {
  for (const name of SUPERSEDED_SKILLS) {
    await ensureDir(join(dir, name));
    await Deno.writeTextFile(join(dir, name, "SKILL.md"), "old");
  }
}

Deno.test("RepoService.upgrade removes superseded skills from the repo-local claude skills dir", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["claude"] });
    const skillsDir = join(tempDir, ".claude", "skills");
    await seedSupersededSkills(skillsDir);
    await ensureDir(join(skillsDir, "my-skill"));

    await testService("0.2.0", tempDir).upgrade(repoPath);

    assertEquals(await detectSupersededSkills(skillsDir), []);
    const stat = await Deno.stat(join(skillsDir, "my-skill"));
    assertEquals(stat.isDirectory, true);
  });
});

// The startup warning checks supersededSkillDirs(); upgrade must clear every
// dir it checks, for every built-in tool, or the warning can never clear.
for (const tool of Object.keys(SKILL_DIRS)) {
  Deno.test(`RepoService.upgrade clears the superseded skills the startup warning reports (${tool})`, async () => {
    await withTempDir(async (tempDir) => {
      const repoPath = RepoPath.create(tempDir);
      await testService("0.1.0", tempDir).init(repoPath, { tools: [tool] });
      await seedSupersededSkills(join(tempDir, SKILL_DIRS[tool]));

      await testService("0.2.0", tempDir).upgrade(repoPath);

      for (const dir of supersededSkillDirs(tempDir, [tool])) {
        assertEquals(await detectSupersededSkills(dir), []);
      }
    });
  });
}

Deno.test("RepoService.upgrade with no tools clears the claude dir the warning reports and leaves pulled extension skills", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: [] });
    await seedSupersededSkills(join(tempDir, ".claude", "skills"));
    const pulledSkills = join(tempDir, ".swamp", "pulled-extensions", "skills");
    await seedSupersededSkills(pulledSkills);

    await testService("0.2.0", tempDir).upgrade(repoPath);

    for (const dir of supersededSkillDirs(tempDir, [])) {
      assertEquals(await detectSupersededSkills(dir), []);
    }
    assertEquals(
      (await detectSupersededSkills(pulledSkills)).length,
      SUPERSEDED_SKILLS.length,
    );
  });
});

Deno.test("RepoService.upgrade cleans a skills dir shared by several tools", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, {
      tools: ["codex", "copilot"],
    });
    const sharedDir = join(tempDir, ".agents", "skills");
    await seedSupersededSkills(sharedDir);

    await testService("0.2.0", tempDir).upgrade(repoPath);

    assertEquals(await detectSupersededSkills(sharedDir), []);
  });
});

// ============================================================================
// hasOrphanedSwampDir Tests
// ============================================================================

Deno.test("hasOrphanedSwampDir: returns true when .swamp/ exists without .swamp.yaml", async () => {
  await withTempDir(async (tempDir) => {
    await ensureDir(join(tempDir, ".swamp"));

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    assertEquals(await service.hasOrphanedSwampDir(repoPath), true);
  });
});

Deno.test("hasOrphanedSwampDir: returns false when neither .swamp/ nor .swamp.yaml exist", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    assertEquals(await service.hasOrphanedSwampDir(repoPath), false);
  });
});

Deno.test("hasOrphanedSwampDir: returns true even when fully initialized (caller gates on isInitialized first)", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    assertEquals(await service.hasOrphanedSwampDir(repoPath), true);
  });
});

Deno.test("upgrade: throws orphan-specific error when .swamp/ exists without marker", async () => {
  await withTempDir(async (tempDir) => {
    await ensureDir(join(tempDir, ".swamp"));

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);

    const error = await assertRejects(
      () => service.upgrade(repoPath),
      Error,
    );

    assertStringIncludes(error.message, "Found a .swamp/ directory");
    assertStringIncludes(error.message, "no .swamp.yaml marker");
  });
});

// --- Local bundled skill detection and removal tests ---

Deno.test("detectLocalBundledSkills: finds local copies in claude skills dir", async () => {
  await withTempDir(async (tempDir) => {
    const skillDir = join(tempDir, ".claude", "skills", "swamp");
    await ensureDir(skillDir);
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: swamp\n---",
    );

    const results = await detectLocalBundledSkills(tempDir, ["claude"]);
    assertEquals(results.length, 1);
    assertEquals(results[0].names, ["swamp"]);
  });
});

Deno.test("detectLocalBundledSkills: finds both bundled skills", async () => {
  await withTempDir(async (tempDir) => {
    for (const name of ["swamp", "swamp-getting-started"]) {
      const dir = join(tempDir, ".claude", "skills", name);
      await ensureDir(dir);
      await Deno.writeTextFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\n---`,
      );
    }

    const results = await detectLocalBundledSkills(tempDir, ["claude"]);
    assertEquals(results.length, 1);
    assertEquals(results[0].names, ["swamp", "swamp-getting-started"]);
  });
});

Deno.test("detectLocalBundledSkills: returns empty when no local copies", async () => {
  await withTempDir(async (tempDir) => {
    const results = await detectLocalBundledSkills(tempDir, ["claude"]);
    assertEquals(results.length, 0);
  });
});

Deno.test("detectLocalBundledSkills: deduplicates shared skill dirs", async () => {
  await withTempDir(async (tempDir) => {
    const skillDir = join(tempDir, ".agents", "skills", "swamp");
    await ensureDir(skillDir);
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: swamp\n---",
    );

    const results = await detectLocalBundledSkills(tempDir, [
      "codex",
      "opencode",
      "copilot",
    ]);
    assertEquals(results.length, 1);
  });
});

Deno.test("removeLocalBundledSkills: removes specified skill directories", async () => {
  await withTempDir(async (tempDir) => {
    const skillDir = join(tempDir, ".claude", "skills", "swamp");
    await ensureDir(skillDir);
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: swamp\n---",
    );

    await removeLocalBundledSkills([{
      skillsDir: join(tempDir, ".claude", "skills"),
      names: ["swamp"],
    }]);

    const exists = await Deno.stat(skillDir).then(() => true).catch(() =>
      false
    );
    assertEquals(exists, false);
  });
});

Deno.test("removeLocalBundledSkills: no-op when directory already gone", async () => {
  await withTempDir(async (tempDir) => {
    await removeLocalBundledSkills([{
      skillsDir: join(tempDir, ".claude", "skills"),
      names: ["swamp"],
    }]);
  });
});

Deno.test("RepoService.upgrade: returns untrusted collectives from lockfile", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    // Write a lockfile with extensions from an untrusted collective
    const modelsDir = join(tempDir, "extensions", "models");
    await ensureDir(modelsDir);
    await Deno.writeTextFile(
      join(modelsDir, "upstream_extensions.json"),
      JSON.stringify({
        "@acme/widgets": { version: "1.0.0", pulledAt: "2026-01-01" },
        "@swamp/echo": { version: "2.0.0", pulledAt: "2026-01-01" },
      }),
    );

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.untrustedCollectives, ["acme"]);
  });
});

Deno.test("RepoService.upgrade: returns empty when all collectives are trusted", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    // Write the marker with an extra trusted collective
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    marker!.trustedCollectives = ["swamp", "acme"];
    await markerRepo.write(repoPath, marker!);

    // Write a lockfile with extensions only from trusted collectives
    const modelsDir = join(tempDir, "extensions", "models");
    await ensureDir(modelsDir);
    await Deno.writeTextFile(
      join(modelsDir, "upstream_extensions.json"),
      JSON.stringify({
        "@acme/widgets": { version: "1.0.0", pulledAt: "2026-01-01" },
        "@swamp/echo": { version: "2.0.0", pulledAt: "2026-01-01" },
      }),
    );

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.untrustedCollectives, []);
  });
});

Deno.test("RepoService.upgrade: skips untrusted warning when trustMemberCollectives is on", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    // Enable trustMemberCollectives
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    marker!.trustMemberCollectives = true;
    await markerRepo.write(repoPath, marker!);

    // Write a lockfile with extensions from a collective not in trustedCollectives
    const modelsDir = join(tempDir, "extensions", "models");
    await ensureDir(modelsDir);
    await Deno.writeTextFile(
      join(modelsDir, "upstream_extensions.json"),
      JSON.stringify({
        "@acme/widgets": { version: "1.0.0", pulledAt: "2026-01-01" },
      }),
    );

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.untrustedCollectives, []);
  });
});

Deno.test("RepoService.upgrade: reads untrusted collectives from the resolved lockfile path", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    // Under managedConfig the lockfile lives at the datastore's config base,
    // which the caller resolves and passes in (swamp-club#2483).
    const configBase = join(tempDir, "cache", "config");
    await ensureDir(configBase);
    const lockfilePath = join(configBase, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@acme/widgets": { version: "1.0.0", pulledAt: "2026-01-01" },
      }),
    );

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath, { lockfilePath });

    assertEquals(result.untrustedCollectives, ["acme"]);
  });
});

Deno.test("RepoService.upgrade: skips the untrusted check when the lockfile is unresolved", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    const modelsDir = join(tempDir, "extensions", "models");
    await ensureDir(modelsDir);
    await Deno.writeTextFile(
      join(modelsDir, "upstream_extensions.json"),
      JSON.stringify({
        "@acme/widgets": { version: "1.0.0", pulledAt: "2026-01-01" },
      }),
    );

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath, { lockfilePath: null });

    assertEquals(result.untrustedCollectives, []);
  });
});

Deno.test("RepoService.upgrade: returns empty when no lockfile exists", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath);

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.untrustedCollectives, []);
  });
});

Deno.test("RepoService.init: custom tool with relative skillsDir gets skills copied locally", async () => {
  await withTempDir(async (tempDir) => {
    await writeCustomTools(tempDir, [{
      name: "windsurf",
      skillsDir: ".agents/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    const result = await service.init(repoPath, { tools: ["windsurf"] });

    assertEquals(result.tools[0], "windsurf");
    assertEquals(result.skillsCopied.includes("swamp"), true);

    const skillPath = join(tempDir, ".agents", "skills", "swamp", "SKILL.md");
    const stat = await Deno.stat(skillPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("RepoService.init: custom tool with nested relative skillsDir gets skills copied", async () => {
  await withTempDir(async (tempDir) => {
    await writeCustomTools(tempDir, [{
      name: "myagent",
      skillsDir: ".myagent/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    const result = await service.init(repoPath, { tools: ["myagent"] });

    assertEquals(result.skillsCopied.includes("swamp"), true);

    const skillPath = join(
      tempDir,
      ".myagent",
      "skills",
      "swamp",
      "SKILL.md",
    );
    const stat = await Deno.stat(skillPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("RepoService.upgrade: custom tool with relative skillsDir gets skills updated", async () => {
  await withTempDir(async (tempDir) => {
    await writeCustomTools(tempDir, [{
      name: "windsurf",
      skillsDir: ".agents/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);

    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: ["windsurf"] });

    const newService = testService("0.2.0", tempDir);
    const result = await newService.upgrade(repoPath);

    assertEquals(result.skillsUpdated.includes("swamp"), true);

    const skillPath = join(tempDir, ".agents", "skills", "swamp", "SKILL.md");
    const stat = await Deno.stat(skillPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("RepoService.init with tool amp creates the .amp/plugins/swamp.ts plugin", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    const repoPath = RepoPath.create(tempDir);
    const result = await service.init(repoPath, { tools: ["amp"] });

    assertEquals(result.tools, ["amp"]);
    assertEquals(result.settingsCreated, true);

    const plugin = await Deno.readTextFile(
      join(tempDir, ".amp", "plugins", "swamp.ts"),
    );
    assertStringIncludes(
      plugin,
      'import type { PluginAPI } from "@ampcode/plugin";',
    );
    assertStringIncludes(plugin, "export default function (amp: PluginAPI)");
    assertStringIncludes(plugin, 'amp.on("tool.call"');
    assertStringIncludes(plugin, 'shell.command.includes("read-secret")');
    assertStringIncludes(plugin, "requireHuman: true");
    assertStringIncludes(plugin, "skipIfUnwatched: true");
    assertStringIncludes(plugin, '"reject-and-continue"');
    // Amp no longer reads the amp.commands allowlist, so none is written.
    await assertRejects(
      () => Deno.stat(join(tempDir, ".amp", "settings.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("RepoService.upgrade with tool amp restores a modified plugin", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["amp"] });

    const pluginPath = join(tempDir, ".amp", "plugins", "swamp.ts");
    const original = await Deno.readTextFile(pluginPath);
    await Deno.writeTextFile(pluginPath, "// tampered\n");

    const result = await testService("0.2.0", tempDir).upgrade(repoPath);
    assertEquals(await Deno.readTextFile(pluginPath), original);
    assertEquals(result.changedFiles.includes(".amp/plugins/swamp.ts"), true);

    const again = await testService("0.2.0", tempDir).upgrade(repoPath);
    assertEquals(
      again.changedFiles.filter((f) => f.startsWith(".amp/")),
      [],
    );
  });
});

Deno.test("RepoService.upgrade with tool amp removes swamp's amp.commands entry and keeps the user's", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["amp"] });

    const settingsPath = join(tempDir, ".amp", "settings.json");
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({
        "amp.commands": { allowlist: ["swamp *", "git *"], strict: true },
        "amp.ui": { theme: "dark" },
      }),
    );

    const result = await testService("0.2.0", tempDir).upgrade(repoPath);

    assertEquals(await readJson(settingsPath), {
      "amp.commands": { allowlist: ["git *"], strict: true },
      "amp.ui": { theme: "dark" },
    });
    assertEquals(result.changedFiles.includes(".amp/settings.json"), true);

    const again = await testService("0.2.0", tempDir).upgrade(repoPath);
    assertEquals(again.changedFiles.includes(".amp/settings.json"), false);
  });
});

Deno.test("RepoService.upgrade with tool amp drops an amp.commands block left with only strict", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["amp"] });

    const settingsPath = join(tempDir, ".amp", "settings.json");
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({
        "amp.commands": { allowlist: ["swamp *"], strict: true },
        "amp.showCosts": false,
      }),
    );

    await testService("0.2.0", tempDir).upgrade(repoPath);

    assertEquals(await readJson(settingsPath), { "amp.showCosts": false });
  });
});

Deno.test("RepoService.upgrade with tool amp deletes the settings file swamp wrote when nothing else is in it", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["amp"] });

    const settingsPath = join(tempDir, ".amp", "settings.json");
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify(
        { "amp.commands": { allowlist: ["swamp *"], strict: true } },
        null,
        2,
      ) + "\n",
    );

    const result = await testService("0.2.0", tempDir).upgrade(repoPath);

    await assertRejects(() => Deno.stat(settingsPath), Deno.errors.NotFound);
    assertEquals(result.changedFiles.includes(".amp/settings.json"), true);
  });
});

Deno.test("RepoService.upgrade with tool amp leaves settings it cannot parse or that lack swamp's entry", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["amp"] });

    const settingsPath = join(tempDir, ".amp", "settings.json");
    for (
      const content of [
        '{ // comment\n  "amp.showCosts": false }',
        JSON.stringify({ "amp.commands": { allowlist: ["git *"] } }),
        JSON.stringify({ "amp.commands": "swamp *" }),
      ]
    ) {
      await Deno.writeTextFile(settingsPath, content);
      const result = await testService("0.2.0", tempDir).upgrade(repoPath);
      assertEquals(await Deno.readTextFile(settingsPath), content);
      assertEquals(result.changedFiles.includes(".amp/settings.json"), false);
    }
  });
});

Deno.test("RepoService.upgrade drains the legacy telemetry spool into the injected config dir", async () => {
  await withTempDir(async (tempDir) => {
    const homeDir = join(tempDir, "test-home");
    const configDir = join(homeDir, ".config", "swamp");
    const service = new RepoService("0.1.0", { homeDir, configDir });
    const repoPath = RepoPath.create(tempDir);
    await service.init(repoPath, { tools: [] });

    // Seed a legacy repo-local spool entry, as a pre-migration repo has.
    const legacyDir = join(tempDir, ".swamp", "telemetry");
    await ensureDir(legacyDir);
    await Deno.writeTextFile(
      join(legacyDir, "telemetry-1.json"),
      JSON.stringify({ command: "repo" }),
    );

    const upgrader = new RepoService("0.2.0", { homeDir, configDir });
    await upgrader.upgrade(repoPath);

    // The entry lands in the injected config dir. Migration is deliberately
    // not gated on SWAMP_NO_TELEMETRY — it is gated on the repo's own
    // telemetryDisabled marker — so the ambient config dir is the one thing
    // standing between a test run and the developer's real spool.
    const migrated = await Deno.readTextFile(
      join(configDir, "telemetry", "telemetry-1.json"),
    );
    assertEquals(JSON.parse(migrated), { command: "repo" });
  });
});

// Agent permission grants must not pre-approve `swamp vault read-secret`
// (swamp-club#3219).

const READ_SECRET_COMMANDS = [
  "swamp vault read-secret my-vault API_KEY",
  "swamp vault read-secret my-vault API_KEY --json",
  "swamp --json vault read-secret my-vault API_KEY",
  "swamp version && swamp vault read-secret my-vault API_KEY",
  "swamp version\nswamp vault read-secret my-vault API_KEY",
];

function claudeAllowCovers(entry: string, command: string): boolean {
  const match = entry.match(/^Bash\((.*):\*\)$/);
  return match !== null && command.startsWith(match[1]);
}

// kiro-cli anchors each pattern to the whole command (\A...\z).
function kiroCliPatternMatches(pattern: string, command: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(command);
}

async function readJson(path: string) {
  return JSON.parse(await Deno.readTextFile(path));
}

Deno.test("RepoService.init: claude allow list does not cover vault read-secret", async () => {
  await withTempDir(async (tempDir) => {
    const service = testService("0.1.0", tempDir);
    await service.init(RepoPath.create(tempDir));

    const settings = await readJson(
      join(tempDir, ".claude", "settings.local.json"),
    );
    const allow: string[] = settings.permissions.allow;
    for (const entry of allow) {
      assertEquals(
        claudeAllowCovers(entry, "swamp vault read-secret"),
        false,
        `${entry} pre-approves swamp vault read-secret`,
      );
    }
    for (
      const sub of [
        "type",
        "search",
        "list",
        "get",
        "describe",
        "inspect",
        "list-keys",
        "audit-trail",
        "create",
        "edit",
        "put",
        "write-secret",
        "delete",
        "annotate",
        "migrate",
      ]
    ) {
      assertEquals(
        allow.includes(`Bash(swamp vault ${sub}:*)`),
        true,
        `missing Bash(swamp vault ${sub}:*)`,
      );
    }
  });
});

Deno.test("RepoService.upgrade: removes the legacy claude vault wildcard and keeps user entries", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath);

    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const settings = await readJson(settingsPath);
    settings.permissions.allow = [
      "Bash(custom command:*)",
      "Bash(swamp vault:*)",
      "Bash(swamp vault read-secret:*)",
    ];
    await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));

    const result = await testService("0.2.0", tempDir).upgrade(repoPath);
    assertEquals(result.settingsUpdated, true);

    const allow: string[] = (await readJson(settingsPath)).permissions.allow;
    assertEquals(allow.includes("Bash(swamp vault:*)"), false);
    assertEquals(allow.includes("Bash(custom command:*)"), true);
    assertEquals(allow.includes("Bash(swamp vault read-secret:*)"), true);
    assertEquals(allow.includes("Bash(swamp vault get:*)"), true);

    const again = await testService("0.2.0", tempDir).upgrade(repoPath);
    assertEquals(again.settingsUpdated, false);
  });
});

Deno.test("RepoService.upgrade: settingsUpdated when only the legacy claude vault wildcard is removed", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath);

    const settingsPath = join(tempDir, ".claude", "settings.local.json");
    const settings = await readJson(settingsPath);
    settings.permissions.allow.push("Bash(swamp vault:*)");
    await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));

    const result = await testService("0.2.0", tempDir).upgrade(repoPath);
    assertEquals(result.settingsUpdated, true);
    const allow: string[] = (await readJson(settingsPath)).permissions.allow;
    assertEquals(allow.includes("Bash(swamp vault:*)"), false);
  });
});

// Kiro IDE 1.0 no longer reads `kiroAgent.trustedCommands` /
// `kiroAgent.commandDenylist` (swamp-club#3222), so upgrade removes the
// entries earlier versions wrote.

Deno.test("RepoService.upgrade: removes swamp's kiro IDE 0.x entries and keeps the user's", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const settingsPath = join(tempDir, ".vscode", "settings.local.json");
    await ensureDir(join(tempDir, ".vscode"));
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({
        "kiroAgent.trustedCommands": ["swamp *", "git *"],
        "kiroAgent.commandDenylist": ["rm -rf", "read-secret"],
        "editor.tabSize": 2,
      }),
    );

    const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["kiro"],
    });
    assertEquals(result.settingsUpdated, true);
    assertEquals(
      result.changedFiles.includes(".vscode/settings.local.json"),
      true,
    );
    assertEquals(await readJson(settingsPath), {
      "kiroAgent.trustedCommands": ["git *"],
      "kiroAgent.commandDenylist": ["rm -rf"],
      "editor.tabSize": 2,
    });

    const again = await testService("0.2.0", tempDir).upgrade(repoPath, {
      tools: ["kiro"],
    });
    assertEquals(
      again.changedFiles.includes(".vscode/settings.local.json"),
      false,
    );
  });
});

Deno.test("RepoService.upgrade: drops emptied kiro IDE keys and keeps other settings", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const settingsPath = join(tempDir, ".vscode", "settings.local.json");
    await ensureDir(join(tempDir, ".vscode"));
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({
        "kiroAgent.trustedCommands": ["swamp *"],
        "kiroAgent.commandDenylist": ["read-secret"],
        "editor.tabSize": 2,
      }),
    );

    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });

    assertEquals(await readJson(settingsPath), { "editor.tabSize": 2 });
  });
});

Deno.test("RepoService.upgrade: deletes the kiro IDE settings file swamp wrote when nothing else is in it", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    // Both shapes earlier versions wrote: before and after swamp-club#3219.
    for (
      const legacy of [
        { "kiroAgent.trustedCommands": ["swamp *"] },
        {
          "kiroAgent.trustedCommands": ["swamp *"],
          "kiroAgent.commandDenylist": ["read-secret"],
        },
      ]
    ) {
      const settingsPath = join(tempDir, ".vscode", "settings.local.json");
      await ensureDir(join(tempDir, ".vscode"));
      await Deno.writeTextFile(
        settingsPath,
        JSON.stringify(legacy, null, 2) + "\n",
      );

      const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
        tools: ["kiro"],
      });

      await assertRejects(() => Deno.stat(settingsPath), Deno.errors.NotFound);
      assertEquals(
        result.changedFiles.includes(".vscode/settings.local.json"),
        true,
      );
    }
  });
});

Deno.test("RepoService.upgrade: leaves kiro IDE settings it cannot parse or that lack swamp's entries", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const settingsPath = join(tempDir, ".vscode", "settings.local.json");
    await ensureDir(join(tempDir, ".vscode"));
    for (
      const content of [
        '{ // comment\n  "kiroAgent.trustedCommands": ["swamp *"] }',
        JSON.stringify({ "kiroAgent.trustedCommands": ["git *"] }),
        JSON.stringify({ "kiroAgent.trustedCommands": "swamp *" }),
        "null",
      ]
    ) {
      await Deno.writeTextFile(settingsPath, content);
      const result = await testService("0.2.0", tempDir).upgrade(repoPath, {
        tools: ["kiro"],
      });
      assertEquals(await Deno.readTextFile(settingsPath), content);
      assertEquals(
        result.changedFiles.includes(".vscode/settings.local.json"),
        false,
      );
    }
  });
});

// kiro-cli 3.0 permission globs: `*` matches any run of characters.
function kiroGlobMatches(pattern: string, command: string): boolean {
  const source = pattern.split("*").map((part) =>
    part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  ).join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(command);
}

Deno.test("RepoService.init and upgrade: kiro-cli agent denies read-secret", async () => {
  await withTempDir(async (tempDir) => {
    const repoPath = RepoPath.create(tempDir);
    await testService("0.1.0", tempDir).init(repoPath, { tools: ["kiro"] });

    const configPath = join(tempDir, ".kiro", "agents", "swamp.json");
    const check = async () => {
      const config = await readJson(configPath);
      const shell = config.toolsSettings.shell;
      const denied: string[] = shell.deniedCommands;
      const allowed: string[] = shell.allowedCommands;
      const rules: { match: string[]; effect: string }[] =
        config.permissions.rules;
      const v3Matches = (effect: string, command: string) =>
        rules.some((rule) =>
          rule.effect === effect &&
          rule.match.some((p) => kiroGlobMatches(p, command))
        );
      for (const command of READ_SECRET_COMMANDS) {
        const isDenied = denied.some((p) => kiroCliPatternMatches(p, command));
        const isAllowed = allowed.some((p) =>
          kiroCliPatternMatches(p, command)
        );
        // Denied wins in kiro-cli; anything not allowed prompts.
        assertEquals(
          isDenied || !isAllowed,
          true,
          `auto-approved: ${JSON.stringify(command)}`,
        );
        // kiro-cli 3.0: deny wins over allow in any scope.
        assertEquals(
          v3Matches("deny", command),
          true,
          `not denied by permissions: ${JSON.stringify(command)}`,
        );
      }
      const vaultGet = "swamp vault get my-vault";
      assertEquals(
        denied.some((p) => kiroCliPatternMatches(p, vaultGet)),
        false,
      );
      assertEquals(v3Matches("deny", vaultGet), false);
      assertEquals(v3Matches("allow", vaultGet), true);
    };
    await check();

    // An agent config written before the fix is replaced on upgrade.
    const old = await readJson(configPath);
    delete old.toolsSettings.shell.deniedCommands;
    delete old.permissions;
    await Deno.writeTextFile(configPath, JSON.stringify(old, null, 2));
    await testService("0.2.0", tempDir).upgrade(repoPath, { tools: ["kiro"] });
    await check();
  });
});
