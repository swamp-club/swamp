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
        "Available vault types: aws, local_encryption",
      );
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

      if (originalAccessKey) Deno.env.delete("AWS_ACCESS_KEY_ID");
      if (originalSecretKey) Deno.env.delete("AWS_SECRET_ACCESS_KEY");

      try {
        vaultService.ensureDefaultVaults();
        assertEquals(vaultService.getVaultNames().length, 0);
      } finally {
        // Restore original env vars
        if (originalAccessKey) {
          Deno.env.set(
            "AWS_ACCESS_KEY_ID",
            originalAccessKey,
          );
        }
        if (originalSecretKey) {
          Deno.env.set(
            "AWS_SECRET_ACCESS_KEY",
            originalSecretKey,
          );
        }
      }
    },
  );

  await t.step(
    "should create default AWS vault when credentials present",
    () => {
      const vaultService = new VaultService();

      // Set mock AWS credentials
      Deno.env.set("AWS_ACCESS_KEY_ID", "test-key");
      Deno.env.set("AWS_SECRET_ACCESS_KEY", "test-secret");

      try {
        vaultService.ensureDefaultVaults();
        const vaultNames = vaultService.getVaultNames();
        assertEquals(vaultNames.length, 1);
        assertEquals(vaultNames[0], "aws");
      } finally {
        // Clean up
        Deno.env.delete("AWS_ACCESS_KEY_ID");
        Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      }
    },
  );

  await t.step("should not create duplicate default vault", () => {
    const vaultService = new VaultService();

    // Manually register an AWS vault first
    vaultService.registerVault({
      name: "aws",
      type: "aws",
      config: {},
    });

    // Set mock AWS credentials
    Deno.env.set("AWS_ACCESS_KEY_ID", "test-key");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test-secret");

    try {
      vaultService.ensureDefaultVaults();
      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames.length, 1);
      assertEquals(vaultNames[0], "aws");
    } finally {
      // Clean up
      Deno.env.delete("AWS_ACCESS_KEY_ID");
      Deno.env.delete("AWS_SECRET_ACCESS_KEY");
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
          type: "unsupported-type" as "aws" | "mock" | "local_encryption",
          config: {},
        });
      },
      Error,
      "Unsupported vault type: unsupported-type",
    );
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
});
