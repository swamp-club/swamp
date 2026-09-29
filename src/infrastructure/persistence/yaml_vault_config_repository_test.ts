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
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import {
  VaultConfigParseError,
  YamlVaultConfigRepository,
} from "./yaml_vault_config_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

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

async function withVaultDir(
  fn: (repoDir: string, vaultsDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-repo-test-" });
  try {
    await fn(dir, join(dir, "vaults"));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function writeVaultFile(
  vaultsDir: string,
  type: string,
  id: string,
  content: string,
): Promise<string> {
  const typeDir = join(vaultsDir, ...type.split("/"));
  await ensureDir(typeDir);
  const path = join(typeDir, `${id}.yaml`);
  await Deno.writeTextFile(path, content);
  return path;
}

const BROKEN_YAML = "name: [broken\n  : : :\n";

function validVault(id: string, name: string, type = "local_encryption") {
  return VaultConfig.fromData({
    id,
    name,
    type,
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

Deno.test("YamlVaultConfigRepository: a file that is not YAML throws VaultConfigParseError naming the file, type and id", async () => {
  await withVaultDir(async (repoDir, vaultsDir) => {
    const path = await writeVaultFile(
      vaultsDir,
      "local_encryption",
      "vault-1",
      BROKEN_YAML,
    );
    const repo = new YamlVaultConfigRepository(repoDir);

    const error = await assertRejects(
      () => repo.findById("local_encryption", "vault-1"),
      VaultConfigParseError,
    );

    assertInstanceOf(error, UserError);
    assertPathEquals(error.path, path);
    assertEquals(error.vaultType, "local_encryption");
    assertEquals(error.vaultId, "vault-1");
    assertStringIncludes(error.message, "Invalid vault config in");
    assertStringIncludes(
      error.message,
      "swamp vault edit vault-1 --type local_encryption",
    );
  });
});

Deno.test("YamlVaultConfigRepository: a file missing required fields throws VaultConfigParseError listing them", async () => {
  await withVaultDir(async (repoDir, vaultsDir) => {
    await writeVaultFile(vaultsDir, "mock", "bad", "name: bad-vault\n");
    const repo = new YamlVaultConfigRepository(repoDir);

    const error = await assertRejects(
      () => repo.findAll(),
      VaultConfigParseError,
    );

    assertEquals(error.vaultId, "bad");
    assertStringIncludes(error.message, "id:");
    assertStringIncludes(error.message, "createdAt:");
  });
});

Deno.test("YamlVaultConfigRepository: the parse error derives a namespaced vault type from its two directories", async () => {
  await withVaultDir(async (repoDir, vaultsDir) => {
    await writeVaultFile(vaultsDir, "@openbao/vault", "vault-1", BROKEN_YAML);
    const repo = new YamlVaultConfigRepository(repoDir);

    const error = await assertRejects(
      () => repo.findById("@openbao/vault", "vault-1"),
      VaultConfigParseError,
    );

    assertEquals(error.vaultType, "@openbao/vault");
    assertEquals(error.vaultId, "vault-1");
  });
});

Deno.test("YamlVaultConfigRepository: findByName finds a valid vault whatever broken files sit beside it", async () => {
  await withVaultDir(async (repoDir, vaultsDir) => {
    const repo = new YamlVaultConfigRepository(repoDir);
    await repo.save(validVault("vault-b", "good-vault"));
    // Broken files that sort before and after the valid one.
    await writeVaultFile(vaultsDir, "local_encryption", "vault-a", BROKEN_YAML);
    await writeVaultFile(vaultsDir, "local_encryption", "vault-c", BROKEN_YAML);

    const found = await repo.findByName("good-vault");

    assertEquals(found?.id, "vault-b");
  });
});

Deno.test("YamlVaultConfigRepository: findByName with no match reports a file that did not parse", async () => {
  await withVaultDir(async (repoDir, vaultsDir) => {
    const repo = new YamlVaultConfigRepository(repoDir);
    await repo.save(validVault("vault-b", "good-vault"));
    await writeVaultFile(vaultsDir, "local_encryption", "vault-a", BROKEN_YAML);

    const error = await assertRejects(
      () => repo.findByName("missing"),
      VaultConfigParseError,
    );

    assertEquals(error.vaultId, "vault-a");
  });
});

Deno.test("YamlVaultConfigRepository: findByName does not report the broken file it was told to ignore", async () => {
  await withVaultDir(async (repoDir, vaultsDir) => {
    const repo = new YamlVaultConfigRepository(repoDir);
    const path = await writeVaultFile(
      vaultsDir,
      "local_encryption",
      "vault-a",
      BROKEN_YAML,
    );

    assertEquals(await repo.findByName("missing", path), null);
  });
});

Deno.test("YamlVaultConfigRepository: getPath rejects an id that leaves the type directory", async () => {
  await withVaultDir((repoDir) => {
    const repo = new YamlVaultConfigRepository(repoDir);

    for (const id of ["../outside", "../../etc/passwd", "nested/id"]) {
      assertThrows(
        () => repo.getPath("local_encryption", id),
        UserError,
        "Invalid vault id",
      );
    }
    return Promise.resolve();
  });
});
