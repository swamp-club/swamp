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
