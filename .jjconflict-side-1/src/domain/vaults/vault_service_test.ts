// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
      assertStringIncludes(error.message, "1password");
      assertStringIncludes(
        error.message,
        "Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
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

Deno.test("VaultService - ensureDefaultVaults behavior", async (t) => {
  await t.step(
    "should not create default vault when no AWS credentials",
    () => {
      const vaultService = new VaultService();

      // Clear any existing AWS env vars for this test
      const originalAccessKey = Deno.env.get("AWS_ACCESS_KEY_ID");
      const originalSecretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
      const originalRegion = Deno.env.get("AWS_REGION");

      if (originalAccessKey) Deno.env.delete("AWS_ACCESS_KEY_ID");
      if (originalSecretKey) Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      if (originalRegion) Deno.env.delete("AWS_REGION");

      try {
        vaultService.ensureDefaultVaults();
        assertEquals(vaultService.getVaultNames().length, 0);
      } finally {
        // Restore original env vars
        if (originalAccessKey) {
          Deno.env.set("AWS_ACCESS_KEY_ID", originalAccessKey);
        }
        if (originalSecretKey) {
          Deno.env.set("AWS_SECRET_ACCESS_KEY", originalSecretKey);
        }
        if (originalRegion) {
          Deno.env.set("AWS_REGION", originalRegion);
        }
      }
    },
  );

  await t.step(
    "should not create default vault when credentials present but no region",
    () => {
      const vaultService = new VaultService();

      const originalRegion = Deno.env.get("AWS_REGION");
      if (originalRegion) Deno.env.delete("AWS_REGION");

      Deno.env.set("AWS_ACCESS_KEY_ID", "test-key");
      Deno.env.set("AWS_SECRET_ACCESS_KEY", "test-secret");

      try {
        vaultService.ensureDefaultVaults();
        assertEquals(vaultService.getVaultNames().length, 0);
      } finally {
        Deno.env.delete("AWS_ACCESS_KEY_ID");
        Deno.env.delete("AWS_SECRET_ACCESS_KEY");
        if (originalRegion) Deno.env.set("AWS_REGION", originalRegion);
      }
    },
  );

  await t.step(
    "should create default AWS vault when credentials and region present",
    () => {
      const vaultService = new VaultService();

      // Set mock AWS credentials and region
      Deno.env.set("AWS_ACCESS_KEY_ID", "test-key");
      Deno.env.set("AWS_SECRET_ACCESS_KEY", "test-secret");
      Deno.env.set("AWS_REGION", "us-east-1");

      try {
        vaultService.ensureDefaultVaults();
        const vaultNames = vaultService.getVaultNames();
        assertEquals(vaultNames.length, 1);
        assertEquals(vaultNames[0], "aws-sm");
      } finally {
        // Clean up
        Deno.env.delete("AWS_ACCESS_KEY_ID");
        Deno.env.delete("AWS_SECRET_ACCESS_KEY");
        Deno.env.delete("AWS_REGION");
      }
    },
  );

  await t.step("should not create duplicate default vault", () => {
    const vaultService = new VaultService();

    // Manually register an AWS vault first
    vaultService.registerVault({
      name: "aws-sm",
      type: "aws-sm",
      config: { region: "us-east-1" },
    });

    // Set mock AWS credentials and region
    Deno.env.set("AWS_ACCESS_KEY_ID", "test-key");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test-secret");
    Deno.env.set("AWS_REGION", "us-east-1");

    try {
      vaultService.ensureDefaultVaults();
      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames.length, 1);
      assertEquals(vaultNames[0], "aws-sm");
    } finally {
      // Clean up
      Deno.env.delete("AWS_ACCESS_KEY_ID");
      Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      Deno.env.delete("AWS_REGION");
    }
  });
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
        "renamed to 'aws-sm'",
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
        "renamed to 'azure-kv'",
      );
    },
  );

  await t.step("should register azure-kv vault", () => {
    const vaultService = new VaultService();

    vaultService.registerVault({
      name: "my-azure-vault",
      type: "azure-kv",
      config: { vault_url: "https://myvault.vault.azure.net/" },
    });

    const vaultNames = vaultService.getVaultNames();
    assertEquals(vaultNames, ["my-azure-vault"]);
  });

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

  await t.step("should register 1password vault", () => {
    const vaultService = new VaultService();

    vaultService.registerVault({
      name: "my-1p-vault",
      type: "1password",
      config: { op_vault: "Engineering" },
    });

    const vaultNames = vaultService.getVaultNames();
    assertEquals(vaultNames, ["my-1p-vault"]);
  });
});

Deno.test("VaultService - fromRepository auto-remaps renamed vault types", async (t) => {
  await t.step(
    "should remap 'aws' type to 'aws-sm' when loading from repository",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        // Create a vault config YAML with the old 'aws' type
        const vaultDir = join(tempDir, ".swamp", "vault", "aws");
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

        const vaultService = await VaultService.fromRepository(tempDir);
        const vaultNames = vaultService.getVaultNames();

        // The vault should have loaded successfully with the remapped type
        assertEquals(vaultNames.includes("my-aws-vault"), true);
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    },
  );

  await t.step(
    "should remap 'azure' type to 'azure-kv' when loading from repository",
    async () => {
      const tempDir = await Deno.makeTempDir();
      try {
        // Create a vault config YAML with the old 'azure' type
        const vaultDir = join(tempDir, ".swamp", "vault", "azure");
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

        const vaultService = await VaultService.fromRepository(tempDir);
        const vaultNames = vaultService.getVaultNames();

        // The vault should have loaded successfully with the remapped type
        assertEquals(vaultNames.includes("my-azure-vault"), true);
      } finally {
        await Deno.remove(tempDir, { recursive: true });
      }
    },
  );
});
