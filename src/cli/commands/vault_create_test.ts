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
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { vaultCreateCommand } from "./vault_create.ts";
import { VERSION } from "./version.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-create-" });
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

Deno.test("vaultCreateCommand: a local create keeps a local_encryption key source it names (swamp-club#2690)", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    const config = {
      auto_generate: true,
      base_dir: dir,
      key_file: join(dir, "custom.key"),
    };

    const originalLog = console.log;
    console.log = () => {};
    try {
      await new Command()
        .globalOption("--json", "JSON output")
        .command("create", vaultCreateCommand)
        .parse([
          "create",
          "local_encryption",
          "local-vault",
          "--config",
          JSON.stringify(config),
          "--repo-dir",
          dir,
          "--json",
        ]);
    } finally {
      console.log = originalLog;
    }

    const saved = await new YamlVaultConfigRepository(dir).findByName(
      "local-vault",
    );
    assertEquals(saved?.config, config);
  });
});
