import { assertEquals, assertStringIncludes } from "@std/assert";
import { vaultModel } from "../src/domain/models/lets-get-sensitive/vault_model.ts";
import { ModelInput } from "../src/domain/models/model_input.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vault-model-integration-" });
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

Deno.test("Vault Model with Local Encryption - Integration Tests", async (t) => {
  await t.step("should work with vault model get operation", async () => {
    await withTempDir(async () => {
      // First, manually set up a local encryption vault with a secret
      const { LocalEncryptionVaultProvider } = await import(
        "../src/domain/vaults/local_encryption_vault_provider.ts"
      );

      // Create SSH key for testing
      const sshKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEA7V3jKJJHtN4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N
-----END OPENSSH PRIVATE KEY-----`;
      await Deno.writeTextFile("test_ssh_key", sshKey);

      const vault = new LocalEncryptionVaultProvider("test-vault", {
        ssh_key_path: "test_ssh_key",
      });

      // Store a secret directly
      await vault.put("api-key", "secret-api-key-value");

      // Create .swamp.yaml configuration for the vault
      const swampConfig = {
        vaults: {
          "test-vault": {
            type: "local_encryption",
            config: {
              ssh_key_path: "test_ssh_key",
            },
          },
        },
      };

      await Deno.writeTextFile(
        ".swamp.yaml",
        JSON.stringify(swampConfig, null, 2),
      );

      // Now test the vault model
      const input = ModelInput.create({
        name: "test-vault-get",
        version: 1,
        attributes: {
          vaultName: "test-vault",
          secretKey: "api-key",
          operation: "get",
        },
      });

      const context = { repoDir: Deno.cwd() };
      const result = await vaultModel.methods.get.execute(input, context);

      assertEquals(result.data !== undefined, true);
      if (result.data) {
        assertEquals(result.data.attributes.vaultName, "test-vault");
        assertEquals(result.data.attributes.secretKey, "api-key");
        assertEquals(result.data.attributes.success, true);
        assertEquals(
          result.data.attributes.retrievedValue,
          "secret-api-key-value",
        );
      }
    });
  });

  await t.step("should work with vault model put operation", async () => {
    await withTempDir(async () => {
      // Create .swamp.yaml configuration for the vault
      const swampConfig = {
        vaults: {
          "storage-vault": {
            type: "local_encryption",
            config: {
              auto_generate: true,
            },
          },
        },
      };

      await Deno.writeTextFile(
        ".swamp.yaml",
        JSON.stringify(swampConfig, null, 2),
      );

      // Test the vault model put operation
      const putInput = ModelInput.create({
        name: "test-vault-put",
        version: 1,
        attributes: {
          vaultName: "storage-vault",
          secretKey: "database-password",
          secretValue: "super-secret-db-password",
          operation: "put",
        },
      });

      const context = { repoDir: Deno.cwd() };
      const putResult = await vaultModel.methods.put.execute(putInput, context);

      assertEquals(putResult.data !== undefined, true);
      if (putResult.data) {
        assertEquals(putResult.data.attributes.vaultName, "storage-vault");
        assertEquals(putResult.data.attributes.storedKey, "database-password");
        assertEquals(putResult.data.attributes.success, true);
      }

      // Verify we can retrieve it
      const getInput = ModelInput.create({
        name: "test-vault-get",
        version: 1,
        attributes: {
          vaultName: "storage-vault",
          secretKey: "database-password",
          operation: "get",
        },
      });

      const getResult = await vaultModel.methods.get.execute(getInput, context);

      assertEquals(getResult.data !== undefined, true);
      if (getResult.data) {
        assertEquals(
          getResult.data.attributes.retrievedValue,
          "super-secret-db-password",
        );
        assertEquals(getResult.data.attributes.vaultName, "storage-vault");
        assertEquals(getResult.data.attributes.secretKey, "database-password");
      }

      // Verify files were created
      const vaultDir = ".vault-storage-vault";
      const secretFile = await Deno.stat(`${vaultDir}/database-password.enc`);
      const keyFile = await Deno.stat(`${vaultDir}/.key`);

      assertEquals(secretFile.isFile, true);
      assertEquals(keyFile.isFile, true);
    });
  });

  await t.step("should handle multiple vaults in swamp config", async () => {
    await withTempDir(async () => {
      // Create comprehensive .swamp.yaml with multiple vault types
      const swampConfig = {
        vaults: {
          "local-dev": {
            type: "local_encryption",
            config: {
              auto_generate: true,
            },
          },
          "local-prod": {
            type: "local_encryption",
            config: {
              auto_generate: true,
            },
          },
          "mock-test": {
            type: "mock",
            config: {
              "test-key": "test-value",
            },
          },
        },
      };

      await Deno.writeTextFile(
        ".swamp.yaml",
        JSON.stringify(swampConfig, null, 2),
      );

      const context = { repoDir: Deno.cwd() };

      // Test local-dev vault
      const devPutInput = ModelInput.create({
        name: "dev-put",
        version: 1,
        attributes: {
          vaultName: "local-dev",
          secretKey: "dev-secret",
          secretValue: "development-secret-value",
          operation: "put",
        },
      });

      await vaultModel.methods.put.execute(devPutInput, context);

      const devGetInput = ModelInput.create({
        name: "dev-get",
        version: 1,
        attributes: {
          vaultName: "local-dev",
          secretKey: "dev-secret",
          operation: "get",
        },
      });

      const devResult = await vaultModel.methods.get.execute(
        devGetInput,
        context,
      );
      assertEquals(
        devResult.data?.attributes.retrievedValue,
        "development-secret-value",
      );

      // Test local-prod vault
      const prodPutInput = ModelInput.create({
        name: "prod-put",
        version: 1,
        attributes: {
          vaultName: "local-prod",
          secretKey: "prod-secret",
          secretValue: "production-secret-value",
          operation: "put",
        },
      });

      await vaultModel.methods.put.execute(prodPutInput, context);

      const prodGetInput = ModelInput.create({
        name: "prod-get",
        version: 1,
        attributes: {
          vaultName: "local-prod",
          secretKey: "prod-secret",
          operation: "get",
        },
      });

      const prodResult = await vaultModel.methods.get.execute(
        prodGetInput,
        context,
      );
      assertEquals(
        prodResult.data?.attributes.retrievedValue,
        "production-secret-value",
      );

      // Test mock vault (should work as before)
      const mockGetInput = ModelInput.create({
        name: "mock-get",
        version: 1,
        attributes: {
          vaultName: "mock-test",
          secretKey: "test-key",
          operation: "get",
        },
      });

      const mockResult = await vaultModel.methods.get.execute(
        mockGetInput,
        context,
      );
      assertEquals(mockResult.data?.attributes.retrievedValue, "test-value");

      // Verify separate vault directories were created
      const devVaultStat = await Deno.stat(".vault-local-dev");
      const prodVaultStat = await Deno.stat(".vault-local-prod");

      assertEquals(devVaultStat.isDirectory, true);
      assertEquals(prodVaultStat.isDirectory, true);
    });
  });

  await t.step("should provide helpful errors for missing vaults", async () => {
    await withTempDir(async () => {
      // Create minimal .swamp.yaml
      const swampConfig = {
        vaults: {
          "existing-vault": {
            type: "local_encryption",
            config: {
              auto_generate: true,
            },
          },
        },
      };

      await Deno.writeTextFile(
        ".swamp.yaml",
        JSON.stringify(swampConfig, null, 2),
      );

      try {
        const errorInput = ModelInput.create({
          name: "error-test",
          version: 1,
          attributes: {
            vaultName: "non-existent-vault",
            secretKey: "some-key",
            operation: "get",
          },
        });

        const context = { repoDir: Deno.cwd() };
        await vaultModel.methods.get.execute(errorInput, context);
        throw new Error("Should have thrown an error");
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        assertStringIncludes(
          errorMessage,
          "Vault 'non-existent-vault' not found",
        );
        assertStringIncludes(errorMessage, "Available vaults: existing-vault");
      }
    });
  });

  await t.step("should work with YAML configuration format", async () => {
    await withTempDir(async () => {
      // Create .swamp.yaml in YAML format
      const yamlConfig = `
vaults:
  yaml-vault:
    type: local_encryption
    config:
      auto_generate: true
  auto-vault:
    type: local_encryption
    config:
      auto_generate: true
      key_file: "custom-key.key"
`;

      await Deno.writeTextFile(".swamp.yaml", yamlConfig);

      const context = { repoDir: Deno.cwd() };

      // Test auto-generate vault
      const yamlPutInput = ModelInput.create({
        name: "yaml-put",
        version: 1,
        attributes: {
          vaultName: "yaml-vault",
          secretKey: "yaml-secret",
          secretValue: "yaml-secret-value",
          operation: "put",
        },
      });

      await vaultModel.methods.put.execute(yamlPutInput, context);

      const yamlGetInput = ModelInput.create({
        name: "yaml-get",
        version: 1,
        attributes: {
          vaultName: "yaml-vault",
          secretKey: "yaml-secret",
          operation: "get",
        },
      });

      const yamlResult = await vaultModel.methods.get.execute(
        yamlGetInput,
        context,
      );
      assertEquals(
        yamlResult.data?.attributes.retrievedValue,
        "yaml-secret-value",
      );

      // Test auto-generate vault with custom key file
      const autoPutInput = ModelInput.create({
        name: "auto-put",
        version: 1,
        attributes: {
          vaultName: "auto-vault",
          secretKey: "auto-secret",
          secretValue: "auto-secret-value",
          operation: "put",
        },
      });

      await vaultModel.methods.put.execute(autoPutInput, context);

      const autoGetInput = ModelInput.create({
        name: "auto-get",
        version: 1,
        attributes: {
          vaultName: "auto-vault",
          secretKey: "auto-secret",
          operation: "get",
        },
      });

      const autoResult = await vaultModel.methods.get.execute(
        autoGetInput,
        context,
      );
      assertEquals(
        autoResult.data?.attributes.retrievedValue,
        "auto-secret-value",
      );

      // Verify custom key file was created
      const customKeyStat = await Deno.stat("custom-key.key");
      assertEquals(customKeyStat.isFile, true);
    });
  });

  await t.step("should handle secrets with special characters", async () => {
    await withTempDir(async () => {
      const swampConfig = {
        vaults: {
          "special-vault": {
            type: "local_encryption",
            config: {
              auto_generate: true,
            },
          },
        },
      };

      await Deno.writeTextFile(
        ".swamp.yaml",
        JSON.stringify(swampConfig, null, 2),
      );

      const specialSecrets = [
        {
          key: "json-secret",
          value: '{"user": "admin", "password": "p@ssw0rd!", "port": 5432}',
        },
        { key: "multiline-secret", value: "line1\nline2\nline3\twith\ttabs" },
        {
          key: "unicode-secret",
          value: "Hello 世界! 🚀 Test émojis and spëcial chars",
        },
        {
          key: "url-secret",
          value: "postgresql://user:p@ss@localhost:5432/db?ssl=true&timeout=30",
        },
      ];

      const context = { repoDir: Deno.cwd() };

      // Store all special secrets
      for (const secret of specialSecrets) {
        const putInput = ModelInput.create({
          name: `special-put-${secret.key}`,
          version: 1,
          attributes: {
            vaultName: "special-vault",
            secretKey: secret.key,
            secretValue: secret.value,
            operation: "put",
          },
        });

        await vaultModel.methods.put.execute(putInput, context);
      }

      // Retrieve and verify all special secrets
      for (const secret of specialSecrets) {
        const getInput = ModelInput.create({
          name: `special-get-${secret.key}`,
          version: 1,
          attributes: {
            vaultName: "special-vault",
            secretKey: secret.key,
            operation: "get",
          },
        });

        const result = await vaultModel.methods.get.execute(getInput, context);

        assertEquals(result.data?.attributes.retrievedValue, secret.value);
        assertEquals(result.data?.attributes.vaultName, "special-vault");
        assertEquals(result.data?.attributes.secretKey, secret.key);
      }
    });
  });
});
