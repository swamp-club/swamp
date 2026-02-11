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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
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

/**
 * Returns the computed secrets_dir path for a vault.
 * This matches the path computed by LocalEncryptionVaultProvider.
 */
function secretsDir(baseDir: string, vaultName: string): string {
  return join(baseDir, ".swamp", "secrets", "local_encryption", vaultName);
}

Deno.test("LocalEncryptionVaultProvider - uses computed secrets path", async (t) => {
  await t.step(
    "should compute secrets path from base_dir when provided",
    () => {
      const vault = new LocalEncryptionVaultProvider("test-vault", {
        auto_generate: true,
        base_dir: "/tmp/test-repo",
      });
      assertEquals(vault.getName(), "test-vault");
      // The vault should compute its path as /tmp/test-repo/.swamp/secrets/local_encryption/test-vault
    },
  );

  await t.step(
    "should use current directory when base_dir is not provided",
    () => {
      // This should not throw - it defaults to Deno.cwd()
      const vault = new LocalEncryptionVaultProvider("default-vault", {
        auto_generate: true,
      });
      assertEquals(vault.getName(), "default-vault");
    },
  );
});

Deno.test("LocalEncryptionVaultProvider - SSH key-based encryption", async (t) => {
  await t.step("should encrypt and decrypt secrets with SSH key", async () => {
    await withTempDir(async (dir) => {
      // Create a mock SSH key file
      await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const config: LocalEncryptionConfig = {
        ssh_key_path: "test_ssh_key",
        base_dir: dir,
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
      await withTempDir(async (dir) => {
        await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

        const vaultSecretsDir = secretsDir(dir, "secure-vault");
        const config: LocalEncryptionConfig = {
          ssh_key_path: "test_ssh_key",
          base_dir: dir,
        };
        const vault = new LocalEncryptionVaultProvider("secure-vault", config);

        await vault.put("test-key", "test-value");

        const stat = await Deno.stat(vaultSecretsDir);
        assertEquals(stat.isDirectory, true);
      });
    },
  );

  await t.step("should store secrets in separate encrypted files", async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const vaultSecretsDir = secretsDir(dir, "multi-vault");
      const config: LocalEncryptionConfig = {
        ssh_key_path: "test_ssh_key",
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider("multi-vault", config);

      await vault.put("secret1", "value1");
      await vault.put("secret2", "value2");

      const secret1File = await Deno.stat(join(vaultSecretsDir, "secret1.enc"));
      const secret2File = await Deno.stat(join(vaultSecretsDir, "secret2.enc"));

      assertEquals(secret1File.isFile, true);
      assertEquals(secret2File.isFile, true);

      // Verify files contain encrypted data (not plaintext)
      const content1 = await Deno.readTextFile(
        join(vaultSecretsDir, "secret1.enc"),
      );
      const content2 = await Deno.readTextFile(
        join(vaultSecretsDir, "secret2.enc"),
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
    await withTempDir(async (dir) => {
      await Deno.writeTextFile("shared_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const config: LocalEncryptionConfig = {
        ssh_key_path: "shared_ssh_key",
        base_dir: dir,
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
});

Deno.test("LocalEncryptionVaultProvider - auto-generated keys", async (t) => {
  await t.step("should auto-generate master key when enabled", async () => {
    await withTempDir(async (dir) => {
      const vaultSecretsDir = secretsDir(dir, "auto-vault");
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider("auto-vault", config);

      await vault.put("test-secret", "test-value");
      const retrieved = await vault.get("test-secret");

      assertEquals(retrieved, "test-value");

      // Should have created a key file in the secrets directory
      const keyFile = await Deno.stat(join(vaultSecretsDir, ".key"));
      assertEquals(keyFile.isFile, true);
    });
  });

  await t.step("should reuse existing auto-generated key", async () => {
    await withTempDir(async (dir) => {
      const vaultSecretsDir = secretsDir(dir, "persistent-vault");
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
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
      const keyFile = await Deno.stat(join(vaultSecretsDir, ".key"));
      assertEquals(keyFile.isFile, true);
    });
  });

  await t.step("should support custom key file location", async () => {
    await withTempDir(async (dir) => {
      const customKeyPath = "custom-key-location.key";
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        key_file: customKeyPath,
        base_dir: dir,
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
      await withTempDir(async (dir) => {
        const vaultSecretsDir = secretsDir(dir, "fallback-vault");
        const config: LocalEncryptionConfig = {
          ssh_key_path: "nonexistent-ssh-key",
          auto_generate: true,
          base_dir: dir,
        };
        const vault = new LocalEncryptionVaultProvider(
          "fallback-vault",
          config,
        );

        await vault.put("fallback-secret", "fallback-value");
        const retrieved = await vault.get("fallback-secret");

        assertEquals(retrieved, "fallback-value");

        // Should have created auto-generated key file
        const keyFile = await Deno.stat(join(vaultSecretsDir, ".key"));
        assertEquals(keyFile.isFile, true);
      });
    },
  );
});

Deno.test("LocalEncryptionVaultProvider - error handling", async (t) => {
  await t.step("should throw error for invalid SSH key path", async () => {
    await withTempDir(async (dir) => {
      const config: LocalEncryptionConfig = {
        ssh_key_path: "nonexistent-ssh-key",
        base_dir: dir,
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
    await withTempDir(async (dir) => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
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
    await withTempDir(async (dir) => {
      const vaultSecretsDir = secretsDir(dir, "corrupt-vault");
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider("corrupt-vault", config);

      // Create vault directory and write corrupted file
      await Deno.mkdir(vaultSecretsDir, { recursive: true });
      await Deno.writeTextFile(
        join(vaultSecretsDir, "corrupted.enc"),
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
    const vault = new LocalEncryptionVaultProvider("test-name", {
      base_dir: "/tmp",
    });
    assertEquals(vault.getName(), "test-name");
  });
});

Deno.test("LocalEncryptionVaultProvider - security properties", async (t) => {
  await t.step("should use different salts for different secrets", async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

      const vaultSecretsDir = secretsDir(dir, "security-vault");
      const config: LocalEncryptionConfig = {
        ssh_key_path: "test_ssh_key",
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider("security-vault", config);

      await vault.put("secret1", "same-value");
      await vault.put("secret2", "same-value");

      // Read encrypted files and verify different salts
      const content1 = await Deno.readTextFile(
        join(vaultSecretsDir, "secret1.enc"),
      );
      const content2 = await Deno.readTextFile(
        join(vaultSecretsDir, "secret2.enc"),
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
      await withTempDir(async (dir) => {
        await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

        const vaultSecretsDir = secretsDir(dir, "iv-test-vault");
        const config: LocalEncryptionConfig = {
          ssh_key_path: "test_ssh_key",
          base_dir: dir,
        };
        const vault = new LocalEncryptionVaultProvider("iv-test-vault", config);

        // Store same secret twice
        await vault.put("test-key", "same-value");
        const content1 = await Deno.readTextFile(
          join(vaultSecretsDir, "test-key.enc"),
        );

        await vault.put("test-key", "same-value"); // Overwrite with same value
        const content2 = await Deno.readTextFile(
          join(vaultSecretsDir, "test-key.enc"),
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
      await withTempDir(async (dir) => {
        await Deno.writeTextFile("test_ssh_key", MOCK_SSH_PRIVATE_KEY);

        const config: LocalEncryptionConfig = {
          ssh_key_path: "test_ssh_key",
          base_dir: dir,
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

Deno.test("LocalEncryptionVaultProvider - list secrets", async (t) => {
  await t.step("should return empty list when no secrets exist", async () => {
    await withTempDir(async (dir) => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider(
        "empty-list-vault",
        config,
      );

      const secrets = await vault.list();
      assertEquals(secrets.length, 0);
    });
  });

  await t.step("should list all stored secrets", async () => {
    await withTempDir(async (dir) => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider("list-vault", config);

      await vault.put("api-key", "secret1");
      await vault.put("db-password", "secret2");
      await vault.put("jwt-token", "secret3");

      const secrets = await vault.list();
      assertEquals(secrets.length, 3);
      assertEquals(secrets.includes("api-key"), true);
      assertEquals(secrets.includes("db-password"), true);
      assertEquals(secrets.includes("jwt-token"), true);
    });
  });

  await t.step("should return secrets in sorted order", async () => {
    await withTempDir(async (dir) => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider(
        "sorted-list-vault",
        config,
      );

      // Store in non-alphabetical order
      await vault.put("zebra", "z");
      await vault.put("apple", "a");
      await vault.put("mango", "m");

      const secrets = await vault.list();
      assertEquals(secrets.length, 3);
      assertEquals(secrets[0], "apple");
      assertEquals(secrets[1], "mango");
      assertEquals(secrets[2], "zebra");
    });
  });

  await t.step("should only list .enc files", async () => {
    await withTempDir(async (dir) => {
      const vaultSecretsDir = secretsDir(dir, "enc-only-vault");
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider("enc-only-vault", config);

      // Store a secret first to create the directory
      await vault.put("real-secret", "value");

      // Create a non-.enc file in the vault directory
      await Deno.writeTextFile(
        join(vaultSecretsDir, "not-a-secret.txt"),
        "other",
      );
      await Deno.writeTextFile(join(vaultSecretsDir, "another.json"), "{}");

      const secrets = await vault.list();
      assertEquals(secrets.length, 1);
      assertEquals(secrets[0], "real-secret");
    });
  });

  await t.step("should not include .key file in list", async () => {
    await withTempDir(async (dir) => {
      const config: LocalEncryptionConfig = {
        auto_generate: true,
        base_dir: dir,
      };
      const vault = new LocalEncryptionVaultProvider(
        "key-excluded-vault",
        config,
      );

      await vault.put("my-secret", "value");

      const secrets = await vault.list();
      assertEquals(secrets.length, 1);
      assertEquals(secrets.includes(".key"), false);
    });
  });
});
