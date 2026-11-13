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
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-home-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("local_encryption: a stored HOME base_dir keeps secrets under that host's home and is never rewritten", async () => {
  await withTempDir(async (repoDir) => {
    await withTempDir(async (home) => {
      const repo = new YamlVaultConfigRepository(repoDir);
      await repo.save(
        VaultConfig.create(
          crypto.randomUUID(),
          "portable",
          "local_encryption",
          {
            auto_generate: true,
            base_dir: "$HOME/.state/vault",
          },
        ),
      );

      await withMockedEnv({ HOME: home }, async () => {
        const vaults = await VaultService.fromRepository(repoDir);
        await vaults.put("portable", "API_KEY", "s3cret");
        assertEquals(await vaults.get("portable", "API_KEY"), "s3cret");
        assertEquals(await vaults.list("portable"), ["API_KEY"]);
      });

      const secret = await Deno.stat(
        join(
          home,
          ".state",
          "vault",
          ".swamp",
          "secrets",
          "local_encryption",
          "portable",
          "API_KEY.enc",
        ),
      );
      assertEquals(secret.isFile, true);
      const stored = await repo.findByName("portable");
      assertEquals(stored?.config.base_dir, "$HOME/.state/vault");
    });
  });
});
