import { assertEquals, assertStringIncludes } from "@std/assert";
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
  await t.step("should store and retrieve secrets via CLI with auto-generated keys", async () => {
    await withTempDir(async () => {
      // Create .swamp.yaml with local encryption vault
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  test-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create a test vault model
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "vault-test"
      ]);
      assertEquals(modelResult.success, true);

      // Edit the model to store a secret
      const modelData = JSON.parse(modelResult.stdout);
      const modelPath = modelData.path;
      
      await Deno.writeTextFile(modelPath, `
id: ${modelData.id}
name: vault-test
version: 1
tags: {}
attributes:
  vaultName: test-vault
  secretKey: my-api-key
  secretValue: sk-1234567890abcdef
  operation: put
`);

      // Store the secret
      const putResult = await runCli([
        "model", "method", "run", "vault-test", "put"
      ]);
      assertEquals(putResult.success, true);
      
      const putOutput = JSON.parse(putResult.stdout);
      assertEquals(putOutput.data.attributes.success, true);
      assertEquals(putOutput.data.attributes.vaultName, "test-vault");
      assertEquals(putOutput.data.attributes.storedKey, "my-api-key");

      // Verify vault directory was created
      const vaultDirExists = existsSync(".vault-test-vault");
      assertEquals(vaultDirExists, true);

      // Verify encrypted file exists
      const encryptedFileExists = existsSync(".vault-test-vault/my-api-key.enc");
      assertEquals(encryptedFileExists, true);

      // Read encrypted file and verify it doesn't contain plaintext
      const encryptedContent = await Deno.readTextFile(".vault-test-vault/my-api-key.enc");
      assertEquals(encryptedContent.includes("sk-1234567890abcdef"), false);
      
      // Verify it's valid JSON with required fields
      const encryptedData = JSON.parse(encryptedContent);
      assertEquals(typeof encryptedData.iv, "string");
      assertEquals(typeof encryptedData.data, "string");
      assertEquals(typeof encryptedData.salt, "string");
      assertEquals(typeof encryptedData.version, "number");

      // Update model to retrieve the secret
      await Deno.writeTextFile(modelPath, `
id: ${modelData.id}
name: vault-test
version: 1
tags: {}
attributes:
  vaultName: test-vault
  secretKey: my-api-key
  operation: get
`);

      // Retrieve the secret
      const getResult = await runCli([
        "model", "method", "run", "vault-test", "get"
      ]);
      assertEquals(getResult.success, true);
      
      const getOutput = JSON.parse(getResult.stdout);
      assertEquals(getOutput.data.attributes.success, true);
      assertEquals(getOutput.data.attributes.vaultName, "test-vault");
      assertEquals(getOutput.data.attributes.secretKey, "my-api-key");
      assertEquals(getOutput.data.attributes.secretLength, 19); // Length of "sk-1234567890abcdef"
    });
  });

  await t.step("should handle multiple secrets in same vault", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  multi-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      const secrets = [
        { key: "db-password", value: "super-secure-db-pass" },
        { key: "jwt-secret", value: "jwt-signing-key-456" },
        { key: "api-token", value: "bearer-token-789" }
      ];

      for (const secret of secrets) {
        // Create model for each secret
        const modelResult = await runCli([
          "model", "create", "swamp/lets-get-sensitive", `test-${secret.key}`
        ]);
        assertEquals(modelResult.success, true);
        
        const modelData = JSON.parse(modelResult.stdout);
        
        // Set up the model to store the secret
        await Deno.writeTextFile(modelData.path, `
id: ${modelData.id}
name: test-${secret.key}
version: 1
tags: {}
attributes:
  vaultName: multi-vault
  secretKey: ${secret.key}
  secretValue: ${secret.value}
  operation: put
`);

        // Store the secret
        const putResult = await runCli([
          "model", "method", "run", `test-${secret.key}`, "put"
        ]);
        assertEquals(putResult.success, true);
        
        // Verify encrypted file exists
        const encryptedFileExists = existsSync(`.vault-multi-vault/${secret.key}.enc`);
        assertEquals(encryptedFileExists, true);
      }

      // Verify all secrets can be retrieved
      for (const secret of secrets) {
        const modelResult = await runCli([
          "model", "create", "swamp/lets-get-sensitive", `get-${secret.key}`
        ]);
        const modelData = JSON.parse(modelResult.stdout);
        
        await Deno.writeTextFile(modelData.path, `
id: ${modelData.id}
name: get-${secret.key}
version: 1
tags: {}
attributes:
  vaultName: multi-vault
  secretKey: ${secret.key}
  operation: get
`);

        const getResult = await runCli([
          "model", "method", "run", `get-${secret.key}`, "get"
        ]);
        assertEquals(getResult.success, true);
        
        const getOutput = JSON.parse(getResult.stdout);
        assertEquals(getOutput.data.attributes.success, true);
        assertEquals(getOutput.data.attributes.secretLength, secret.value.length);
      }
    });
  });

  await t.step("should provide helpful error for non-existent vault", async () => {
    await withTempDir(async () => {
      // Create model without vault configuration
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "error-test"
      ]);
      assertEquals(modelResult.success, true);
      
      const modelData = JSON.parse(modelResult.stdout);
      
      // Set up model to use non-existent vault
      await Deno.writeTextFile(modelData.path, `
id: ${modelData.id}
name: error-test
version: 1
tags: {}
attributes:
  vaultName: missing-vault
  secretKey: test-key
  secretValue: test-value
  operation: put
`);

      // Try to use non-existent vault
      const putResult = await runCli([
        "model", "method", "run", "error-test", "put"
      ]);
      assertEquals(putResult.success, false);
      const errorOutput = putResult.stdout + putResult.stderr;
      assertStringIncludes(errorOutput, "Vault 'missing-vault' not found");
      assertStringIncludes(errorOutput, "No vaults are configured");
    });
  });

  await t.step("should provide helpful error for missing secret", async () => {
    await withTempDir(async () => {
      // Create vault configuration
      await Deno.writeTextFile(".swamp.yaml", `
vaults:
  empty-vault:
    type: local_encryption
    config:
      auto_generate: true
`);

      // Create model to get non-existent secret
      const modelResult = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "missing-test"
      ]);
      assertEquals(modelResult.success, true);
      
      const modelData = JSON.parse(modelResult.stdout);
      
      await Deno.writeTextFile(modelData.path, `
id: ${modelData.id}
name: missing-test
version: 1
tags: {}
attributes:
  vaultName: empty-vault
  secretKey: non-existent-key
  operation: get
`);

      // Try to get non-existent secret
      const getResult = await runCli([
        "model", "method", "run", "missing-test", "get"
      ]);
      assertEquals(getResult.success, false);
      const errorOutput = getResult.stdout + getResult.stderr;
      assertStringIncludes(errorOutput, "Secret 'non-existent-key' not found");
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

      // Store secret with first model
      const model1Result = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "store-model"
      ]);
      const model1Data = JSON.parse(model1Result.stdout);
      
      await Deno.writeTextFile(model1Data.path, `
id: ${model1Data.id}
name: store-model
version: 1
tags: {}
attributes:
  vaultName: persistent-vault
  secretKey: shared-secret
  secretValue: shared-value-123
  operation: put
`);

      const putResult = await runCli([
        "model", "method", "run", "store-model", "put"
      ]);
      assertEquals(putResult.success, true);

      // Retrieve secret with second model
      const model2Result = await runCli([
        "model", "create", "swamp/lets-get-sensitive", "retrieve-model"
      ]);
      const model2Data = JSON.parse(model2Result.stdout);
      
      await Deno.writeTextFile(model2Data.path, `
id: ${model2Data.id}
name: retrieve-model
version: 1
tags: {}
attributes:
  vaultName: persistent-vault
  secretKey: shared-secret
  operation: get
`);

      const getResult = await runCli([
        "model", "method", "run", "retrieve-model", "get"
      ]);
      assertEquals(getResult.success, true);
      
      const getOutput = JSON.parse(getResult.stdout);
      assertEquals(getOutput.data.attributes.success, true);
      assertEquals(getOutput.data.attributes.secretLength, 16); // Length of "shared-value-123"
    });
  });
});