import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";

import { resolve } from "@std/path";

const SWAMP_BINARY = resolve("./swamp");

interface CliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<CliResult> {
  const cmd = new Deno.Command(SWAMP_BINARY, {
    args,
    cwd: options.cwd || Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
    stdin: options.input ? "piped" : "null",
  });

  const process = cmd.spawn();

  if (options.input && process.stdin) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.input));
    await writer.close();
  }

  const { success, stdout, stderr, code } = await process.output();

  return {
    success,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function withTempDir<T>(fn: () => Promise<T>): Promise<T> {
  const tempDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  
  try {
    Deno.chdir(tempDir);
    
    // Initialize swamp repo in temp directory
    const initResult = await runCli(["repo", "init"]);
    if (!initResult.success) {
      throw new Error(`Failed to init repo: ${initResult.stderr}`);
    }
    
    return await fn();
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("Local Encryption Vault - CLI Integration", async (t) => {
  await t.step("should create and use auto-generated encryption vault via CLI", async () => {
    await withTempDir(async () => {
      // Create .swamp.yaml with local encryption vault
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  dev-secrets:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create a test model that uses the vault
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "test/vault-demo"
      ]);
      assertEquals(modelResult.success, true);

      // Store a secret using the vault
      const putResult = await runCli([
        "model", "method", "run", "test/vault-demo", "put",
        "--vault", "dev-secrets",
        "--key", "api-key",
        "--value", "sk-1234567890abcdef"
      ]);
      assertEquals(putResult.success, true);
      
      const putOutput = JSON.parse(putResult.stdout);
      assertStringIncludes(putOutput.data.result, "success");

      // Verify vault directory was created
      const vaultDirExists = existsSync(".vault-dev-secrets");
      assertEquals(vaultDirExists, true);

      // Verify encrypted file exists
      const encryptedFileExists = existsSync(".vault-dev-secrets/api-key.enc");
      assertEquals(encryptedFileExists, true);

      // Retrieve the secret
      const getResult = await runCli([
        "model", "method", "run", "test/vault-demo", "get",
        "--vault", "dev-secrets",
        "--key", "api-key"
      ]);
      assertEquals(getResult.success, true);
      
      const getOutput = JSON.parse(getResult.stdout);
      assertEquals(getOutput.data.result, "sk-1234567890abcdef");
    });
  });

  await t.step("should handle multiple secrets in the same vault", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  multi-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "secrets/manager"
      ]);
      assertEquals(modelResult.success, true);

      // Store multiple secrets
      const secrets = [
        { key: "db-password", value: "super-secure-db-pass-123" },
        { key: "jwt-secret", value: "jwt-signing-key-456" },
        { key: "api-token", value: "bearer-token-789" },
      ];

      for (const secret of secrets) {
        const putResult = await runCli([
          "model", "method", "run", "secrets/manager", "put",
          "--vault", "multi-vault",
          "--key", secret.key,
          "--value", secret.value
        ]);
        assertEquals(putResult.success, true);
      }

      // Verify all encrypted files exist
      for (const secret of secrets) {
        const encryptedFileExists = existsSync(`.vault-multi-vault/${secret.key}.enc`);
        assertEquals(encryptedFileExists, true);
      }

      // Retrieve and verify all secrets
      for (const secret of secrets) {
        const getResult = await runCli([
          "model", "method", "run", "secrets/manager", "get",
          "--vault", "multi-vault",
          "--key", secret.key
        ]);
        assertEquals(getResult.success, true);
        
        const getOutput = JSON.parse(getResult.stdout);
        assertEquals(getOutput.data.result, secret.value);
      }
    });
  });

  await t.step("should work with SSH key-based encryption", async () => {
    await withTempDir(async () => {
      // Create a mock SSH private key for testing
      await Deno.mkdir(".ssh", { recursive: true });
      await Deno.writeTextFile(".ssh/test_key", `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEA7V3jKJJHtN4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N
4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N4N
-----END OPENSSH PRIVATE KEY-----`);

      // Set proper permissions on SSH key
      await Deno.chmod(".ssh/test_key", 0o600);

      // Create vault configuration with SSH key
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  ssh-vault:
    type: local_encryption
    config:
      ssh_key_path: ".ssh/test_key"
`);

      // Create model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "ssh/secrets"
      ]);
      assertEquals(modelResult.success, true);

      // Store secret with SSH key encryption
      const putResult = await runCli([
        "model", "method", "run", "ssh/secrets", "put",
        "--vault", "ssh-vault", 
        "--key", "ssh-secret",
        "--value", "encrypted-with-ssh-key"
      ]);
      assertEquals(putResult.success, true);

      // Verify vault directory and encrypted file
      const vaultDirExists = existsSync(".vault-ssh-vault");
      assertEquals(vaultDirExists, true);

      const encryptedFileExists = existsSync(".vault-ssh-vault/ssh-secret.enc");
      assertEquals(encryptedFileExists, true);

      // Retrieve the secret
      const getResult = await runCli([
        "model", "method", "run", "ssh/secrets", "get",
        "--vault", "ssh-vault",
        "--key", "ssh-secret"
      ]);
      assertEquals(getResult.success, true);

      const getOutput = JSON.parse(getResult.stdout);
      assertEquals(getOutput.data.result, "encrypted-with-ssh-key");
    });
  });

  await t.step("should handle vault configuration errors gracefully", async () => {
    await withTempDir(async () => {
      // Create model without vault configuration
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "error/test"
      ]);
      assertEquals(modelResult.success, true);

      // Try to use non-existent vault
      const putResult = await runCli([
        "model", "method", "run", "error/test", "put",
        "--vault", "missing-vault",
        "--key", "test-key",
        "--value", "test-value"
      ]);
      assertEquals(putResult.success, false);
      assertStringIncludes(putResult.stdout, "No vault named 'missing-vault' found");
    });
  });

  await t.step("should provide helpful error for missing secrets", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  empty-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "empty/test"
      ]);
      assertEquals(modelResult.success, true);

      // Try to get non-existent secret
      const getResult = await runCli([
        "model", "method", "run", "empty/test", "get",
        "--vault", "empty-vault",
        "--key", "non-existent-key"
      ]);
      assertEquals(getResult.success, false);
      assertStringIncludes(getResult.stdout, "Secret 'non-existent-key' not found");
    });
  });

  await t.step("should handle secrets with special characters", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  special-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "special/test"
      ]);
      assertEquals(modelResult.success, true);

      // Test various special characters and unicode
      const specialSecrets = [
        { key: "json-secret", value: '{"api_key": "sk-123", "url": "https://api.example.com"}' },
        { key: "unicode-secret", value: "🔐 Secret with émojis and ñoñó characters! 中文" },
        { key: "multiline-secret", value: "Line 1\nLine 2\nLine 3 with 'quotes' and \"double quotes\"" },
        { key: "complex-password", value: "P@$$w0rd!@#$%^&*()_+-=[]{}|;':\",./<>?" },
      ];

      // Store all special secrets
      for (const secret of specialSecrets) {
        const putResult = await runCli([
          "model", "method", "run", "special/test", "put",
          "--vault", "special-vault",
          "--key", secret.key,
          "--value", secret.value
        ]);
        assertEquals(putResult.success, true);
      }

      // Retrieve and verify all special secrets
      for (const secret of specialSecrets) {
        const getResult = await runCli([
          "model", "method", "run", "special/test", "get",
          "--vault", "special-vault", 
          "--key", secret.key
        ]);
        assertEquals(getResult.success, true);

        const getOutput = JSON.parse(getResult.stdout);
        assertEquals(getOutput.data.result, secret.value);
      }
    });
  });

  await t.step("should demonstrate vault persistence across model instances", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  persistent-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create first model and store secret
      const model1Result = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "instance1/test"
      ]);
      assertEquals(model1Result.success, true);

      const putResult = await runCli([
        "model", "method", "run", "instance1/test", "put",
        "--vault", "persistent-vault",
        "--key", "shared-secret",
        "--value", "shared-across-instances"
      ]);
      assertEquals(putResult.success, true);

      // Create second model and retrieve the same secret
      const model2Result = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "instance2/test"
      ]);
      assertEquals(model2Result.success, true);

      const getResult = await runCli([
        "model", "method", "run", "instance2/test", "get",
        "--vault", "persistent-vault",
        "--key", "shared-secret"
      ]);
      assertEquals(getResult.success, true);

      const getOutput = JSON.parse(getResult.stdout);
      assertEquals(getOutput.data.result, "shared-across-instances");
    });
  });

  await t.step("should verify security properties through CLI", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  security-test:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "security/test"
      ]);
      assertEquals(modelResult.success, true);

      // Store a secret
      const secretValue = "sensitive-data-to-encrypt";
      const putResult = await runCli([
        "model", "method", "run", "security/test", "put",
        "--vault", "security-test",
        "--key", "security-secret",
        "--value", secretValue
      ]);
      assertEquals(putResult.success, true);

      // Verify encrypted file exists and doesn't contain plaintext
      const encryptedFile = ".vault-security-test/security-secret.enc";
      const encryptedFileExists = existsSync(encryptedFile);
      assertEquals(encryptedFileExists, true);

      // Read encrypted file and verify no plaintext
      const encryptedContent = await Deno.readTextFile(encryptedFile);
      const containsPlaintext = encryptedContent.includes(secretValue);
      assertEquals(containsPlaintext, false);

      // Verify it's valid JSON with required fields
      const encryptedData = JSON.parse(encryptedContent);
      assertEquals(typeof encryptedData.iv, "string");
      assertEquals(typeof encryptedData.data, "string");
      assertEquals(typeof encryptedData.salt, "string");
      assertEquals(typeof encryptedData.version, "number");

      // Store same secret again to verify different encryption
      const putResult2 = await runCli([
        "model", "method", "run", "security/test", "put",
        "--vault", "security-test",
        "--key", "security-secret",
        "--value", secretValue
      ]);
      assertEquals(putResult2.success, true);

      // Verify new encryption is different
      const newEncryptedContent = await Deno.readTextFile(encryptedFile);
      const newEncryptedData = JSON.parse(newEncryptedContent);
      
      // Salt and IV should be different
      assertEquals(encryptedData.salt !== newEncryptedData.salt, true);
      assertEquals(encryptedData.iv !== newEncryptedData.iv, true);

      // But decryption should still work
      const getResult = await runCli([
        "model", "method", "run", "security/test", "get",
        "--vault", "security-test",
        "--key", "security-secret"
      ]);
      assertEquals(getResult.success, true);

      const getOutput = JSON.parse(getResult.stdout);
      assertEquals(getOutput.data.result, secretValue);
    });
  });
});

Deno.test("Local Encryption Vault - Workflow Integration", async (t) => {
  await t.step("should work within swamp workflows", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  workflow-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create workflows directory
      await Deno.mkdir("workflows", { recursive: true });

      // Create a workflow that uses the vault
      const workflowId = "workflow-vault-test";
      const workflowContent = `
id: ${workflowId}
name: vault-workflow-test
description: Test local encryption vault in workflow
version: 1
jobs:
  - name: store-secret
    description: Store a secret in the vault
    steps:
      - name: put-secret
        description: Store API key
        task:
          type: model_method
          modelIdOrName: vault/test
          methodName: put
          input:
            vault: workflow-vault
            key: workflow-api-key
            value: workflow-secret-value-123
        dependsOn: []
        weight: 0
    dependsOn: []
    weight: 0

  - name: retrieve-secret
    description: Retrieve the secret from the vault
    steps:
      - name: get-secret
        description: Get API key
        task:
          type: model_method
          modelIdOrName: vault/test
          methodName: get
          input:
            vault: workflow-vault
            key: workflow-api-key
        dependsOn:
          - step: put-secret
            condition:
              type: succeeded
              ref: put-secret
        weight: 0
    dependsOn:
      - job: store-secret
        condition:
          type: succeeded
          ref: store-secret
    weight: 1
`;

      await Deno.writeTextFile(`workflows/workflow-${workflowId}.yaml`, workflowContent);

      // Create the vault model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "vault/test"
      ]);
      assertEquals(modelResult.success, true);

      // Run the workflow
      const workflowResult = await runCli(["workflow", "run", "vault-workflow-test"]);
      assertEquals(workflowResult.success, true);

      const workflowOutput = JSON.parse(workflowResult.stdout);
      assertEquals(workflowOutput.status, "succeeded");

      // Verify vault file was created
      const vaultFileExists = existsSync(".vault-workflow-vault/workflow-api-key.enc");
      assertEquals(vaultFileExists, true);
    });
  });
});