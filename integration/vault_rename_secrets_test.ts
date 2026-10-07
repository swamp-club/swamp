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

// Integration tests for renaming a local_encryption vault through vault edit:
// the vault's stored secrets move with the rename and stay readable through
// VaultService under the new name (swamp-club#2681).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createVaultEditDeps,
  vaultEdit,
  type VaultEditEvent,
} from "../src/libswamp/vaults/edit.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-rename-" });
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

async function renameVault(
  repoDir: string,
  from: string,
  to: string,
): Promise<VaultEditEvent> {
  let last: VaultEditEvent | undefined;
  for await (
    const event of vaultEdit(
      createLibSwampContext(),
      createVaultEditDeps(repoDir),
      {
        vaultNameOrId: from,
        stdinContent:
          `name: ${to}\ntype: local_encryption\nconfig:\n  auto_generate: true\n`,
      },
    )
  ) {
    last = event;
  }
  return last!;
}

async function createVaultWithSecret(
  repoDir: string,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await new YamlVaultConfigRepository(repoDir).save(
    VaultConfig.create(crypto.randomUUID(), name, "local_encryption", {
      auto_generate: true,
    }),
  );
  const vaults = await VaultService.fromRepository(repoDir);
  await vaults.put(name, key, value);
}

Deno.test("vault edit rename: a secret put before the rename is readable under the new name", async () => {
  await withTempDir(async (repoDir) => {
    await createVaultWithSecret(repoDir, "old-vault", "API_KEY", "s3cret");

    const last = await renameVault(repoDir, "old-vault", "new-vault");

    assertEquals(last.kind, "completed");
    const vaults = await VaultService.fromRepository(repoDir);
    assertEquals(await vaults.get("new-vault", "API_KEY"), "s3cret");
    assertEquals(await vaults.list("new-vault"), ["API_KEY"]);
    await assertRejects(() =>
      Deno.lstat(
        join(repoDir, ".swamp", "secrets", "local_encryption", "old-vault"),
      )
    );
  });
});

Deno.test("vault edit rename: refused when secrets already exist under the new name, leaving both vaults intact", async () => {
  await withTempDir(async (repoDir) => {
    await createVaultWithSecret(repoDir, "old-vault", "API_KEY", "old");
    // Secrets left behind under the target name, e.g. by a removed vault.
    const stale = new YamlVaultConfigRepository(repoDir);
    await createVaultWithSecret(repoDir, "stale-vault", "API_KEY", "stale");
    const staleConfig = await stale.findByName("stale-vault");
    await stale.delete(staleConfig!);

    const last = await renameVault(repoDir, "old-vault", "stale-vault");

    assertEquals(last.kind, "error");
    assertStringIncludes(
      (last as Extract<VaultEditEvent, { kind: "error" }>).error.message,
      "Secrets are already stored under vault name 'stale-vault'",
    );
    const vaults = await VaultService.fromRepository(repoDir);
    assertEquals(await vaults.get("old-vault", "API_KEY"), "old");
    assertEquals(
      (await new YamlVaultConfigRepository(repoDir).findByName("old-vault"))
        ?.name,
      "old-vault",
    );
  });
});
