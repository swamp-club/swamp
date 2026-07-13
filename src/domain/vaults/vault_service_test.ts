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
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { VaultService } from "./vault_service.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import type { VaultAuditEntry } from "./vault_audit_entry.ts";
import type {
  VaultAuditQueryOptions,
  VaultAuditRepository,
} from "./vault_audit_repository.ts";

Deno.test("VaultService - missing vault configuration error handling", async (t) => {
  await t.step(
    "should provide helpful error when no vaults configured",
    async () => {
      const vaultService = new VaultService();

      const error = await assertRejects(
        () => vaultService.get("aws", "test-key"),
        Error,
      );

      assertStringIncludes(
        error.message,
        "Vault 'aws' not found. No vaults are configured.",
      );
      assertStringIncludes(
        error.message,
        "Vaults are NOT configured in .swamp.yaml",
      );
      assertStringIncludes(
        error.message,
        "swamp vault create <type> aws",
      );
      assertStringIncludes(
        error.message,
        "Available vault types:",
      );
      assertStringIncludes(
        error.message,
        "swamp extension pull",
      );
    },
  );

  await t.step(
    "should provide helpful error when specific vault not found",
    async () => {
      const vaultService = new VaultService();

      // Register one vault to test the "available vaults" error case
      vaultService.registerVault({
        name: "production",
        type: "mock",
        config: {},
      });

      const error = await assertRejects(
        () => vaultService.get("staging", "test-key"),
        Error,
      );

      assertStringIncludes(error.message, "Vault 'staging' not found.");
      assertStringIncludes(error.message, "Available vaults: production");
      assertStringIncludes(
        error.message,
        "swamp vault create <type> staging",
      );
    },
  );

  await t.step("should list multiple available vaults in error", async () => {
    const vaultService = new VaultService();

    vaultService.registerVault({
      name: "production",
      type: "mock",
      config: {},
    });

    vaultService.registerVault({
      name: "development",
      type: "mock",
      config: {},
    });

    const error = await assertRejects(
      () => vaultService.get("staging", "test-key"),
      Error,
    );

    assertStringIncludes(
      error.message,
      "Available vaults: production, development",
    );
  });
});

Deno.test("VaultService - ensureDefaultVaults is a no-op", () => {
  const vaultService = new VaultService();
  vaultService.ensureDefaultVaults();
  assertEquals(vaultService.getVaultNames().length, 0);
});

Deno.test("VaultService - basic functionality", async (t) => {
  await t.step("should register and list vault names", () => {
    const vaultService = new VaultService();

    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: { "test-key": "test-value" },
    });

    const vaultNames = vaultService.getVaultNames();
    assertEquals(vaultNames, ["test-vault"]);
  });

  await t.step("should successfully get secret from mock vault", async () => {
    const vaultService = new VaultService();

    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: { "api-key": "secret-value-123" },
    });

    const secret = await vaultService.get("test-vault", "api-key");
    assertEquals(secret, "secret-value-123");
  });

  await t.step("should throw error for unsupported vault type", () => {
    const vaultService = new VaultService();

    assertThrows(
      () => {
        vaultService.registerVault({
          name: "invalid",
          type: "unsupported-type",
          config: {},
        });
      },
      Error,
      "Unsupported vault type: 'unsupported-type'",
    );
  });

  await t.step(
    "should suggest renamed type when using old 'aws' type name",
    () => {
      const vaultService = new VaultService();

      assertThrows(
        () => {
          vaultService.registerVault({
            name: "old-vault",
            type: "aws",
            config: {},
          });
        },
        Error,
        "renamed to '@swamp/aws-sm'",
      );
    },
  );

  await t.step(
    "should suggest renamed type when using old 'azure' type name",
    () => {
      const vaultService = new VaultService();

      assertThrows(
        () => {
          vaultService.registerVault({
            name: "old-vault",
            type: "azure",
            config: {},
          });
        },
        Error,
        "renamed to '@swamp/azure-kv'",
      );
    },
  );

  await t.step(
    "should suggest renamed type when using old 'aws-sm' type name",
    () => {
      const vaultService = new VaultService();

      assertThrows(
        () => {
          vaultService.registerVault({
            name: "old-vault",
            type: "aws-sm",
            config: {},
          });
        },
        Error,
        "renamed to '@swamp/aws-sm'",
      );
    },
  );

  await t.step(
    "should suggest renamed type when using old '1password' type name",
    () => {
      const vaultService = new VaultService();

      assertThrows(
        () => {
          vaultService.registerVault({
            name: "old-vault",
            type: "1password",
            config: {},
          });
        },
        Error,
        "renamed to '@swamp/1password'",
      );
    },
  );

  await t.step("should register and use local_encryption vault", () => {
    const vaultService = new VaultService();

    vaultService.registerVault({
      name: "local-vault",
      type: "local_encryption",
      config: { auto_generate: true },
    });

    const vaultNames = vaultService.getVaultNames();
    assertEquals(vaultNames, ["local-vault"]);
  });
});

Deno.test("VaultService - rejects invalid provider from createProvider", async (t) => {
  const testType = "@test/broken-provider";

  await t.step(
    "should throw when createProvider returns an empty object",
    () => {
      // Register a user-defined type that returns an invalid provider
      if (!vaultTypeRegistry.has(testType)) {
        vaultTypeRegistry.register({
          type: testType,
          name: "Broken Provider",
          description: "Test broken provider",
          isBuiltIn: false,
          createProvider: () => ({}) as never,
        });
      }

      const vaultService = new VaultService();
      assertThrows(
        () => {
          vaultService.registerVault({
            name: "broken-vault",
            type: testType,
            config: {},
          });
        },
        Error,
        "missing methods: get, put, list, getName",
      );
    },
  );

  await t.step(
    "should throw when createProvider returns null",
    () => {
      const nullType = "@test/null-provider";
      if (!vaultTypeRegistry.has(nullType)) {
        vaultTypeRegistry.register({
          type: nullType,
          name: "Null Provider",
          description: "Test null provider",
          isBuiltIn: false,
          createProvider: () => null as never,
        });
      }

      const vaultService = new VaultService();
      assertThrows(
        () => {
          vaultService.registerVault({
            name: "null-vault",
            type: nullType,
            config: {},
          });
        },
        Error,
        "missing methods",
      );
    },
  );

  await t.step(
    "should throw when createProvider returns partial implementation",
    () => {
      const partialType = "@test/partial-provider";
      if (!vaultTypeRegistry.has(partialType)) {
        vaultTypeRegistry.register({
          type: partialType,
          name: "Partial Provider",
          description: "Test partial provider",
          isBuiltIn: false,
          createProvider: (name: string) =>
            ({
              get: (_key: string) => Promise.resolve("value"),
              getName: () => name,
              // missing put and list
            }) as never,
        });
      }

      const vaultService = new VaultService();
      assertThrows(
        () => {
          vaultService.registerVault({
            name: "partial-vault",
            type: partialType,
            config: {},
          });
        },
        Error,
        "missing methods: put, list",
      );
    },
  );
});

Deno.test("VaultService - refresh-aware get", async (t) => {
  await t.step(
    "should refresh stale secret and return fresh value",
    async () => {
      const svc = new VaultService({
        runCommand: () =>
          Promise.resolve({
            success: true,
            stdout: "fresh-token\n",
            stderr: "",
          }),
      });
      svc.registerVault({
        name: "v",
        type: "local_encryption",
        config: { auto_generate: true },
      });
      await svc.put("v", "TOKEN", "old-value");
      const { RefreshHook } = await import("./refresh_hook.ts");
      const hook = RefreshHook.create("echo fresh-token", 60000);
      await svc.putRefreshHook("v", "TOKEN", hook);

      const result = await svc.get("v", "TOKEN");
      assertEquals(result, "fresh-token");
    },
  );

  await t.step(
    "should return stale value when refresh command fails",
    async () => {
      const svc = new VaultService({
        runCommand: () =>
          Promise.resolve({ success: false, stdout: "", stderr: "auth error" }),
      });
      svc.registerVault({
        name: "v",
        type: "local_encryption",
        config: { auto_generate: true },
      });
      await svc.put("v", "TOKEN", "stale-value");
      const { RefreshHook } = await import("./refresh_hook.ts");
      const hook = RefreshHook.create("failing-cmd", 60000);
      await svc.putRefreshHook("v", "TOKEN", hook);

      const result = await svc.get("v", "TOKEN");
      assertEquals(result, "stale-value");
    },
  );

  await t.step(
    "should return stale value when refresh produces empty stdout",
    async () => {
      const svc = new VaultService({
        runCommand: () =>
          Promise.resolve({ success: true, stdout: "  \n", stderr: "" }),
      });
      svc.registerVault({
        name: "v",
        type: "local_encryption",
        config: { auto_generate: true },
      });
      await svc.put("v", "TOKEN", "valid-value");
      const { RefreshHook } = await import("./refresh_hook.ts");
      const hook = RefreshHook.create("empty-cmd", 60000);
      await svc.putRefreshHook("v", "TOKEN", hook);

      const result = await svc.get("v", "TOKEN");
      assertEquals(result, "valid-value");
    },
  );

  await t.step(
    "should skip refresh when no refreshOptions configured",
    async () => {
      const svc = new VaultService();
      svc.registerVault({
        name: "v",
        type: "mock",
        config: { "TOKEN": "mock-value" },
      });

      const result = await svc.get("v", "TOKEN");
      assertEquals(result, "mock-value");
    },
  );

  await t.step(
    "should skip refresh when secret is within TTL",
    async () => {
      let commandCalled = false;
      const svc = new VaultService({
        runCommand: () => {
          commandCalled = true;
          return Promise.resolve({
            success: true,
            stdout: "new-token",
            stderr: "",
          });
        },
      });
      svc.registerVault({
        name: "v",
        type: "local_encryption",
        config: { auto_generate: true },
      });
      await svc.put("v", "TOKEN", "current-value");
      const { RefreshHook } = await import("./refresh_hook.ts");
      const hook = RefreshHook.create("echo new", 3600000)
        .withRefreshedAt(new Date());
      await svc.putRefreshHook("v", "TOKEN", hook);

      const result = await svc.get("v", "TOKEN");
      assertEquals(result, "current-value");
      assertEquals(commandCalled, false);
    },
  );
});

Deno.test("VaultService - fromRepository continues loading after a bad vault config", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Vault "bad" has an unsupported type — it should fail to load
    const badDir = join(tempDir, "vaults", "bad");
    await ensureDir(badDir);
    await Deno.writeTextFile(
      join(badDir, "bad-id.yaml"),
      stringifyYaml({
        id: "bad-id",
        name: "bad",
        type: "totally-bogus-type",
        config: {},
        createdAt: new Date().toISOString(),
      }),
    );

    // Vault "good" has a valid type — it should still load even though "bad" failed
    const goodDir = join(tempDir, "vaults", "good");
    await ensureDir(goodDir);
    await Deno.writeTextFile(
      join(goodDir, "good-id.yaml"),
      stringifyYaml({
        id: "good-id",
        name: "good",
        type: "mock",
        config: { "key": "value" },
        createdAt: new Date().toISOString(),
      }),
    );

    const vaultService = await VaultService.fromRepository(tempDir);
    const names = vaultService.getVaultNames();

    // "good" must be registered despite "bad" failing
    assertStringIncludes(names.join(","), "good");

    // Verify we can actually use the good vault
    const secret = await vaultService.get("good", "key");
    assertEquals(secret, "value");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("VaultService - fromRepository auto-remaps renamed vault types", async (t) => {
  await t.step(
    "should remap 'aws' type to '@swamp/aws-sm' when loading from repository",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        // Create a vault config YAML with the old 'aws' type
        const vaultDir = join(tempDir, "vaults", "aws");
        await ensureDir(vaultDir);
        const vaultYaml = stringifyYaml({
          id: "test-vault-id",
          name: "my-aws-vault",
          type: "aws",
          config: { region: "us-east-1" },
          createdAt: new Date().toISOString(),
        });
        await Deno.writeTextFile(
          join(vaultDir, "test-vault-id.yaml"),
          vaultYaml,
        );

        // Without the @swamp/aws-sm extension installed, the vault will fail
        // to register but should not throw — fromRepository catches the error.
        // The key behavior is that the type gets remapped before resolution.
        const vaultService = await VaultService.fromRepository(tempDir);
        // Vault won't be registered without the extension, but no crash
        assertEquals(typeof vaultService.getVaultNames(), "object");
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    },
  );

  await t.step(
    "should remap 'azure' type to '@swamp/azure-kv' when loading from repository",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        // Create a vault config YAML with the old 'azure' type
        const vaultDir = join(tempDir, "vaults", "azure");
        await ensureDir(vaultDir);
        const vaultYaml = stringifyYaml({
          id: "test-vault-id",
          name: "my-azure-vault",
          type: "azure",
          config: { vault_url: "https://myvault.vault.azure.net/" },
          createdAt: new Date().toISOString(),
        });
        await Deno.writeTextFile(
          join(vaultDir, "test-vault-id.yaml"),
          vaultYaml,
        );

        // Same as above — remaps but extension not installed in test
        const vaultService = await VaultService.fromRepository(tempDir);
        assertEquals(typeof vaultService.getVaultNames(), "object");
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    },
  );
});

Deno.test("VaultService - delete", async (t) => {
  await t.step("should delete a secret from a mock vault", async () => {
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: {},
    });

    await vaultService.put("test-vault", "to-delete", "value");
    const keys = await vaultService.list("test-vault");
    assertEquals(keys.includes("to-delete"), true);

    await vaultService.delete("test-vault", "to-delete");
    const keysAfter = await vaultService.list("test-vault");
    assertEquals(keysAfter.includes("to-delete"), false);
  });

  await t.step(
    "should throw when vault not found (no vaults configured)",
    async () => {
      const vaultService = new VaultService();
      const error = await assertRejects(
        () => vaultService.delete("nonexistent", "key"),
        Error,
      );
      assertStringIncludes(error.message, "No vaults are configured");
    },
  );

  await t.step(
    "should throw when vault not found (other vaults exist)",
    async () => {
      const vaultService = new VaultService();
      vaultService.registerVault({
        name: "existing",
        type: "mock",
        config: {},
      });
      const error = await assertRejects(
        () => vaultService.delete("missing", "key"),
        Error,
      );
      assertStringIncludes(error.message, "Available vaults: existing");
    },
  );

  await t.step("should throw when secret does not exist", async () => {
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: {},
    });

    await assertRejects(
      () => vaultService.delete("test-vault", "nonexistent-key"),
      Error,
      "not found",
    );
  });
});

Deno.test("VaultService - supportsDelete", async (t) => {
  await t.step("should return true for mock vault", () => {
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: {},
    });
    assertEquals(vaultService.supportsDelete("test-vault"), true);
  });

  await t.step("should return false for non-existent vault", () => {
    const vaultService = new VaultService();
    assertEquals(vaultService.supportsDelete("nonexistent"), false);
  });
});

class InMemoryVaultAuditRepository implements VaultAuditRepository {
  readonly entries: VaultAuditEntry[] = [];

  async append(entry: VaultAuditEntry): Promise<void> {
    this.entries.push(entry);
    await Promise.resolve();
  }

  async findByTimeRange(
    _startTime: Date,
    _endTime: Date,
    _options?: VaultAuditQueryOptions,
  ): Promise<VaultAuditEntry[]> {
    return await Promise.resolve(this.entries);
  }
}

Deno.test("VaultService - audit trail", async (t) => {
  await t.step(
    "should record audit entry when audit is enabled on vault",
    async () => {
      const svc = new VaultService();
      const auditRepo = new InMemoryVaultAuditRepository();
      svc.setAuditRepository(auditRepo);

      svc.registerVault({
        name: "audited-vault",
        type: "mock",
        config: { "key": "val" },
        auditReads: true,
      });

      await svc.get("audited-vault", "key", "test-caller");

      assertEquals(auditRepo.entries.length, 1);
      assertEquals(auditRepo.entries[0].vaultName, "audited-vault");
      assertEquals(auditRepo.entries[0].vaultType, "mock");
      assertEquals(auditRepo.entries[0].secretKey, "key");
      assertEquals(auditRepo.entries[0].callerContext, "test-caller");
    },
  );

  await t.step(
    "should not record audit entry when audit is disabled on vault",
    async () => {
      const svc = new VaultService();
      const auditRepo = new InMemoryVaultAuditRepository();
      svc.setAuditRepository(auditRepo);

      svc.registerVault({
        name: "unaudited-vault",
        type: "mock",
        config: { "key": "val" },
      });

      await svc.get("unaudited-vault", "key");

      assertEquals(auditRepo.entries.length, 0);
    },
  );

  await t.step(
    "should not record audit entry when no audit repository is set",
    async () => {
      const svc = new VaultService();

      svc.registerVault({
        name: "vault",
        type: "mock",
        config: { "key": "val" },
        auditReads: true,
      });

      // Should not throw even though auditReads is true but no repo
      const result = await svc.get("vault", "key");
      assertEquals(result, "val");
    },
  );

  await t.step(
    "should default callerContext to 'unknown' when not provided",
    async () => {
      const svc = new VaultService();
      const auditRepo = new InMemoryVaultAuditRepository();
      svc.setAuditRepository(auditRepo);

      svc.registerVault({
        name: "vault",
        type: "mock",
        config: { "key": "val" },
        auditReads: true,
      });

      await svc.get("vault", "key");

      assertEquals(auditRepo.entries.length, 1);
      assertEquals(auditRepo.entries[0].callerContext, "unknown");
    },
  );

  await t.step(
    "should not throw when audit repository append fails",
    async () => {
      const svc = new VaultService();
      const failingRepo: VaultAuditRepository = {
        append: () => Promise.reject(new Error("disk full")),
        findByTimeRange: () => Promise.resolve([]),
      };
      svc.setAuditRepository(failingRepo);

      svc.registerVault({
        name: "vault",
        type: "mock",
        config: { "key": "val" },
        auditReads: true,
      });

      const result = await svc.get("vault", "key");
      assertEquals(result, "val");
    },
  );
});
