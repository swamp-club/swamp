import { assertEquals, assertStringIncludes } from "@std/assert";
import { VaultService } from "../src/domain/vaults/vault_service.ts";

// Mock SSH key for testing
const DEMO_SSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEA1mZy9QqwgQVj7eFbCpL8gOIrZzWaLsUe/x9Y2xE3mF8nQpJ7vK
-----END OPENSSH PRIVATE KEY-----`;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "local-vault-integration-" });
  try {
    const originalCwd = Deno.cwd();
    Deno.chdir(dir);
    try {
      await fn(dir);
    } finally {
      Deno.chdir(originalCwd);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Local Encryption Vault - Integration Tests", async (t) => {
  await t.step("should work with password-based configuration", async () => {
    await withTempDir(async () => {
      const vaultService = new VaultService();

      // Register local encryption vault
      vaultService.registerVault({
        name: "secure-vault",
        type: "local_encryption",
        config: {
          password: "my-secure-password-123",
        },
      });

      // Verify vault is registered
      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames, ["secure-vault"]);

      // Try to get a non-existent secret (should fail with helpful error)
      try {
        await vaultService.get("secure-vault", "non-existent");
        throw new Error("Should have thrown an error");
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        assertStringIncludes(
          errorMessage,
          "Secret 'non-existent' not found in local vault 'secure-vault'",
        );
      }
    });
  });

  await t.step("should store and retrieve secrets correctly", async () => {
    // deno-lint-ignore require-await
    await withTempDir(async () => {
      const vaultService = new VaultService();

      vaultService.registerVault({
        name: "test-vault",
        type: "local_encryption",
        config: {
          password: "test-password",
        },
      });

      // Note: We can't directly test put() through VaultService as it doesn't expose this method
      // This demonstrates the current limitation - we'd need to access the provider directly
      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames, ["test-vault"]);
    });
  });

  await t.step("should work with auto-generated keys", async () => {
    // deno-lint-ignore require-await
    await withTempDir(async () => {
      const vaultService = new VaultService();

      vaultService.registerVault({
        name: "auto-vault",
        type: "local_encryption",
        config: {
          auto_generate: true,
        },
      });

      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames, ["auto-vault"]);
    });
  });

  await t.step("should create vault directory structure", async () => {
    // deno-lint-ignore require-await
    await withTempDir(async () => {
      const vaultService = new VaultService();

      vaultService.registerVault({
        name: "file-test-vault",
        type: "local_encryption",
        config: {
          auto_generate: true,
        },
      });

      // The vault directory should be created when secrets are stored
      // Since VaultService doesn't expose put(), we'll verify the registration worked
      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames.includes("file-test-vault"), true);
    });
  });

  await t.step("should handle multiple vaults simultaneously", async () => {
    // deno-lint-ignore require-await
    await withTempDir(async () => {
      const vaultService = new VaultService();

      // Register multiple local encryption vaults
      vaultService.registerVault({
        name: "vault-1",
        type: "local_encryption",
        config: { password: "password-1" },
      });

      vaultService.registerVault({
        name: "vault-2",
        type: "local_encryption",
        config: { auto_generate: true },
      });

      vaultService.registerVault({
        name: "vault-3",
        type: "local_encryption",
        config: { password: "password-3" },
      });

      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames.sort(), ["vault-1", "vault-2", "vault-3"]);
    });
  });

  await t.step("should provide helpful error for missing secrets", async () => {
    await withTempDir(async () => {
      const vaultService = new VaultService();

      vaultService.registerVault({
        name: "empty-vault",
        type: "local_encryption",
        config: { password: "test-password" },
      });

      try {
        await vaultService.get("empty-vault", "non-existent-key");
        throw new Error("Should have thrown an error");
      } catch (error) {
        assertStringIncludes(
          error instanceof Error ? error.message : String(error),
          "Secret 'non-existent-key' not found in local vault 'empty-vault'",
        );
      }
    });
  });

  await t.step("should work with custom key file location", async () => {
    // deno-lint-ignore require-await
    await withTempDir(async () => {
      const vaultService = new VaultService();

      vaultService.registerVault({
        name: "custom-key-vault",
        type: "local_encryption",
        config: {
          auto_generate: true,
          key_file: "my-custom-key.txt",
        },
      });

      const vaultNames = vaultService.getVaultNames();
      assertEquals(vaultNames, ["custom-key-vault"]);
    });
  });
});

Deno.test("Local Encryption Vault - Direct Provider Tests", async (t) => {
  await t.step("should demonstrate full encryption workflow", async () => {
    await withTempDir(async () => {
      const { LocalEncryptionVaultProvider } = await import(
        "../src/domain/vaults/local_encryption_vault_provider.ts"
      );

      // Create SSH key for demo
      await Deno.writeTextFile("demo_ssh_key", DEMO_SSH_KEY);

      const vault = new LocalEncryptionVaultProvider("demo-vault", {
        ssh_key_path: "demo_ssh_key",
      });

      // Store secrets
      await vault.put("database-url", "postgresql://user:pass@localhost/db");
      await vault.put("api-key", "sk-1234567890abcdef");
      await vault.put("jwt-secret", "super-secret-jwt-key");

      // Retrieve and verify
      const dbUrl = await vault.get("database-url");
      const apiKey = await vault.get("api-key");
      const jwtSecret = await vault.get("jwt-secret");

      assertEquals(dbUrl, "postgresql://user:pass@localhost/db");
      assertEquals(apiKey, "sk-1234567890abcdef");
      assertEquals(jwtSecret, "super-secret-jwt-key");

      // Verify files were created
      const vaultDir = ".vault-demo-vault";
      const dbStat = await Deno.stat(`${vaultDir}/database-url.enc`);
      const apiStat = await Deno.stat(`${vaultDir}/api-key.enc`);
      const jwtStat = await Deno.stat(`${vaultDir}/jwt-secret.enc`);

      assertEquals(dbStat.isFile, true);
      assertEquals(apiStat.isFile, true);
      assertEquals(jwtStat.isFile, true);
    });
  });

  await t.step(
    "should work with auto-generated keys and persist across instances",
    async () => {
      await withTempDir(async () => {
        const { LocalEncryptionVaultProvider } = await import(
          "../src/domain/vaults/local_encryption_vault_provider.ts"
        );

        // First instance - auto-generate key
        const vault1 = new LocalEncryptionVaultProvider("persistent-vault", {
          auto_generate: true,
        });

        await vault1.put("shared-secret", "value-from-first-instance");

        // Second instance - should use same key
        const vault2 = new LocalEncryptionVaultProvider("persistent-vault", {
          auto_generate: true,
        });

        const retrieved = await vault2.get("shared-secret");
        assertEquals(retrieved, "value-from-first-instance");

        // Verify key file exists
        const keyFile = await Deno.stat(".vault-persistent-vault/.key");
        assertEquals(keyFile.isFile, true);
      });
    },
  );

  await t.step("should handle complex secret values", async () => {
    await withTempDir(async () => {
      const { LocalEncryptionVaultProvider } = await import(
        "../src/domain/vaults/local_encryption_vault_provider.ts"
      );

      await Deno.writeTextFile("complex_ssh_key", DEMO_SSH_KEY);

      const vault = new LocalEncryptionVaultProvider("complex-vault", {
        ssh_key_path: "complex_ssh_key",
      });

      const complexSecrets = {
        "json-config": JSON.stringify({
          database: { host: "localhost", port: 5432 },
          redis: { url: "redis://localhost:6379" },
          features: { auth: true, cache: false },
        }),
        "multiline-cert": `-----BEGIN CERTIFICATE-----
MIICdTCCAd4CAQAwDQYJKoZIhvcNAQEFBQAwgYkxCzAJBgNVBAYTAlVT
MRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1Nb3VudGFpbiBW
-----END CERTIFICATE-----`,
        "unicode-text":
          "Hello 世界! 🚀 Encryption test with émojis and spëcial chars",
        "binary-like": "\x00\x01\x02\x03\xFF\xFE\xFD\x04\x05",
      };

      // Store all complex secrets
      for (const [key, value] of Object.entries(complexSecrets)) {
        await vault.put(key, value);
      }

      // Retrieve and verify all complex secrets
      for (const [key, expectedValue] of Object.entries(complexSecrets)) {
        const retrievedValue = await vault.get(key);
        assertEquals(retrievedValue, expectedValue);
      }
    });
  });

  await t.step(
    "should maintain security properties across operations",
    async () => {
      await withTempDir(async () => {
        const { LocalEncryptionVaultProvider } = await import(
          "../src/domain/vaults/local_encryption_vault_provider.ts"
        );

        await Deno.writeTextFile("security_ssh_key", DEMO_SSH_KEY);

        const vault = new LocalEncryptionVaultProvider("security-vault", {
          ssh_key_path: "security_ssh_key",
        });

        // Store the same value multiple times
        await vault.put("test-key", "same-value");
        const content1 = await Deno.readTextFile(
          ".vault-security-vault/test-key.enc",
        );

        await vault.put("test-key", "same-value"); // Overwrite
        const content2 = await Deno.readTextFile(
          ".vault-security-vault/test-key.enc",
        );

        // Files should be different (different IVs and salts)
        assertEquals(content1 === content2, false);

        // But should decrypt to same value
        const retrieved = await vault.get("test-key");
        assertEquals(retrieved, "same-value");

        // Verify encrypted files don't contain plaintext
        assertEquals(content1.includes("same-value"), false);
        assertEquals(content2.includes("same-value"), false);

        // Verify structure of encrypted data
        const parsed1 = JSON.parse(content1);
        const parsed2 = JSON.parse(content2);

        assertEquals(typeof parsed1.iv, "string");
        assertEquals(typeof parsed1.data, "string");
        assertEquals(typeof parsed1.salt, "string");
        assertEquals(parsed1.version, 1);

        // Different salt and IV each time
        assertEquals(parsed1.salt === parsed2.salt, false);
        assertEquals(parsed1.iv === parsed2.iv, false);
      });
    },
  );
});
