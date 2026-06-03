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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { YamlVaultConfigRepository } from "./yaml_vault_config_repository.ts";

Deno.test("YamlVaultConfigRepository - normal vault types resolve correctly", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    // These should not throw - normal vault types
    const resultAws = await repo.findAllByType("aws-sm");
    const resultLocal = await repo.findAllByType("local_encryption");
    // Both return empty arrays since the vault dir doesn't exist yet
    if (
      !Array.isArray(resultAws) || !Array.isArray(resultLocal)
    ) {
      throw new Error("Expected arrays");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - path traversal via ../../.ssh throws", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    await assertRejects(
      () => repo.findAllByType("../../.ssh"),
      Error,
      "Path traversal detected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - path traversal via ../foo throws", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    await assertRejects(
      () => repo.findAllByType("../foo"),
      Error,
      "Path traversal detected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - save and find namespaced vault type", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    const config = VaultConfig.create(
      "test-id-1",
      "my-hcv",
      "@openbao/vault",
      { address: "https://vault.example.com:8200", token: "test" },
    );
    await repo.save(config);

    const found = await repo.findByName("my-hcv");
    assertEquals(found?.name, "my-hcv");
    assertEquals(found?.type, "@openbao/vault");
    assertEquals(found?.config.address, "https://vault.example.com:8200");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - findAll includes namespaced vault types", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);

    const flat = VaultConfig.create("id-flat", "flat-vault", "mock", {});
    const scoped = VaultConfig.create(
      "id-scoped",
      "scoped-vault",
      "@openbao/vault",
      { address: "https://vault.example.com:8200" },
    );
    await repo.save(flat);
    await repo.save(scoped);

    const all = await repo.findAll();
    const names = all.map((c) => c.name).sort();
    assertEquals(names, ["flat-vault", "scoped-vault"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - findAllByType works for namespaced type", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);

    const v1 = VaultConfig.create(
      "id-1",
      "vault-one",
      "@openbao/vault",
      { address: "https://v1.example.com:8200" },
    );
    const v2 = VaultConfig.create(
      "id-2",
      "vault-two",
      "@openbao/vault",
      { address: "https://v2.example.com:8200" },
    );
    const other = VaultConfig.create("id-3", "other-vault", "mock", {});
    await repo.save(v1);
    await repo.save(v2);
    await repo.save(other);

    const results = await repo.findAllByType("@openbao/vault");
    assertEquals(results.length, 2);
    const names = results.map((c) => c.name).sort();
    assertEquals(names, ["vault-one", "vault-two"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - findById works for namespaced type", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    const config = VaultConfig.create(
      "id-abc",
      "my-vault",
      "@openbao/vault",
      { address: "https://vault.example.com:8200" },
    );
    await repo.save(config);

    const found = await repo.findById("@openbao/vault", "id-abc");
    assertEquals(found?.name, "my-vault");
    assertEquals(found?.type, "@openbao/vault");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - rejects malformed YAML config", async (t) => {
  await t.step("should reject YAML missing required 'id' field", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const vaultDir = join(dir, "vaults", "mock");
      await ensureDir(vaultDir);
      // Write YAML missing the 'id' field
      await Deno.writeTextFile(
        join(vaultDir, "bad.yaml"),
        "name: bad-vault\ntype: mock\nconfig: {}\ncreatedAt: '2025-01-01T00:00:00Z'\n",
      );

      const repo = new YamlVaultConfigRepository(dir);
      const error = await assertRejects(
        () => repo.findAll(),
        Error,
      );
      assertStringIncludes(error.message, "Invalid vault config");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step(
    "should reject YAML missing required 'name' field",
    async () => {
      const dir = await Deno.makeTempDir();
      try {
        const vaultDir = join(dir, "vaults", "mock");
        await ensureDir(vaultDir);
        await Deno.writeTextFile(
          join(vaultDir, "bad.yaml"),
          "id: test-id\ntype: mock\nconfig: {}\ncreatedAt: '2025-01-01T00:00:00Z'\n",
        );

        const repo = new YamlVaultConfigRepository(dir);
        const error = await assertRejects(
          () => repo.findAll(),
          Error,
        );
        assertStringIncludes(error.message, "Invalid vault config");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  );

  await t.step(
    "should reject YAML with completely wrong structure",
    async () => {
      const dir = await Deno.makeTempDir();
      try {
        const vaultDir = join(dir, "vaults", "mock");
        await ensureDir(vaultDir);
        await Deno.writeTextFile(
          join(vaultDir, "bad.yaml"),
          "just-a-string\n",
        );

        const repo = new YamlVaultConfigRepository(dir);
        const error = await assertRejects(
          () => repo.findAll(),
          Error,
        );
        assertStringIncludes(error.message, "Invalid vault config");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  );

  await t.step("should default config to empty object if missing", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const vaultDir = join(dir, "vaults", "mock");
      await ensureDir(vaultDir);
      // Config field omitted - should default to {}
      await Deno.writeTextFile(
        join(vaultDir, "ok.yaml"),
        "id: test-id\nname: ok-vault\ntype: mock\ncreatedAt: '2025-01-01T00:00:00Z'\n",
      );

      const repo = new YamlVaultConfigRepository(dir);
      const configs = await repo.findAll();
      assertEquals(configs.length, 1);
      assertEquals(configs[0].name, "ok-vault");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
