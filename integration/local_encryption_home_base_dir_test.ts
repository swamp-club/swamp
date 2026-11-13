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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../src/domain/errors.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { EventBus } from "../src/domain/events/event_bus.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createVaultPutDeps,
  vaultPut,
  vaultPutPreview,
} from "../src/libswamp/vaults/put.ts";
import { collect } from "../src/libswamp/testing.ts";

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

Deno.test("local_encryption: the first vault put creates a HOME base_dir that does not exist yet", async () => {
  await withTempDir(async (repoDir) => {
    await withTempDir(async (home) => {
      await new YamlVaultConfigRepository(repoDir).save(
        VaultConfig.create(crypto.randomUUID(), "fresh", "local_encryption", {
          auto_generate: true,
          base_dir: "$HOME/.state/vault",
        }),
      );

      await withMockedEnv({ HOME: home }, async () => {
        const ctx = createLibSwampContext();
        const deps = createVaultPutDeps(repoDir, new EventBus());
        const preview = await vaultPutPreview(ctx, deps, "fresh", "API_KEY");
        assertEquals(preview.secretExists, false);
        const events = await collect(
          vaultPut(ctx, deps, {
            vaultName: "fresh",
            key: "API_KEY",
            value: "s3cret",
            overwritten: false,
          }),
        );
        assertEquals(events.at(-1)?.kind, "completed");
        const vaults = await VaultService.fromRepository(repoDir);
        assertEquals(await vaults.get("fresh", "API_KEY"), "s3cret");
      });
    });
  });
});

Deno.test("local_encryption: listing a vault whose base_dir is missing reports it instead of an empty vault", async () => {
  await withTempDir(async (repoDir) => {
    await withTempDir(async (home) => {
      await new YamlVaultConfigRepository(repoDir).save(
        VaultConfig.create(crypto.randomUUID(), "moved", "local_encryption", {
          auto_generate: true,
          base_dir: "$HOME/not-on-this-host",
        }),
      );
      await withMockedEnv({ HOME: home }, async () => {
        const vaults = await VaultService.fromRepository(repoDir);
        await assertRejects(
          () => vaults.list("moved"),
          UserError,
          "base_dir does not exist",
        );
      });
    });
  });
});
