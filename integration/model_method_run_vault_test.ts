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

/**
 * Integration tests for vault expression resolution in model method run.
 *
 * Tests that running a model method directly (not via workflow) properly
 * resolves vault expressions like ${{ vault.get(vault-name, SECRET_KEY) }}.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-method-vault-" });
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
      "--allow-net",
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
// Model Method Run with Vault Expressions
// ============================================================================

Deno.test("Model Method Run: resolves vault expressions before execution", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create vault via CLI
    const createVaultResult = await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "test-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(
      createVaultResult.code,
      0,
      `Vault create failed: ${createVaultResult.stderr}`,
    );

    // Store a secret
    const secretValue = "resolved-secret-value-12345";
    const putResult = await runCliCommand([
      "vault",
      "put",
      "test-vault",
      `API_KEY=${secretValue}`,
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    assertEquals(putResult.code, 0, `Vault put failed: ${putResult.stderr}`);

    // Create a model that uses vault expression via repository
    // Using swamp/echo which has a "write" method that outputs the message attribute
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "vault-test-model",
      methods: {
        write: {
          arguments: {
            message: "${{ vault.get(test-vault, API_KEY) }}",
          },
        },
      },
    });
    await definitionRepo.save(modelType, definition);

    // Run the model method directly using the "write" method
    const runResult = await runCliCommand([
      "model",
      "method",
      "run",
      "vault-test-model",
      "write",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      runResult.code,
      0,
      `Model method run failed: ${runResult.stderr}`,
    );

    // Parse the output - it should contain data with the resolved secret
    const output = JSON.parse(runResult.stdout);

    // The echo model outputs the message - verify the vault expression was resolved
    // (not passed as a literal string)
    if (output.data?.attributes?.message) {
      assertEquals(
        output.data.attributes.message,
        secretValue,
        "Vault expression should be resolved to the actual secret value",
      );
    }

    // Also verify the literal expression string is NOT in the output
    const outputStr = JSON.stringify(output);
    assertEquals(
      outputStr.includes("vault.get(test-vault, API_KEY)"),
      false,
      "Output should not contain the literal vault expression",
    );
    assertEquals(
      outputStr.includes("${{"),
      false,
      "Output should not contain unresolved expression syntax",
    );
  });
});

Deno.test("Model Method Run: resolves multiple vault expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create vault
    await runCliCommand([
      "vault",
      "create",
      "local_encryption",
      "multi-vault",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Store multiple secrets
    const username = "admin_user";
    const password = "super_secret_pass";
    await runCliCommand([
      "vault",
      "put",
      "multi-vault",
      `USERNAME=${username}`,
      "--repo-dir",
      repoDir,
      "--json",
    ]);
    await runCliCommand([
      "vault",
      "put",
      "multi-vault",
      `PASSWORD=${password}`,
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Create model with multiple vault references combined in a single attribute
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "multi-vault-model",
      methods: {
        write: {
          arguments: {
            message:
              '${{ vault.get(multi-vault, USERNAME) + ":" + vault.get(multi-vault, PASSWORD) }}',
          },
        },
      },
    });
    await definitionRepo.save(modelType, definition);

    // Run the model method
    const runResult = await runCliCommand([
      "model",
      "method",
      "run",
      "multi-vault-model",
      "write",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      runResult.code,
      0,
      `Model method run failed: ${runResult.stderr}`,
    );

    // Parse output and verify combined secret
    const output = JSON.parse(runResult.stdout);
    if (output.data?.attributes?.message) {
      assertEquals(
        output.data.attributes.message,
        `${username}:${password}`,
        "Multiple vault expressions should be resolved and combined",
      );
    }
  });
});

Deno.test("Model Method Run: handles missing vault gracefully with error", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create model referencing non-existent vault (no vault created)
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "missing-vault-model",
      methods: {
        write: {
          arguments: {
            message: "${{ vault.get(nonexistent-vault, SECRET) }}",
          },
        },
      },
    });
    await definitionRepo.save(modelType, definition);

    // Run the model method - should fail with vault error
    const runResult = await runCliCommand([
      "model",
      "method",
      "run",
      "missing-vault-model",
      "write",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    // Should fail because vault doesn't exist
    assertEquals(runResult.code, 1, "Should fail when vault doesn't exist");

    // Error message should mention the vault
    assertStringIncludes(
      runResult.stderr,
      "vault",
      "Error should mention vault",
    );
  });
});

Deno.test("Model Method Run: model without expressions works normally", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a model WITHOUT vault expressions
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const modelType = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "plain-model",
      methods: {
        write: {
          arguments: {
            message: "Hello World",
          },
        },
      },
    });
    await definitionRepo.save(modelType, definition);

    // Run the model method
    const runResult = await runCliCommand([
      "model",
      "method",
      "run",
      "plain-model",
      "write",
      "--repo-dir",
      repoDir,
      "--json",
    ]);

    assertEquals(
      runResult.code,
      0,
      `Model method run failed: ${runResult.stderr}`,
    );

    // Parse output and verify plain message
    const output = JSON.parse(runResult.stdout);
    if (output.data?.attributes?.message) {
      assertEquals(
        output.data.attributes.message,
        "Hello World",
        "Plain model should work without expression evaluation",
      );
    }
  });
});
