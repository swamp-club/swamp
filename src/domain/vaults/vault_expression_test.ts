// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { UserError } from "../errors.ts";
import { SecretBagRegistry } from "./secret_bag_registry.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";
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
        "Available vault types:",
      );
      assertStringIncludes(
        error.message,
        "swamp extension pull",
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

  // Helper to create a ModelResolver with multiple named vaults
  function createResolverWithNamedVaults(
    vaults: Record<string, Record<string, string>>,
  ): ModelResolver {
    const vaultService = new VaultService();
    for (const [name, secrets] of Object.entries(vaults)) {
      vaultService.registerVault({ name, type: "mock", config: secrets });
    }
    const definitionRepo = new YamlDefinitionRepository(tempDir);
    return new ModelResolver(definitionRepo, { vaultService });
  }

  /**
   * Rewrites `expression` with a fresh bag, then loads it as a delivery
   * does: `cel` is the rewritten CEL, `sentinels` the sentinels it holds and
   * `delivered` the value each one delivers.
   */
  async function resolveAndLoad(resolver: ModelResolver, expression: string) {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const cel = await resolver.resolveVaultExpressions(expression, bag, {
      location: "methods.run.arguments.cmd",
    });
    const sentinels = cel.match(VaultSecretBag.SENTINEL_PATTERN) ?? [];
    const loaded = await resolver.secretLoader().load(bag, cel);
    return {
      cel,
      sentinels,
      delivered: sentinels.map((s) => loaded.resolveRaw(s)),
    };
  }

  /** Each quoting of the vault and key resolves the same reference. */
  for (
    const expression of [
      "vault.get(test-vault, api-key)",
      "vault.get('test-vault', 'api-key')",
      'vault.get("test-vault", "api-key")',
      "vault.get(`test-vault`, `api-key`)",
      "vault.get(  test-vault  ,  api-key  )",
    ]
  ) {
    await t.step(`replaces ${expression} with a sentinel`, async () => {
      const resolver = createResolverWithMockVault({ "api-key": "secret123" });
      const { cel, sentinels, delivered } = await resolveAndLoad(
        resolver,
        expression,
      );
      assertEquals(sentinels.length, 1);
      assertEquals(cel, `"${sentinels[0]}"`);
      assertEquals(delivered, ["secret123"]);
    });
  }

  await t.step("should resolve multiple vault expressions", async () => {
    const resolver = createResolverWithMockVault({
      "key1": "value1",
      "key2": "value2",
    });
    const { cel, sentinels, delivered } = await resolveAndLoad(
      resolver,
      'vault.get(test-vault, key1) + "-" + vault.get(test-vault, key2)',
    );
    assertEquals(cel, `"${sentinels[0]}" + "-" + "${sentinels[1]}"`);
    assertEquals(delivered, ["value1", "value2"]);
  });

  // No value enters the CEL text, so no character of it needs escaping
  // there; the load delivers it exactly. Shell safety is handled by the
  // shell model via VaultSecretBag.resolveForShell().
  for (
    const value of [
      '{"key": "value"}',
      "C:\\Users\\test",
      "line1\nline2\r\nline3",
      "col1\tcol2\tcol3",
      "p@ss'w0rd",
      "value`with`backticks",
      'line1\nkey="val\\ue"\ttab',
      "my$&secret",
      "prefix$`suffix",
      "prefix$'suffix",
      "cost: $$100",
      "$1$2$3",
      "a]$&b$`c$'d$$e$1f",
      "$(echo injected)",
      "`echo injected`",
    ]
  ) {
    await t.step(
      `delivers ${JSON.stringify(value)} exactly, outside the CEL text`,
      async () => {
        const resolver = createResolverWithMockVault({ "special": value });
        const { cel, sentinels, delivered } = await resolveAndLoad(
          resolver,
          "vault.get(test-vault, special)",
        );
        assertEquals(cel, `"${sentinels[0]}"`);
        assertEquals(delivered, [value]);
      },
    );
  }

  await t.step(
    "should return unchanged string with no vault expressions",
    async () => {
      const resolver = createResolverWithMockVault({});
      const input = "just a regular string with no vault calls";
      const result = await resolver.resolveVaultExpressions(
        input,
        new VaultSecretBag(new SecretBagRegistry()),
        { location: "test" },
      );
      assertEquals(result, input);
    },
  );

  await t.step("should throw error for missing vault", async () => {
    const resolver = createResolverWithMockVault({});
    const error = await assertRejects(
      () => resolveAndLoad(resolver, "vault.get(missing-vault, key)"),
      Error,
    );
    assertStringIncludes(error.message, "Failed to resolve vault expression");
    assertStringIncludes(error.message, "vault.get(missing-vault, key)");
    assertStringIncludes(error.message, "Vault 'missing-vault' not found");
  });

  await t.step(
    "resolveVaultExpressions: flattens multi-line vault errors into single line",
    async () => {
      const resolver = createResolverWithMockVault({});
      const error = await assertRejects(
        () => resolveAndLoad(resolver, "vault.get(missing-vault, key)"),
        Error,
      );
      assertEquals(error.message.includes("\n"), false);
      assertStringIncludes(error.message, " — ");
    },
  );

  await t.step("should throw error for missing secret key", async () => {
    const resolver = createResolverWithMockVault({ "existing-key": "value" });
    const error = await assertRejects(
      () => resolveAndLoad(resolver, "vault.get(test-vault, missing-key)"),
      UserError,
    );
    assertStringIncludes(error.message, "Failed to resolve vault expression");
    assertStringIncludes(error.message, "vault.get(test-vault, missing-key)");
    assertStringIncludes(
      error.message,
      "vault.get(test-vault, missing-key) (at methods.run.arguments.cmd): Secret 'missing-key' not found in vault 'test-vault'",
    );
    assertEquals(error.code, "secret_reference_unavailable");
  });

  // ========================================================================
  // Spaces in quoted vault names and secret keys (#902)
  // ========================================================================

  await t.step(
    "should resolve vault expression with spaces in double-quoted key",
    async () => {
      const resolver = createResolverWithMockVault({
        "Client ID": "my-client-id",
      });
      const { delivered } = await resolveAndLoad(
        resolver,
        'vault.get("test-vault", "Client ID")',
      );
      assertEquals(delivered, ["my-client-id"]);
    },
  );

  await t.step(
    "should resolve vault expression with spaces in single-quoted key",
    async () => {
      const resolver = createResolverWithMockVault({
        "Client Secret": "super-secret",
      });
      const { delivered } = await resolveAndLoad(
        resolver,
        "vault.get('test-vault', 'Client Secret')",
      );
      assertEquals(delivered, ["super-secret"]);
    },
  );

  await t.step(
    "should resolve vault expression with 1Password-style path containing spaces",
    async () => {
      const resolver = createResolverWithMockVault({
        "Tailscale K8s Operator/Client ID": "ts-client-id-123",
      });
      const { delivered } = await resolveAndLoad(
        resolver,
        'vault.get("test-vault", "Tailscale K8s Operator/Client ID")',
      );
      assertEquals(delivered, ["ts-client-id-123"]);
    },
  );

  await t.step(
    "should resolve vault expression with spaces in quoted vault name",
    async () => {
      const resolver = createResolverWithNamedVaults({
        "my infra vault": { "api-key": "infra-key-456" },
      });
      const { delivered } = await resolveAndLoad(
        resolver,
        'vault.get("my infra vault", "api-key")',
      );
      assertEquals(delivered, ["infra-key-456"]);
    },
  );

  await t.step(
    "should resolve vault expression with spaces in both vault name and key",
    async () => {
      const resolver = createResolverWithNamedVaults({
        "my infra vault": { "Client Secret": "both-spaces-val" },
      });
      const { delivered } = await resolveAndLoad(
        resolver,
        'vault.get("my infra vault", "Client Secret")',
      );
      assertEquals(delivered, ["both-spaces-val"]);
    },
  );

  await t.step(
    "should resolve mixed quoted vault name with unquoted key",
    async () => {
      const resolver = createResolverWithNamedVaults({
        "my infra vault": { "api-key": "mixed-val" },
      });
      const { delivered } = await resolveAndLoad(
        resolver,
        'vault.get("my infra vault", api-key)',
      );
      assertEquals(delivered, ["mixed-val"]);
    },
  );

  // Cleanup
  await Deno.remove(tempDir, { recursive: true });
});
