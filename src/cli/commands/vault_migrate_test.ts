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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { MockVaultProvider } from "../../domain/vaults/mock_vault_provider.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { VERSION } from "./version.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("vaultMigrateCommand: module loads", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  assertEquals(vaultMigrateCommand.getName(), "migrate");
});

Deno.test("vaultMigrateCommand: --to-type is not required", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const toTypeOpt = options.find((o) => o.name === "to-type");
  assertEquals(toTypeOpt !== undefined, true);
  assertEquals(toTypeOpt?.required ?? false, false);
});

Deno.test("vaultMigrateCommand: has --config option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "config");
  assertEquals(opt !== undefined, true);
});

Deno.test("vaultMigrateCommand: has --force option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "force");
  assertEquals(opt !== undefined, true);
});

Deno.test("vaultMigrateCommand: has --dry-run option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "dry-run");
  assertEquals(opt !== undefined, true);
});

Deno.test("vaultMigrateCommand: has --repo-dir option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "repo-dir");
  assertEquals(opt !== undefined, true);
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-migrate-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("vaultMigrateCommand: a local migrate keeps a local_encryption key source it names (swamp-club#2690)", async () => {
  const sourceType = `@test/cli-migrate-source-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: sourceType,
    name: "Migrate source",
    description: "In-memory vault for the local migrate test",
    isBuiltIn: false,
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await withTempDir(async (dir) => {
      const homeDir = join(dir, "test-home");
      await new RepoService(VERSION, {
        homeDir,
        configDir: join(homeDir, ".config", "swamp"),
      }).init(RepoPath.create(dir), { tools: [] });
      const repo = new YamlVaultConfigRepository(dir);
      await repo.save(
        VaultConfig.create(crypto.randomUUID(), "src-vault", sourceType, {}),
      );
      const config = {
        auto_generate: true,
        base_dir: dir,
        key_file: join(dir, "custom.key"),
      };

      const { vaultMigrateCommand } = await import("./vault_migrate.ts");
      const originalLog = console.log;
      console.log = () => {};
      try {
        await new Command()
          .globalOption("--json", "JSON output")
          .command("migrate", vaultMigrateCommand)
          .parse([
            "migrate",
            "src-vault",
            "--to-type",
            "local_encryption",
            "--config",
            JSON.stringify(config),
            "--yes",
            "--repo-dir",
            dir,
            "--json",
          ]);
      } finally {
        console.log = originalLog;
      }

      const saved = await repo.findByName("src-vault");
      assertEquals(saved?.type, "local_encryption");
      assertEquals(saved?.config, config);
    });
  } finally {
    vaultTypeRegistry.invalidateType(sourceType);
  }
});
