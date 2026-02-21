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
import { VaultService } from "./vault_service.ts";
import { ModelResolver } from "../expressions/model_resolver.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

Deno.test("Direct Vault Service Error Messages", async (t) => {
  await t.step(
    "should provide detailed error for missing vault configuration",
    async () => {
      const vaultService = new VaultService();

      const error = await assertRejects(
        () => vaultService.get("production", "api-key"),
        Error,
      );

      // Test the detailed error message format
      assertStringIncludes(
        error.message,
        "Vault 'production' not found. No vaults are configured.",
      );
      assertStringIncludes(
        error.message,
        "Vaults are NOT configured in .swamp.yaml",
      );
      assertStringIncludes(
        error.message,
        "swamp vault create <type> production",
      );
      assertStringIncludes(
        error.message,
        "Available vault types: aws, local_encryption",
      );
      assertStringIncludes(
        error.message,
        "Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
      );
    },
  );

  await t.step(
    "should provide specific vault name in error message",
    async () => {
      const vaultService = new VaultService();

      // Test with a different vault name to ensure it's dynamic
      const error = await assertRejects(
        () => vaultService.get("my-custom-vault", "secret-key"),
        Error,
      );

      assertStringIncludes(error.message, "Vault 'my-custom-vault' not found");
      assertStringIncludes(error.message, "swamp vault create");
      assertStringIncludes(error.message, "my-custom-vault");
    },
  );
});

Deno.test("ModelResolver.resolveVaultExpressions", async (t) => {
  // Use a temp directory for the repositories
  const tempDir = await Deno.makeTempDir();

  // Helper to create a ModelResolver with a mock vault
  function createResolverWithMockVault(
    secrets: Record<string, string>,
  ): ModelResolver {
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: "test-vault",
      type: "mock",
      config: secrets,
    });
    const definitionRepo = new YamlDefinitionRepository(tempDir);
    return new ModelResolver(definitionRepo, { vaultService });
  }

  await t.step("should resolve basic vault expression", async () => {
    const resolver = createResolverWithMockVault({ "api-key": "secret123" });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, api-key)",
    );
    assertEquals(result, '"secret123"');
  });

  await t.step(
    "should resolve vault expression with single quotes",
    async () => {
      const resolver = createResolverWithMockVault({ "api-key": "secret123" });
      const result = await resolver.resolveVaultExpressions(
        "vault.get('test-vault', 'api-key')",
      );
      assertEquals(result, '"secret123"');
    },
  );

  await t.step(
    "should resolve vault expression with double quotes",
    async () => {
      const resolver = createResolverWithMockVault({ "api-key": "secret123" });
      const result = await resolver.resolveVaultExpressions(
        'vault.get("test-vault", "api-key")',
      );
      assertEquals(result, '"secret123"');
    },
  );

  await t.step("should resolve vault expression with backticks", async () => {
    const resolver = createResolverWithMockVault({ "api-key": "secret123" });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(`test-vault`, `api-key`)",
    );
    assertEquals(result, '"secret123"');
  });

  await t.step("should resolve multiple vault expressions", async () => {
    const resolver = createResolverWithMockVault({
      "key1": "value1",
      "key2": "value2",
    });
    const result = await resolver.resolveVaultExpressions(
      'vault.get(test-vault, key1) + "-" + vault.get(test-vault, key2)',
    );
    assertEquals(result, '"value1" + "-" + "value2"');
  });

  await t.step("should escape double quotes in secret values", async () => {
    const resolver = createResolverWithMockVault({
      "json-secret": '{"key": "value"}',
    });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, json-secret)",
    );
    assertEquals(result, '"{\\"key\\": \\"value\\"}"');
  });

  await t.step("should escape backslashes in secret values", async () => {
    const resolver = createResolverWithMockVault({
      "path-secret": "C:\\Users\\test",
    });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, path-secret)",
    );
    assertEquals(result, '"C:\\\\Users\\\\test"');
  });

  await t.step("should escape newlines in secret values", async () => {
    const resolver = createResolverWithMockVault({
      "multiline-secret": "line1\nline2\r\nline3",
    });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, multiline-secret)",
    );
    assertEquals(result, '"line1\\nline2\\r\\nline3"');
  });

  await t.step("should escape tabs in secret values", async () => {
    const resolver = createResolverWithMockVault({
      "tabbed-secret": "col1\tcol2\tcol3",
    });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, tabbed-secret)",
    );
    assertEquals(result, '"col1\\tcol2\\tcol3"');
  });

  await t.step("should escape single quotes in secret values", async () => {
    const resolver = createResolverWithMockVault({
      "quote-secret": "p@ss'w0rd",
    });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, quote-secret)",
    );
    assertEquals(result, '"p@ss\\\'w0rd"');
  });

  await t.step("should escape backticks in secret values", async () => {
    const resolver = createResolverWithMockVault({
      "backtick-secret": "value`with`backticks",
    });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(test-vault, backtick-secret)",
    );
    assertEquals(result, '"value\\\\`with\\\\`backticks"');
  });

  await t.step(
    "should handle complex secret with multiple special characters",
    async () => {
      const resolver = createResolverWithMockVault({
        "complex-secret": 'line1\nkey="val\\ue"\ttab',
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, complex-secret)",
      );
      assertEquals(result, '"line1\\nkey=\\"val\\\\ue\\"\\ttab"');
    },
  );

  await t.step(
    "should return unchanged string with no vault expressions",
    async () => {
      const resolver = createResolverWithMockVault({});
      const input = "just a regular string with no vault calls";
      const result = await resolver.resolveVaultExpressions(input);
      assertEquals(result, input);
    },
  );

  await t.step("should handle whitespace in vault expression", async () => {
    const resolver = createResolverWithMockVault({ "api-key": "secret123" });
    const result = await resolver.resolveVaultExpressions(
      "vault.get(  test-vault  ,  api-key  )",
    );
    assertEquals(result, '"secret123"');
  });

  await t.step("should throw error for missing vault", async () => {
    const resolver = createResolverWithMockVault({});
    const error = await assertRejects(
      () => resolver.resolveVaultExpressions("vault.get(missing-vault, key)"),
      Error,
    );
    assertStringIncludes(error.message, "Failed to resolve vault expression");
    assertStringIncludes(error.message, "vault.get(missing-vault, key)");
  });

  await t.step("should throw error for missing secret key", async () => {
    const resolver = createResolverWithMockVault({ "existing-key": "value" });
    const error = await assertRejects(
      () =>
        resolver.resolveVaultExpressions("vault.get(test-vault, missing-key)"),
      Error,
    );
    assertStringIncludes(error.message, "Failed to resolve vault expression");
    assertStringIncludes(error.message, "vault.get(test-vault, missing-key)");
  });

  await t.step(
    "should escape $ in secret values to prevent shell variable expansion",
    async () => {
      const resolver = createResolverWithMockVault({
        "dollar-amp": "my$&secret",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, dollar-amp)",
      );
      assertEquals(result, '"my\\\\$&secret"');
    },
  );

  await t.step(
    "should escape $` pattern in secret values",
    async () => {
      const resolver = createResolverWithMockVault({
        "dollar-backtick": "prefix$`suffix",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, dollar-backtick)",
      );
      assertEquals(result, '"prefix\\\\$\\\\`suffix"');
    },
  );

  await t.step(
    "should escape $' pattern in secret values",
    async () => {
      const resolver = createResolverWithMockVault({
        "dollar-quote": "prefix$'suffix",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, dollar-quote)",
      );
      assertEquals(result, '"prefix\\\\$\\\'suffix"');
    },
  );

  await t.step(
    "should escape $$ pattern in secret values",
    async () => {
      const resolver = createResolverWithMockVault({
        "dollar-dollar": "cost: $$100",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, dollar-dollar)",
      );
      assertEquals(result, '"cost: \\\\$\\\\$100"');
    },
  );

  await t.step(
    "should escape numbered dollar patterns in secret values",
    async () => {
      const resolver = createResolverWithMockVault({
        "dollar-numbers": "$1$2$3",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, dollar-numbers)",
      );
      assertEquals(result, '"\\\\$1\\\\$2\\\\$3"');
    },
  );

  await t.step(
    "should escape multiple dollar and backtick patterns in same secret",
    async () => {
      const resolver = createResolverWithMockVault({
        "multi-dollar": "a]$&b$`c$'d$$e$1f",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, multi-dollar)",
      );
      assertEquals(
        result,
        '"a]\\\\$&b\\\\$\\\\`c\\\\$\\\'d\\\\$\\\\$e\\\\$1f"',
      );
    },
  );

  await t.step(
    "should escape $ to prevent shell command substitution",
    async () => {
      const resolver = createResolverWithMockVault({
        "cmd-secret": "$(echo injected)",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, cmd-secret)",
      );
      assertEquals(result, '"\\\\$(echo injected)"');
    },
  );

  await t.step(
    "should escape backticks to prevent shell command substitution",
    async () => {
      const resolver = createResolverWithMockVault({
        "backtick-cmd": "`echo injected`",
      });
      const result = await resolver.resolveVaultExpressions(
        "vault.get(test-vault, backtick-cmd)",
      );
      assertEquals(result, '"\\\\`echo injected\\\\`"');
    },
  );

  // Cleanup
  await Deno.remove(tempDir, { recursive: true });
});
