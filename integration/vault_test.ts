/**
 * Integration tests for vault commands.
 *
 * Tests:
 * 1. vault create creates a vault config file in the correct location
 * 2. vault create rejects duplicate vault names
 * 3. vault create rejects unknown vault types
 * 4. vault type search returns available vault types
 * 5. vault search returns vaults in the repository
 * 6. vault get shows vault details
 * 7. vault edit requires vault name in non-interactive mode
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-integration-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Runs a CLI command from the project root directory.
 * Runs main.ts directly to avoid deno task output interfering with stderr.
 */
async function runCliCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(), // Run from project root
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("CLI: vault create command creates vault config file", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "create",
      "aws",
      "my-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Parse the JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.name, "my-test-vault");
    assertEquals(output.type, "aws");
    assertEquals(output.typeName, "AWS Secrets Manager");
    assertEquals(output.config.region, "us-east-1");

    // Find the created vault file
    const vaultDir = join(repoDir, ".swamp", "vault", "aws");
    assertEquals(existsSync(vaultDir), true, "Vault directory should exist");

    // Read the vault config file
    const files = [];
    for await (const entry of Deno.readDir(vaultDir)) {
      if (entry.isFile && entry.name.endsWith(".yaml")) {
        files.push(entry.name);
      }
    }
    assertEquals(files.length, 1, "Should have exactly one vault config file");

    const vaultPath = join(vaultDir, files[0]);
    const vaultContent = await Deno.readTextFile(vaultPath);
    const vaultData = parseYaml(vaultContent) as Record<string, unknown>;

    assertEquals(vaultData.name, "my-test-vault");
    assertEquals(vaultData.type, "aws");
    assertEquals(typeof vaultData.id, "string");
    assertEquals(typeof vaultData.createdAt, "string");

    const config = vaultData.config as Record<string, unknown>;
    assertEquals(config.region, "us-east-1");
  });
});

Deno.test("CLI: vault create command creates local_encryption vault", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "my-local-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.name, "my-local-vault");
    assertEquals(output.type, "local_encryption");
    assertEquals(output.typeName, "Local Encryption");
    assertEquals(output.config.auto_generate, true);

    // Verify file location
    const vaultDir = join(repoDir, ".swamp", "vault", "local_encryption");
    assertEquals(existsSync(vaultDir), true, "Vault directory should exist");
  });
});

Deno.test("CLI: vault create command rejects duplicate vault names", async () => {
  await withTempDir(async (repoDir) => {
    // Create first vault
    const result1 = await runCliCommand([
      "vault",
      "create",
      "aws",
      "duplicate-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result1.code, 0, "First create should succeed");

    // Try to create another vault with the same name
    const result2 = await runCliCommand([
      "vault",
      "create",
      "aws",
      "duplicate-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result2.code !== 0, true, "Should fail for duplicate name");

    // Error output goes to stderr in JSON mode
    const output = JSON.parse(result2.stderr);
    assertStringIncludes(output.error, "already exists");
  });
});

Deno.test("CLI: vault create command rejects duplicate names across types", async () => {
  await withTempDir(async (repoDir) => {
    // Create vault with aws type
    const result1 = await runCliCommand([
      "vault",
      "create",
      "aws",
      "shared-name",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result1.code, 0, "First create should succeed");

    // Try to create vault with same name but different type
    const result2 = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "shared-name",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      result2.code !== 0,
      true,
      "Should fail for duplicate name even with different type",
    );

    // Error output goes to stderr in JSON mode
    const output = JSON.parse(result2.stderr);
    assertStringIncludes(output.error, "already exists");
  });
});

Deno.test("CLI: vault create command rejects unknown vault type", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "create",
      "unknown-type",
      "my-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code !== 0, true, "Should fail for unknown type");

    // Error output goes to stderr in JSON mode
    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "Unknown vault type");
  });
});

Deno.test("CLI: vault create command rejects invalid vault names", async () => {
  await withTempDir(async (repoDir) => {
    // Name starting with number
    const result1 = await runCliCommand([
      "vault",
      "create",
      "aws",
      "123-invalid",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result1.code !== 0, true, "Should fail for invalid name");

    // Error output goes to stderr in JSON mode
    const output1 = JSON.parse(result1.stderr);
    assertStringIncludes(output1.error, "Invalid vault name");

    // Name with uppercase
    const result2 = await runCliCommand([
      "vault",
      "create",
      "aws",
      "InvalidName",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result2.code !== 0, true, "Should fail for uppercase name");

    // Error output goes to stderr in JSON mode
    const output2 = JSON.parse(result2.stderr);
    assertStringIncludes(output2.error, "Invalid vault name");
  });
});

Deno.test("CLI: vault type search returns available types", async () => {
  const result = await runCliCommand(["vault", "type", "search", "--json"]);

  assertEquals(
    result.code,
    0,
    `Command should succeed. stderr: ${result.stderr}`,
  );

  const output = JSON.parse(result.stdout);
  assertEquals(output.query, "");
  assertEquals(Array.isArray(output.results), true);
  assertEquals(output.results.length, 2); // aws and local_encryption (mock excluded)

  const types = output.results.map((r: { type: string }) => r.type);
  assertEquals(types.includes("aws"), true);
  assertEquals(types.includes("local_encryption"), true);
  assertEquals(types.includes("mock"), false); // mock should be excluded
});

Deno.test("CLI: vault type search filters by query", async () => {
  const result = await runCliCommand([
    "vault",
    "type",
    "search",
    "aws",
    "--json",
  ]);

  assertEquals(result.code, 0);

  const output = JSON.parse(result.stdout);
  assertEquals(output.query, "aws");
  assertEquals(output.results.length, 1);
  assertEquals(output.results[0].type, "aws");
});

Deno.test("CLI: vault create creates logical view symlink", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "create",
      "aws",
      "my-indexed-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify the logical view directory structure exists
    // /vaults/{vault-name}/vault.yaml -> /.swamp/vault/{vault-type}/{id}.yaml
    const logicalViewDir = join(repoDir, "vaults", "my-indexed-vault");
    assertEquals(
      existsSync(logicalViewDir),
      true,
      "Logical view directory should exist",
    );

    const vaultYamlPath = join(logicalViewDir, "vault.yaml");
    assertEquals(
      existsSync(vaultYamlPath),
      true,
      "vault.yaml symlink should exist",
    );

    // Verify it's a symlink
    const stat = await Deno.lstat(vaultYamlPath);
    assertEquals(stat.isSymlink, true, "vault.yaml should be a symlink");

    // Read through the symlink and verify content
    const content = await Deno.readTextFile(vaultYamlPath);
    const vaultData = parseYaml(content) as Record<string, unknown>;
    assertEquals(vaultData.name, "my-indexed-vault");
    assertEquals(vaultData.type, "aws");
  });
});

// ============================================================================
// vault search tests
// ============================================================================

Deno.test("CLI: vault search returns empty results for empty repository", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "search",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.query, "");
    assertEquals(Array.isArray(output.results), true);
    assertEquals(output.results.length, 0);
  });
});

Deno.test("CLI: vault search returns all vaults in repository", async () => {
  await withTempDir(async (repoDir) => {
    // Create two vaults
    await runCliCommand([
      "vault",
      "create",
      "aws",
      "vault-one",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "vault-two",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    const result = await runCliCommand([
      "vault",
      "search",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.results.length, 2);

    const names = output.results.map((r: { name: string }) => r.name);
    assertEquals(names.includes("vault-one"), true);
    assertEquals(names.includes("vault-two"), true);
  });
});

Deno.test("CLI: vault search filters by query", async () => {
  await withTempDir(async (repoDir) => {
    // Create two vaults
    await runCliCommand([
      "vault",
      "create",
      "aws",
      "production-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "create",
      "aws",
      "staging-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    const result = await runCliCommand([
      "vault",
      "search",
      "production",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code, 0);

    const output = JSON.parse(result.stdout);
    assertEquals(output.query, "production");
    assertEquals(output.results.length, 1);
    assertEquals(output.results[0].name, "production-vault");
  });
});

// ============================================================================
// vault get tests
// ============================================================================

Deno.test("CLI: vault get shows vault details by name", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "aws",
      "my-get-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    const result = await runCliCommand([
      "vault",
      "get",
      "my-get-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.name, "my-get-vault");
    assertEquals(output.type, "aws");
    assertEquals(typeof output.id, "string");
    assertEquals(typeof output.createdAt, "string");
    assertEquals(typeof output.config, "object");
    assertEquals(output.config.region, "us-east-1");
    assertStringIncludes(output.storagePath, ".swamp/vault/aws/");
  });
});

Deno.test("CLI: vault get shows vault details by ID", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault and get its ID
    const createResult = await runCliCommand([
      "vault",
      "create",
      "aws",
      "vault-by-id",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    const createOutput = JSON.parse(createResult.stdout);
    const vaultId = createOutput.id;

    const result = await runCliCommand([
      "vault",
      "get",
      vaultId,
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.id, vaultId);
    assertEquals(output.name, "vault-by-id");
  });
});

Deno.test("CLI: vault get fails for non-existent vault", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "get",
      "nonexistent-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code !== 0, true, "Should fail for non-existent vault");

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "Vault not found");
  });
});

Deno.test("CLI: vault get with --type narrows search", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "aws",
      "typed-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Get with correct type
    const result1 = await runCliCommand([
      "vault",
      "get",
      "typed-vault",
      "--type",
      "aws",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result1.code, 0);

    // Get with wrong type should fail
    const result2 = await runCliCommand([
      "vault",
      "get",
      "typed-vault",
      "--type",
      "local_encryption",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result2.code !== 0, true, "Should fail with wrong type");

    const output = JSON.parse(result2.stderr);
    assertStringIncludes(output.error, "has type 'aws'");
  });
});

// ============================================================================
// vault edit tests
// ============================================================================

Deno.test("CLI: vault edit requires vault name in non-interactive mode", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "edit",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code !== 0,
      true,
      "Should fail without vault name in JSON mode",
    );

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "required in non-interactive mode");
  });
});

Deno.test("CLI: vault edit fails for non-existent vault", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "edit",
      "nonexistent-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code !== 0, true, "Should fail for non-existent vault");

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "Vault not found");
  });
});

Deno.test("CLI: vault edit with --type narrows search", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "aws",
      "edit-typed-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Edit with wrong type should fail
    const result = await runCliCommand([
      "vault",
      "edit",
      "edit-typed-vault",
      "--type",
      "local_encryption",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(result.code !== 0, true, "Should fail with wrong type");

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "has type 'aws'");
  });
});

// ============================================================================
// Vault config loading tests (regression tests for vault storage location)
// ============================================================================

Deno.test("CLI: vault configs are loaded from .swamp/vault/ directory", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault using the CLI (stores in .swamp/vault/)
    const createResult = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "test-storage-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      createResult.code,
      0,
      `Vault create should succeed. stderr: ${createResult.stderr}`,
    );

    // Verify the vault config file exists in .swamp/vault/local_encryption/
    const vaultDir = join(repoDir, ".swamp", "vault", "local_encryption");
    assertEquals(existsSync(vaultDir), true, "Vault directory should exist");

    // Verify we can retrieve the vault via vault get (which uses the repository)
    const getResult = await runCliCommand([
      "vault",
      "get",
      "test-storage-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      getResult.code,
      0,
      `Vault get should succeed. stderr: ${getResult.stderr}`,
    );

    const output = JSON.parse(getResult.stdout);
    assertEquals(output.name, "test-storage-vault");
    assertEquals(output.type, "local_encryption");
    assertStringIncludes(
      output.storagePath,
      ".swamp/vault/local_encryption/",
      "Storage path should be in .swamp/vault/",
    );
  });
});

// ============================================================================
// End-to-end vault expression tests
// ============================================================================

Deno.test("CLI: vault expression resolves secrets from created vault", async () => {
  await withTempDir(async (repoDir) => {
    // 1. Create a local_encryption vault via CLI
    const vaultCreateResult = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "e2e-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      vaultCreateResult.code,
      0,
      `Vault create should succeed. stderr: ${vaultCreateResult.stderr}`,
    );

    // 2. Create a vault model definition to store a secret
    const secretValue = "my-super-secret-api-key-12345";
    // Use valid UUID v4 format (version 4 = third group starts with 4, variant = fourth group starts with 8-b)
    const putDefinitionId = "a1b2c3d4-e5f6-4789-8abc-def012345678";
    const putDefinitionContent = `
id: ${putDefinitionId}
name: store-secret
version: 1
tags: {}
attributes:
  vaultName: e2e-test-vault
  secretKey: api-key
  secretValue: "${secretValue}"
  operation: put
`;
    const vaultDefinitionDir = join(
      repoDir,
      ".swamp",
      "definitions",
      "swamp/lets-get-sensitive",
    );
    await Deno.mkdir(vaultDefinitionDir, { recursive: true });
    await Deno.writeTextFile(
      join(vaultDefinitionDir, `${putDefinitionId}.yaml`),
      putDefinitionContent,
    );

    // Run the vault put method to store the secret
    const putResult = await runCliCommand([
      "model",
      "method",
      "run",
      "store-secret",
      "put",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      putResult.code,
      0,
      `Vault put should succeed. stderr: ${putResult.stderr}`,
    );

    // 3. Create an echo model definition with a vault.get() expression
    const echoDefinitionId = "b2c3d4e5-f6a7-4890-9bcd-ef0123456789";
    const echoDefinitionContent = `
id: ${echoDefinitionId}
name: echo-with-vault
version: 1
tags: {}
attributes:
  message: "\${{ vault.get(e2e-test-vault, api-key) }}"
`;
    const echoDefinitionDir = join(
      repoDir,
      ".swamp",
      "definitions",
      "swamp/echo",
    );
    await Deno.mkdir(echoDefinitionDir, { recursive: true });
    await Deno.writeTextFile(
      join(echoDefinitionDir, `${echoDefinitionId}.yaml`),
      echoDefinitionContent,
    );

    // 4. Evaluate the expression using model evaluate
    const evalResult = await runCliCommand([
      "model",
      "evaluate",
      "echo-with-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      evalResult.code,
      0,
      `Model evaluate should succeed. stderr: ${evalResult.stderr}`,
    );

    // 5. Verify the evaluate command produced the expected output
    const evalOutput = JSON.parse(evalResult.stdout);
    assertEquals(
      evalOutput.name,
      "echo-with-vault",
      "Evaluated definition should have the correct name",
    );
    assertEquals(
      evalOutput.attributes.message,
      secretValue,
      "Vault expression should resolve to the secret value",
    );
  });
});

// ============================================================================
// vault put CLI tests
// ============================================================================

Deno.test("CLI: vault put stores secret in vault", async () => {
  await withTempDir(async (repoDir) => {
    // Create a local_encryption vault
    const createResult = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "put-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      createResult.code,
      0,
      `Vault create should succeed. stderr: ${createResult.stderr}`,
    );

    // Store a secret using vault put
    const result = await runCliCommand([
      "vault",
      "put",
      "put-test-vault",
      "API_KEY=secret-value-123",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.vaultName, "put-test-vault");
    assertEquals(output.secretKey, "API_KEY");
    assertEquals(output.vaultType, "local_encryption");
    assertEquals(output.overwritten, false);

    // Verify the secret file was created
    const secretPath = join(
      repoDir,
      ".swamp",
      "secrets",
      "local_encryption",
      "put-test-vault",
      "API_KEY.enc",
    );
    assertEquals(existsSync(secretPath), true, "Secret file should exist");
  });
});

Deno.test("CLI: vault put handles values with equals signs", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "equals-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store a value that contains equals signs
    const result = await runCliCommand([
      "vault",
      "put",
      "equals-test-vault",
      "TOKEN=abc=def=ghi",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code, 0);

    const output = JSON.parse(result.stdout);
    assertEquals(output.secretKey, "TOKEN");

    // The secret should be stored - we can't easily verify the value
    // but we can verify the file exists
    const secretPath = join(
      repoDir,
      ".swamp",
      "secrets",
      "local_encryption",
      "equals-test-vault",
      "TOKEN.enc",
    );
    assertEquals(existsSync(secretPath), true);
  });
});

Deno.test("CLI: vault put fails for non-existent vault", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "put",
      "nonexistent-vault",
      "KEY=value",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code !== 0, true, "Should fail for non-existent vault");

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "not found");
  });
});

Deno.test("CLI: vault put fails for invalid KEY=VALUE format", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "format-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Missing equals sign
    const result = await runCliCommand([
      "vault",
      "put",
      "format-test-vault",
      "invalid-no-equals",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code !== 0, true, "Should fail for invalid format");

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "Invalid argument format");
  });
});

Deno.test("CLI: vault put --force skips overwrite confirmation", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "force-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store initial secret
    await runCliCommand([
      "vault",
      "put",
      "force-test-vault",
      "KEY=initial-value",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Overwrite with --force flag
    const result = await runCliCommand([
      "vault",
      "put",
      "force-test-vault",
      "KEY=new-value",
      "--force",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.secretKey, "KEY");
    assertEquals(output.overwritten, true);
  });
});

Deno.test("CLI: vault put allows empty value", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "empty-value-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store empty value
    const result = await runCliCommand([
      "vault",
      "put",
      "empty-value-vault",
      "EMPTY_KEY=",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code, 0);

    const output = JSON.parse(result.stdout);
    assertEquals(output.secretKey, "EMPTY_KEY");
  });
});

// ============================================================================
// vault list-keys CLI tests
// ============================================================================

Deno.test("CLI: vault list-keys returns empty list for vault with no secrets", async () => {
  await withTempDir(async (repoDir) => {
    // Create a local_encryption vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "list-empty-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // List secret keys
    const result = await runCliCommand([
      "vault",
      "list-keys",
      "list-empty-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.vaultName, "list-empty-vault");
    assertEquals(output.vaultType, "local_encryption");
    assertEquals(output.secretKeys.length, 0);
    assertEquals(output.count, 0);
  });
});

Deno.test("CLI: vault list-keys returns stored secret keys", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "list-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store some secrets
    await runCliCommand([
      "vault",
      "put",
      "list-test-vault",
      "API_KEY=secret1",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "list-test-vault",
      "DATABASE_PASSWORD=secret2",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "list-test-vault",
      "JWT_SECRET=secret3",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // List secret keys
    const result = await runCliCommand([
      "vault",
      "list-keys",
      "list-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.vaultName, "list-test-vault");
    assertEquals(output.count, 3);
    assertEquals(output.secretKeys.includes("API_KEY"), true);
    assertEquals(output.secretKeys.includes("DATABASE_PASSWORD"), true);
    assertEquals(output.secretKeys.includes("JWT_SECRET"), true);
  });
});

Deno.test("CLI: vault list-keys fails for non-existent vault", async () => {
  await withTempDir(async (repoDir) => {
    const result = await runCliCommand([
      "vault",
      "list-keys",
      "nonexistent-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code !== 0, true, "Should fail for non-existent vault");

    const output = JSON.parse(result.stderr);
    assertStringIncludes(output.error, "not found");
  });
});

Deno.test("CLI: vault list-keys returns keys in sorted order", async () => {
  await withTempDir(async (repoDir) => {
    // Create a vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "sorted-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store secrets in non-alphabetical order
    await runCliCommand([
      "vault",
      "put",
      "sorted-vault",
      "ZEBRA=z",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "sorted-vault",
      "APPLE=a",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "sorted-vault",
      "MANGO=m",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // List secret keys
    const result = await runCliCommand([
      "vault",
      "list-keys",
      "sorted-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(result.code, 0);

    const output = JSON.parse(result.stdout);
    // Verify alphabetical order
    assertEquals(output.secretKeys[0], "APPLE");
    assertEquals(output.secretKeys[1], "MANGO");
    assertEquals(output.secretKeys[2], "ZEBRA");
  });
});
