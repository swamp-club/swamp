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

import { assertEquals, assertThrows } from "@std/assert";
import { AzureKvVaultProvider } from "./azure_kv_vault_provider.ts";

Deno.test("AzureKvVaultProvider - constructor and configuration", async (t) => {
  await t.step("should store and return the vault name via getName", () => {
    const provider = new AzureKvVaultProvider("my-azure-vault", {
      vault_url: "https://myvault.vault.azure.net/",
    });
    assertEquals(provider.getName(), "my-azure-vault");
  });

  await t.step("should accept config with vault_url and secret_prefix", () => {
    const provider = new AzureKvVaultProvider("prefixed-vault", {
      vault_url: "https://myvault.vault.azure.net/",
      secret_prefix: "swamp/",
    });
    assertEquals(provider.getName(), "prefixed-vault");
  });

  await t.step("should throw error when vault_url is empty", () => {
    assertThrows(
      () =>
        new AzureKvVaultProvider("bad-vault", {
          vault_url: "",
        }),
      Error,
      "Azure Key Vault URL is required",
    );
  });

  await t.step("should handle various vault name formats", () => {
    let provider = new AzureKvVaultProvider("simple", {
      vault_url: "https://myvault.vault.azure.net/",
    });
    assertEquals(provider.getName(), "simple");

    provider = new AzureKvVaultProvider("my-production-vault", {
      vault_url: "https://myvault.vault.azure.net/",
    });
    assertEquals(provider.getName(), "my-production-vault");
  });

  await t.step("should default secret_prefix to empty string", () => {
    // Provider should be created successfully without secret_prefix
    const provider = new AzureKvVaultProvider("no-prefix", {
      vault_url: "https://myvault.vault.azure.net/",
    });
    assertEquals(provider.getName(), "no-prefix");
  });
});

// Note: Integration tests for get/put/list operations require Azure credentials
// and an Azure Key Vault instance. The Azure SDK operations are tested through
// integration tests or manual testing.
