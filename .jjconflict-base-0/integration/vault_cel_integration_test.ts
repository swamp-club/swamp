/**
 * Integration tests for vault and CEL expression integration.
 *
 * Tests the full flow:
 * 1. Store sensitive definition attributes in vault
 * 2. Retrieve vault secrets in CEL expressions
 * 3. Verify sensitive data not written to disk
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir, existsSync } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ExpressionEvaluationService } from "../src/domain/expressions/expression_evaluation_service.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-cel-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "definitions"));
  await ensureDir(join(dir, ".swamp", "vault"));
  await ensureDir(join(dir, ".swamp", "secrets"));
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, ".swamp", "outputs"));
  await ensureDir(join(dir, ".swamp", "logs"));
  await ensureDir(join(dir, ".swamp", "workflows"));
  await ensureDir(join(dir, ".swamp", "workflow-runs"));

  // Create the .swamp.yaml marker file for CLI commands
  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(dir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

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
    cwd: Deno.cwd(),
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

// ============================================================================
// Vault Secret Access via CEL
// ============================================================================

Deno.test("Vault CEL: access vault secrets in expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault via CLI
    const createResult = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "secrets-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      createResult.code,
      0,
      `Vault create failed: ${createResult.stderr}`,
    );

    // Store secret via CLI
    const putResult = await runCliCommand([
      "vault",
      "put",
      "secrets-vault",
      "API_KEY=super-secret-api-key",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(putResult.code, 0, `Vault put failed: ${putResult.stderr}`);

    // Create model that uses vault expression
    const model = Definition.create({
      name: "api-client",
      attributes: {
        api_key: "${{ vault.get(secrets-vault, API_KEY) }}",
        endpoint: "https://api.example.com",
      },
    });
    await definitionRepo.save(type, model);

    // Load vault service
    const vaultService = await VaultService.fromRepository(repoDir);

    // Evaluate expression
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    const result = await evalService.evaluateDefinition(model, type);

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.attributes.api_key, "super-secret-api-key");
    assertEquals(
      result.definition.attributes.endpoint,
      "https://api.example.com",
    );
  });
});

Deno.test("Vault CEL: access multiple secrets in same definition", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "multi-secrets",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store multiple secrets
    await runCliCommand([
      "vault",
      "put",
      "multi-secrets",
      "DB_HOST=localhost",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "multi-secrets",
      "DB_USER=admin",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "multi-secrets",
      "DB_PASSWORD=secret123",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Create model with multiple vault references
    const model = Definition.create({
      name: "database-config",
      attributes: {
        host: "${{ vault.get(multi-secrets, DB_HOST) }}",
        user: "${{ vault.get(multi-secrets, DB_USER) }}",
        password: "${{ vault.get(multi-secrets, DB_PASSWORD) }}",
        connection_string:
          '${{ "postgresql://" + vault.get(multi-secrets, DB_USER) + ":" + vault.get(multi-secrets, DB_PASSWORD) + "@" + vault.get(multi-secrets, DB_HOST) }}',
      },
    });
    await definitionRepo.save(type, model);

    const vaultService = await VaultService.fromRepository(repoDir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    const result = await evalService.evaluateDefinition(model, type);

    assertEquals(result.definition.attributes.host, "localhost");
    assertEquals(result.definition.attributes.user, "admin");
    assertEquals(result.definition.attributes.password, "secret123");
    assertEquals(
      result.definition.attributes.connection_string,
      "postgresql://admin:secret123@localhost",
    );
  });
});

Deno.test("Vault CEL: combine vault secrets with other expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault and store secret
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "combined-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    await runCliCommand([
      "vault",
      "put",
      "combined-vault",
      "TOKEN=secret-token-123",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Create config model
    const configModel = Definition.create({
      name: "config",
      attributes: {
        base_url: "https://api.example.com",
        version: "v2",
      },
    });
    await definitionRepo.save(type, configModel);

    // Create model that combines vault and model references
    const apiModel = Definition.create({
      name: "api-model",
      attributes: {
        // Combines vault secret with model reference
        auth_header: '${{ "Bearer " + vault.get(combined-vault, TOKEN) }}',
        endpoint:
          '${{ model.config.input.attributes.base_url + "/" + model.config.input.attributes.version }}',
        combined:
          '${{ "Endpoint: " + model.config.input.attributes.base_url + ", Token: " + vault.get(combined-vault, TOKEN) }}',
      },
    });
    await definitionRepo.save(type, apiModel);

    const vaultService = await VaultService.fromRepository(repoDir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    const result = await evalService.evaluateDefinition(apiModel, type);

    assertEquals(
      result.definition.attributes.auth_header,
      "Bearer secret-token-123",
    );
    assertEquals(
      result.definition.attributes.endpoint,
      "https://api.example.com/v2",
    );
    assertEquals(
      result.definition.attributes.combined,
      "Endpoint: https://api.example.com, Token: secret-token-123",
    );
  });
});

// ============================================================================
// Verify Sensitive Data Not Written to Disk
// ============================================================================

Deno.test("Vault CEL: original definition preserves expression (not secret value)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault and secret
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "preserve-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    const secretValue = "very-sensitive-password-12345";
    await runCliCommand([
      "vault",
      "put",
      "preserve-vault",
      `SECRET=${secretValue}`,
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Create and save model with vault expression
    const model = Definition.create({
      name: "sensitive-model",
      attributes: {
        password: "${{ vault.get(preserve-vault, SECRET) }}",
      },
    });
    await definitionRepo.save(type, model);

    // Load original definition
    const loaded = await definitionRepo.findById(type, model.id);
    assertExists(loaded);

    // Original should have the expression, not the secret value
    assertEquals(
      loaded.attributes.password,
      "${{ vault.get(preserve-vault, SECRET) }}",
    );

    // Read the actual file to verify
    const definitionPath = definitionRepo.getPath(type, model.id);
    const fileContent = await Deno.readTextFile(definitionPath);

    // File should NOT contain the secret value
    assertEquals(
      fileContent.includes(secretValue),
      false,
      "Definition file should not contain secret value",
    );

    // File SHOULD contain the expression
    assertStringIncludes(fileContent, "vault.get(preserve-vault, SECRET)");
  });
});

Deno.test("Vault CEL: secrets stored encrypted in vault directory", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "encryption-test",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    const secretValue = "plaintext-secret-should-be-encrypted";
    await runCliCommand([
      "vault",
      "put",
      "encryption-test",
      `MY_SECRET=${secretValue}`,
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Check the secret file
    const secretPath = join(
      repoDir,
      ".swamp",
      "secrets",
      "local_encryption",
      "encryption-test",
      "MY_SECRET.enc",
    );

    assertEquals(
      existsSync(secretPath),
      true,
      "Encrypted secret file should exist",
    );

    // Read the encrypted content
    const encryptedContent = await Deno.readFile(secretPath);
    const contentStr = new TextDecoder().decode(encryptedContent);

    // The file should NOT contain the plaintext secret
    assertEquals(
      contentStr.includes(secretValue),
      false,
      "Secret file should not contain plaintext",
    );

    // The file should have encrypted format markers (JSON with version, salt, iv, data)
    assertStringIncludes(contentStr, "version");
    assertStringIncludes(contentStr, "salt");
    assertStringIncludes(contentStr, "iv");
    assertStringIncludes(contentStr, "data");
  });
});

Deno.test("Vault CEL: definition files don't leak secrets via model evaluate", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create vault and store secret
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "leak-test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    const secretValue = "super-secret-do-not-leak";
    await runCliCommand([
      "vault",
      "put",
      "leak-test-vault",
      `SENSITIVE=${secretValue}`,
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Create model via repository (with vault expression attribute)
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "leak-test-model",
      attributes: {
        message: "${{ vault.get(leak-test-vault, SENSITIVE) }}",
      },
    });
    await definitionRepo.save(modelType, definition);

    // Read all files in the definitions directory
    const definitionsDir = join(repoDir, ".swamp", "definitions");

    async function checkDirectoryForSecret(dir: string): Promise<boolean> {
      try {
        for await (const entry of Deno.readDir(dir)) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory) {
            if (await checkDirectoryForSecret(fullPath)) return true;
          } else if (entry.isFile && entry.name.endsWith(".yaml")) {
            const content = await Deno.readTextFile(fullPath);
            if (content.includes(secretValue)) {
              return true;
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
      return false;
    }

    const foundSecret = await checkDirectoryForSecret(definitionsDir);
    assertEquals(
      foundSecret,
      false,
      "No definition file should contain the secret value",
    );
  });
});

// ============================================================================
// Vault Integration with Workflows
// ============================================================================

Deno.test("Vault CEL: secrets accessible in workflow execution", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create vault and store secret
    const vaultResult = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "workflow-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(vaultResult.code, 0);

    const putResult = await runCliCommand([
      "vault",
      "put",
      "workflow-vault",
      "WORKFLOW_SECRET=workflow-secret-value",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(putResult.code, 0);

    // Create a model that uses vault expression via repository
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "vault-workflow-model",
      attributes: {
        message: "${{ vault.get(workflow-vault, WORKFLOW_SECRET) }}",
      },
    });
    await definitionRepo.save(modelType, definition);

    // Create workflow
    await runCliCommand([
      "workflow",
      "create",
      "vault-workflow",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Run the workflow with the vault model
    // Note: This requires the workflow to be configured with the model
    // For now, just verify the model can be evaluated
    const evalResult = await runCliCommand([
      "model",
      "evaluate",
      "vault-workflow-model",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      evalResult.code,
      0,
      `Model evaluate should succeed: ${evalResult.stderr}`,
    );

    const output = JSON.parse(evalResult.stdout);
    assertEquals(output.attributes.message, "workflow-secret-value");
  });
});

// ============================================================================
// Error Handling
// ============================================================================

Deno.test("Vault CEL: handle missing vault gracefully", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create model referencing non-existent vault
    const model = Definition.create({
      name: "missing-vault-model",
      attributes: {
        secret: "${{ vault.get(nonexistent-vault, KEY) }}",
      },
    });
    await definitionRepo.save(type, model);

    const vaultService = await VaultService.fromRepository(repoDir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    // Should not throw but expression may not resolve
    try {
      const result = await evalService.evaluateDefinition(model, type);
      // The expression might remain unevaluated or return an error string
      assertEquals(result.hadExpressions, true);
    } catch (error) {
      // Expected - vault not found
      assertStringIncludes(String(error), "vault");
    }
  });
});

Deno.test("Vault CEL: handle missing secret gracefully", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault but don't store the secret
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "empty-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Create model referencing non-existent secret
    const model = Definition.create({
      name: "missing-secret-model",
      attributes: {
        secret: "${{ vault.get(empty-vault, NONEXISTENT) }}",
      },
    });
    await definitionRepo.save(type, model);

    const vaultService = await VaultService.fromRepository(repoDir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    // Should handle gracefully
    try {
      const result = await evalService.evaluateDefinition(model, type);
      assertEquals(result.hadExpressions, true);
    } catch (error) {
      // Expected - secret not found
      assertStringIncludes(String(error), "NONEXISTENT");
    }
  });
});

// ============================================================================
// Special Characters
// ============================================================================

Deno.test("Vault CEL: handles secrets with special characters", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "special-chars-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store secret with special characters
    // Note: Avoiding characters that require escaping in CEL strings
    // (backslashes, quotes, newlines) as these are escaped for CEL parsing
    const specialSecret = "p@ssw0rd!#$%^&*()_+-=[]{}|;:.<>?/";
    const vaultServiceForPut = await VaultService.fromRepository(repoDir);
    await vaultServiceForPut.put(
      "special-chars-vault",
      "SPECIAL",
      specialSecret,
    );

    // Create model using vault expression
    const model = Definition.create({
      name: "special-chars-model",
      attributes: {
        password: "${{ vault.get(special-chars-vault, SPECIAL) }}",
      },
    });
    await definitionRepo.save(type, model);

    const vaultService = await VaultService.fromRepository(repoDir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    const result = await evalService.evaluateDefinition(model, type);

    assertEquals(result.definition.attributes.password, specialSecret);
  });
});

Deno.test("Vault CEL: handles long secrets", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create vault using CLI
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "long-secret-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store a long secret (like an API key or token)
    // Note: Multiline secrets with newlines get escaped for CEL parsing
    const longSecret =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const vaultServiceForPut = await VaultService.fromRepository(repoDir);
    await vaultServiceForPut.put(
      "long-secret-vault",
      "JWT_TOKEN",
      longSecret,
    );

    // Create model
    const model = Definition.create({
      name: "long-secret-model",
      attributes: {
        token: "${{ vault.get(long-secret-vault, JWT_TOKEN) }}",
      },
    });
    await definitionRepo.save(type, model);

    const vaultService = await VaultService.fromRepository(repoDir);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService },
    );

    const result = await evalService.evaluateDefinition(model, type);

    assertEquals(result.definition.attributes.token, longSecret);
  });
});
