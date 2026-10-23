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

/** The typed CEL/check/registry/delivery contract, with real counting providers. */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createVaultTestContext,
  type VaultTestContextResult,
} from "@swamp-club/swamp-testing";
import { UserError } from "../src/domain/errors.ts";
import { SecretRefusedError } from "../src/domain/expressions/errors.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import {
  CelEvaluator,
  type EvaluationScope,
} from "../src/infrastructure/cel/cel_evaluator.ts";
import { generateCanaries } from "./canary_values.ts";

async function withProvider(
  withExistence: boolean,
  fn: (
    service: VaultService,
    provider: VaultTestContextResult,
  ) => Promise<void>,
): Promise<void> {
  const provider = createVaultTestContext({ name: "prod", withExistence });
  const type = `@test/typed-vault-integration-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type,
    name: "Typed vault integration",
    description: "counting provider",
    isBuiltIn: false,
    createProvider: () => provider.vault,
  });
  try {
    const service = new VaultService();
    service.registerVault({ name: "prod", type, config: {} });
    await fn(service, provider);
  } finally {
    vaultTypeRegistry.invalidateType(type);
  }
}

function run(service: VaultService) {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const redactor = new SecretRedactor();
  const scope: EvaluationScope = {
    secretBag: bag,
    vault: { service, redactor, location: "methods.run.arguments.token" },
  };
  const evaluator = new CelEvaluator();
  return {
    registry,
    bag,
    redactor,
    scope,
    evaluator,
    loader: new SecretLoader(() => Promise.resolve(service), redactor),
  };
}

for (const withExistence of [true, false]) {
  const path = withExistence ? "has" : "probe";
  Deno.test(`typed vault delivery (${path}): every canary is held as a reference then delivered exactly and freshly`, async () => {
    await withProvider(withExistence, async (service, provider) => {
      for (const canary of generateCanaries()) {
        const { evaluator, scope, bag, registry, redactor, loader } = run(
          service,
        );
        const beforeGets = provider.getOperationsByMethod("get").length;
        const beforeHas = provider.getOperationsByMethod("has").length;
        const old = "probe-value-" + crypto.randomUUID();
        await provider.vault.put("token", old);
        const sentinel = await evaluator.evaluateAsync(
          "vault.get(prod, token)",
          {},
          scope,
        );
        assert(typeof sentinel === "string");
        assertEquals(
          provider.getOperationsByMethod("get").length - beforeGets,
          withExistence ? 0 : 1,
        );
        assertEquals(
          provider.getOperationsByMethod("has").length - beforeHas,
          withExistence ? 1 : 0,
        );
        assertEquals(bag.rawValues, []);
        for (const entry of registry.all()) {
          assertEquals("value" in entry, false);
        }
        if (!withExistence) assertEquals(redactor.redact(old), "***");

        // Rotate after the check. A probe's value must not become delivery data.
        await provider.vault.put("token", canary.value);
        const loaded = await loader.load(bag, {
          token: sentinel,
          again: sentinel,
        });
        assertEquals(loaded.resolveDeep({ token: sentinel, again: sentinel }), {
          token: canary.value,
          again: canary.value,
        }, canary.class);
        assertEquals(
          provider.getOperationsByMethod("get").length - beforeGets,
          withExistence ? 1 : 2,
        );
        assertEquals(bag.rawValues, []);
        // A repeat check uses the existence memo, never the earlier loaded view.
        assertEquals(
          await evaluator.evaluateAsync(
            "vault.get(prod, token) != null",
            {},
            scope,
          ),
          true,
        );
        assertEquals(
          provider.getOperationsByMethod("get").length - beforeGets,
          withExistence ? 1 : 2,
        );
        assertEquals(
          provider.getOperationsByMethod("has").length - beforeHas,
          withExistence ? 1 : 0,
        );
      }
    });
  });

  Deno.test(`typed vault refusal (${path}): probes are separate from loads and errors carry no canary`, async () => {
    await withProvider(withExistence, async (service, provider) => {
      for (
        const canary of generateCanaries().filter((canary) => canary.unique)
      ) {
        const { evaluator, scope, bag, registry, redactor } = run(service);
        await provider.vault.put("token", canary.value);
        const before = provider.getOperationsByMethod("get").length;
        const error = await assertRejects(() =>
          evaluator.evaluateAsync(
            "inputs.other.contains(vault.get(prod, token)) || true",
            { inputs: { other: canary.value } },
            scope,
          ), SecretRefusedError);
        const shown = [
          error.message,
          error.stack,
          Deno.inspect(error),
          JSON.stringify(error),
        ].join("\n");
        for (
          const value of [
            canary.value,
            JSON.stringify(canary.value).slice(1, -1),
            encodeURIComponent(canary.value),
          ]
        ) {
          assertEquals(shown.includes(value), false, canary.class);
        }
        assertEquals(error.cause, undefined);
        assertEquals(
          provider.getOperationsByMethod("get").length - before,
          withExistence ? 0 : 1,
        );
        assertEquals(registry.isEmpty, true);
        assertEquals(bag.rawValues, []);
        if (!withExistence) assertEquals(redactor.redact(canary.value), "***");
      }
    });
  });

  Deno.test(`typed vault checks (${path}): failed checks are retried and concurrent successes share a probe`, async () => {
    await withProvider(withExistence, async (service, provider) => {
      const { evaluator, scope } = run(service);
      const check = () =>
        evaluator.evaluateAsync(
          "false && vault.get(prod, token) != null",
          {},
          scope,
        );
      await assertRejects(check);
      await assertRejects(check);
      await provider.vault.put("token", "available-now");
      assertEquals(
        await Promise.all(Array.from({ length: 8 }, check)),
        Array(8).fill(false),
      );
      assertEquals(
        provider.getOperationsByMethod(withExistence ? "has" : "get").length,
        3,
      );
    });
  });
}

Deno.test("typed vault errors: authored locations survive leading text and model-name rewriting", async () => {
  await withProvider(true, async (service) => {
    const { evaluator, scope } = run(service);
    const error = await assertRejects(
      () =>
        evaluator.evaluateAsync(
          "model.my-app.definition.x +\n  vault.get(prod, MISSING)",
          {},
          scope,
        ),
      UserError,
    );
    assertEquals(error.code, "secret_reference_unavailable");
    assertStringIncludes(error.message, "methods.run.arguments.token:2:3");
    assertStringIncludes(error.message, "vault.get(prod, MISSING)");
  });
});
