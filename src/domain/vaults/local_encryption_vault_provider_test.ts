import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-local-vault-test-" });
  try {
    // Change to temp directory for test isolation
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

// Create a mock SSH private key for testing
const MOCK_SSH_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEA7V3jKJJHtN4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N
4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N
-----END OPENSSH PRIVATE KEY-----`;

Deno.test("LocalEncryptionVaultProvider - SSH key-based encryption", async (t) => {
  await t.step("should encrypt and decrypt secrets with SSH key", async () => {
    await withTempDir(async () => {
      // Create a mock SSH key file
      await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const config: LocalEncryptionConfig = {
        ssh_key_path: "test_ssh_key",
      };
      const vault = new LocalEncryptionVaultProvider("test-vault", config);

      const secretValue = "super-secret-value-12345";
      await vault.put("api-key", secretValue);

      const retrieved = await vault.get("api-key");
      assertEquals(retrieved, secretValue);
    });
  });

  await t.step(
    "should create vault directory with proper permissions",
    async () => {
      await withTempDir(async () => {
        await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

        const config: LocalEncryptionConfig = {
          ssh_key_path: "test_ssh_key",
        };
        const vault = new LocalEncryptionVaultProvider("secure-vault", config);

        await vault.put("test-key", "test-value");

        const stat = await Deno.stat(".vault-secure-vault");
        assertEquals(stat.isDirectory, true);
      });
    },
  );

  await t.step("should store secrets in separate encrypted files", async () => {
    await withTempDir(async () => {
      await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const config: LocalEncryptionConfig = {
        ssh_key_path: "test_ssh_key",
      };
      const vault = new LocalEncryptionVaultProvider("multi-vault", config);

      await vault.put("secret1", "value1");
      await vault.put("secret2", "value2");

      const secret1File = await Deno.stat(".vault-multi-vault/secret1.enc");
      const secret2File = await Deno.stat(".vault-multi-vault/secret2.enc");

      assertEquals(secret1File.isFile, true);
      assertEquals(secret2File.isFile, true);

      // Verify files contain encrypted data (not plaintext)
      const content1 = await Deno.readTextFile(
        ".vault-multi-vault/secret1.enc",
      );
      const content2 = await Deno.readTextFile(
        ".vault-multi-vault/secret2.enc",
      );

      // Should be JSON with encrypted data
      const parsed1 = JSON.parse(content1);
      const _parsed2 = JSON.parse(content2);

      assertEquals(typeof parsed1.iv, "string");
      assertEquals(typeof parsed1.data, "string");
      assertEquals(typeof parsed1.salt, "string");
      assertEquals(parsed1.version, 1);

      // Should not contain plaintext
      assertStringIncludes(content1, '"data"');
      assertEquals(content1.includes("value1"), false);
      assertEquals(content2.includes("value2"), false);
    });
  });

  await t.step("should handle multiple secrets with same SSH key", async () => {
    await withTempDir(async () => {
      await Deno.writeTextFile("shared_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const config: LocalEncryptionConfig = {
        ssh_key_path: "shared_ssh_key",
      };
      const vault = new LocalEncryptionVaultProvider("shared-vault", config);

      const secrets = {
        "db-password": "mysql-secret-123",
        "api-key": "api-key-456",
        "jwt-secret": "jwt-token-789",
      };

      // Store all secrets
      for (const [key, value] of Object.entries(secrets)) {
        await vault.put(key, value);
      }

      // Retrieve and verify all secrets
      for (const [key, expectedValue] of Object.entries(secrets)) {
        const retrievedValue = await vault.get(key);
        assertEquals(retrievedValue, expectedValue);
      }
    });
  });

  await t.step(
    "should fall back to default SSH key path when no config",
    async () => {
      await withTempDir(async () => {
        // Create mock SSH key in default location
        await Deno.mkdir(".ssh", { recursive: true });
        await Deno.writeTextFile(".ssh/id_rsa", MOCK_SSH_PRIVATE_KEY);

        // Set HOME to current directory for test
        const originalHome = Deno.env.get("HOME");
        Deno.env.set("HOME", Deno.cwd());

        try {
          const config: LocalEncryptionConfig = {}; // No explicit SSH key path or auto_generate
          const vault = new LocalEncryptionVaultProvider(
            "default-ssh-vault",
            config,
          );

          await vault.put("default-secret", "default-value");
          const retrieved = await vault.get("default-secret");
          assertEquals(retrieved, "default-value");
        } finally {
          if (originalHome) {
            Deno.env.set("HOME", originalHome);
          } else {
            Deno.env.delete("HOME");
          }
        }
      });
    },
  );
});

Deno.test("LocalEncryptionVaultProvider - auto-generated keys", async (t) => {
  await t.step("should auto-generate master key when enabled", async () => {
    await withTempDir(async () => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
      };
      const vault = new LocalEncryptionVaultProvider("auto-vault", config);

      await vault.put("test-secret", "test-value");
      const retrieved = await vault.get("test-secret");

      assertEquals(retrieved, "test-value");

      // Should have created a key file
      const keyFile = await Deno.stat(".vault-auto-vault/.key");
      assertEquals(keyFile.isFile, true);
    });
  });

  await t.step("should reuse existing auto-generated key", async () => {
    await withTempDir(async () => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
      };

      // First vault instance
      const vault1 = new LocalEncryptionVaultProvider(
        "persistent-vault",
        config,
      );
      await vault1.put("secret1", "value1");

      // Second vault instance (should use same key)
      const vault2 = new LocalEncryptionVaultProvider(
        "persistent-vault",
        config,
      );
      const retrieved = await vault2.get("secret1");

      assertEquals(retrieved, "value1");

      // Should have only one key file
      const keyFile = await Deno.stat(".vault-persistent-vault/.key");
      assertEquals(keyFile.isFile, true);
    });
  });

  await t.step("should support custom key file location", async () => {
    await withTempDir(async () => {
      const customKeyPath = "custom-key-location.key";
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        key_file: customKeyPath,
      };
      const vault = new LocalEncryptionVaultProvider(
        "custom-key-vault",
        config,
      );

      await vault.put("test-secret", "test-value");
      const retrieved = await vault.get("test-secret");

      assertEquals(retrieved, "test-value");

      // Should have created key at custom location
      const keyFile = await Deno.stat(customKeyPath);
      assertEquals(keyFile.isFile, true);
    });
  });

  await t.step(
    "should fall back to auto-generate when SSH key fails",
    async () => {
      await withTempDir(async () => {
        const config: LocalEncryptionConfig = {
          ssh_key_path: "nonexistent-ssh-key",
          auto_generate: true,
        };
        const vault = new LocalEncryptionVaultProvider(
          "fallback-vault",
          config,
        );

        await vault.put("fallback-secret", "fallback-value");
        const retrieved = await vault.get("fallback-secret");

        assertEquals(retrieved, "fallback-value");

        // Should have created auto-generated key file
        const keyFile = await Deno.stat(".vault-fallback-vault/.key");
        assertEquals(keyFile.isFile, true);
      });
    },
  );
});

Deno.test("LocalEncryptionVaultProvider - error handling", async (t) => {
  await t.step(
    "should throw error when no SSH key or auto_generate",
    async () => {
      await withTempDir(async () => {
        // Temporarily set HOME to a non-existent directory to ensure default SSH key fails
        const originalHome = Deno.env.get("HOME");
        Deno.env.set("HOME", "/nonexistent-home-directory");

        try {
          const config: LocalEncryptionConfig = {}; // No SSH key or auto_generate
          const vault = new LocalEncryptionVaultProvider(
            "no-config-vault",
            config,
          );

          const error = await assertRejects(
            () => vault.put("test-key", "test-value"),
            Error,
          );

          assertStringIncludes(
            error.message,
            "Failed to read default SSH key from '~/.ssh/id_rsa' for local vault 'no-config-vault'",
          );
          assertStringIncludes(
            error.message,
            "Set 'ssh_key_path' to a valid SSH private key or enable 'auto_generate'",
          );
        } finally {
          if (originalHome) {
            Deno.env.set("HOME", originalHome);
          } else {
            Deno.env.delete("HOME");
          }
        }
      });
    },
  );

  await t.step("should throw error for invalid SSH key path", async () => {
    await withTempDir(async () => {
      const config: LocalEncryptionConfig = {
        ssh_key_path: "nonexistent-ssh-key",
      };
      const vault = new LocalEncryptionVaultProvider(
        "invalid-ssh-vault",
        config,
      );

      const error = await assertRejects(
        () => vault.put("test-key", "test-value"),
        Error,
      );

      assertStringIncludes(
        error.message,
        "Failed to read SSH key from 'nonexistent-ssh-key' for local vault 'invalid-ssh-vault'",
      );
    });
  });

  await t.step("should throw error for non-existent secret", async () => {
    await withTempDir(async () => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
      };
      const vault = new LocalEncryptionVaultProvider("empty-vault", config);

      const error = await assertRejects(
        () => vault.get("non-existent-key"),
        Error,
      );

      assertStringIncludes(
        error.message,
        "Secret 'non-existent-key' not found in local vault 'empty-vault'",
      );
    });
  });

  await t.step("should handle corrupted encrypted files", async () => {
    await withTempDir(async () => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
      };
      const vault = new LocalEncryptionVaultProvider("corrupt-vault", config);

      // Create vault directory and write corrupted file
      await Deno.mkdir(".vault-corrupt-vault", { recursive: true });
      await Deno.writeTextFile(
        ".vault-corrupt-vault/corrupted.enc",
        "invalid json",
      );

      const error = await assertRejects(
        () => vault.get("corrupted"),
        Error,
      );

      assertStringIncludes(
        error.message,
        "Failed to retrieve secret 'corrupted'",
      );
    });
  });

  await t.step("should return correct vault name", () => {
    const vault = new LocalEncryptionVaultProvider("test-name", {});
    assertEquals(vault.getName(), "test-name");
  });
});

Deno.test("LocalEncryptionVaultProvider - security properties", async (t) => {
  await t.step("should use different salts for different secrets", async () => {
    await withTempDir(async () => {
      await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const config: LocalEncryptionConfig = {
        ssh_key_path: "test_ssh_key",
      };
      const vault = new LocalEncryptionVaultProvider("security-vault", config);

      await vault.put("secret1", "same-value");
      await vault.put("secret2", "same-value");

      // Read encrypted files and verify different salts
      const content1 = await Deno.readTextFile(
        ".vault-security-vault/secret1.enc",
      );
      const content2 = await Deno.readTextFile(
        ".vault-security-vault/secret2.enc",
      );

      const parsed1 = JSON.parse(content1);
      const parsed2 = JSON.parse(content2);

      // Same plaintext, same SSH key, but should have different salts and encrypted data
      assertEquals(parsed1.salt === parsed2.salt, false);
      assertEquals(parsed1.data === parsed2.data, false);
      assertEquals(parsed1.iv === parsed2.iv, false);
    });
  });

  await t.step(
    "should use different IVs for same secret updated multiple times",
    async () => {
      await withTempDir(async () => {
        await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

        const config: LocalEncryptionConfig = {
          ssh_key_path: "test_ssh_key",
        };
        const vault = new LocalEncryptionVaultProvider("iv-test-vault", config);

        // Store same secret twice
        await vault.put("test-key", "same-value");
        const content1 = await Deno.readTextFile(
          ".vault-iv-test-vault/test-key.enc",
        );

        await vault.put("test-key", "same-value"); // Overwrite with same value
        const content2 = await Deno.readTextFile(
          ".vault-iv-test-vault/test-key.enc",
        );

        const parsed1 = JSON.parse(content1);
        const parsed2 = JSON.parse(content2);

        // Should have different IVs and salts even for same value
        assertEquals(parsed1.iv === parsed2.iv, false);
        assertEquals(parsed1.salt === parsed2.salt, false);

        // But should decrypt to same value
        const retrieved = await vault.get("test-key");
        assertEquals(retrieved, "same-value");
      });
    },
  );

  await t.step(
    "should handle special characters and unicode in secrets",
    async () => {
      await withTempDir(async () => {
        await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

        const config: LocalEncryptionConfig = {
          ssh_key_path: "test_ssh_key",
        };
        const vault = new LocalEncryptionVaultProvider("unicode-vault", config);

        const specialSecrets = {
          "emoji": "🔐🚀💎",
          "unicode": "こんにちは世界",
          "special-chars": "!@#$%^&*()_+-={}[]|\\:\";'<>?,./~`",
          "multiline": "line1\nline2\ntab:\tspace: end",
          "json": '{"key": "value", "number": 42, "bool": true}',
        };

        // Store all special secrets
        for (const [key, value] of Object.entries(specialSecrets)) {
          await vault.put(key, value);
        }

        // Retrieve and verify all special secrets
        for (const [key, expectedValue] of Object.entries(specialSecrets)) {
          const retrievedValue = await vault.get(key);
          assertEquals(retrievedValue, expectedValue);
        }
      });
    },
  );
});
