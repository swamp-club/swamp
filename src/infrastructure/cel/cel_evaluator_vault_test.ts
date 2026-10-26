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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  createVaultTestContext,
  type VaultTestContextOptions,
  type VaultTestContextResult,
} from "@swamp-club/swamp-testing";
import { UserError } from "../../domain/errors.ts";
import {
  InvalidExpressionError,
  SecretRefusedError,
  UnboundExpressionError,
} from "../../domain/expressions/errors.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../../domain/vaults/run_vault_access.ts";
import { CelEvaluator, type EvaluationScope } from "./cel_evaluator.ts";

interface Fixture {
  evaluator: CelEvaluator;
  bag: VaultSecretBag;
  scope: EvaluationScope;
  ctx: VaultTestContextResult;
  redacted: string[];
  evaluate(
    expression: string,
    context?: Record<string, unknown>,
  ): Promise<unknown>;
}

async function withVault(
  fn: (f: Fixture) => Promise<void>,
  options: VaultTestContextOptions = {},
): Promise<void> {
  const type = `@test/cel-vault-${crypto.randomUUID()}`;
  const ctx = createVaultTestContext({
    name: "prod",
    withExistence: true,
    secrets: { token: "private-canary-3625" },
    ...options,
  });
  vaultTypeRegistry.register({
    type,
    name: "CEL vault",
    description: "counting vault",
    isBuiltIn: false,
    createProvider: () => ctx.vault,
  });
  try {
    const service = new VaultService();
    service.registerVault({ name: "prod", type, config: {} });
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const redacted: string[] = [];
    const scope: EvaluationScope = {
      secretBag: bag,
      vault: {
        service,
        location: "inputs.cmd",
        redactor: { addSecret: (value) => redacted.push(value) },
      },
    };
    const evaluator = new CelEvaluator();
    await fn({
      evaluator,
      bag,
      scope,
      ctx,
      redacted,
      evaluate: (expression, context = {}) =>
        evaluator.evaluateAsync(expression, context, scope),
    });
  } finally {
    vaultTypeRegistry.invalidateType(type);
  }
}

Deno.test("CelEvaluator vault.get: returns a registered reference, never a value", async () => {
  await withVault(async (f) => {
    const result = await f.evaluate("vault.get(prod, token)");
    assert(typeof result === "string");
    const entry = f.bag.registry.entryOf(result);
    assert(entry && "reference" in entry);
    assertEquals(entry.reference, { vaultName: "prod", key: "token" });
    assertEquals("value" in entry, false);
    assert("location" in entry);
    assertEquals(entry.location, "inputs.cmd:1:1");
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
    assertEquals(f.ctx.getOperationsByMethod("has").length, 1);
    assertEquals(f.redacted, []);
  });
});

Deno.test("CelEvaluator vault.get: missing top-level selector bindings are unbound without probing the vault", async () => {
  await withVault(async (f) => {
    for (
      const [selector, unbound] of [
        ["inputs.key", true],
        ["env.KEY", true],
        ["inputs.cfg.key", false],
        ["other.key", false],
      ] as const
    ) {
      const expression = `vault.get('prod', ${selector})`;
      const error = await assertRejects(
        () =>
          f.evaluate(expression, { inputs: { cfg: {} }, env: {}, other: {} }),
        InvalidExpressionError,
      );
      assertEquals(error instanceof UnboundExpressionError, unbound, selector);
      assertEquals(error.expression, expression);
      assertEquals(error.cause, undefined);
    }
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
    assertEquals(f.ctx.getOperationsByMethod("has"), []);
  });
});

Deno.test("CelEvaluator vault.get: legacy quoted, bare and dynamic arguments retain their meaning", async () => {
  await withVault(async (f) => {
    for (
      const expression of [
        "vault.get('prod', 'token')",
        "vault.get(`prod`, token)",
        "vault.get(inputs.v, inputs.k)",
        "vault . get ( prod , token )",
      ]
    ) {
      const result = await f.evaluate(expression, {
        inputs: { v: "prod", k: "token" },
      });
      assert(typeof result === "string");
      const entry = f.bag.registry.entryOf(result);
      assert(entry && "reference" in entry);
      assertEquals(entry.reference.key, "token");
    }
    await f.ctx.vault.put(String.raw`a\nb`, "escape-canary");
    await f.evaluate(String.raw`vault.get('prod', 'a\nb')`);
    assertEquals(f.ctx.getOperationsByMethod("has").map((op) => op.key), [
      "token",
      String.raw`a\nb`,
    ]);
  });
});

Deno.test("CelEvaluator vault.get: every branch is checked before the outer expression runs", async () => {
  await withVault(async (f) => {
    let effects = 0;
    for (
      const expression of [
        "true ? 'ok' : vault.get(prod, missing)",
        "false && vault.get(prod, missing) != null",
        "true || vault.get(prod, missing) != null",
        "vault.get(prod, missing) == null",
        "model.method('m','run') + vault.get(prod, missing)",
      ]
    ) {
      const error = await assertRejects(
        () =>
          f.evaluate(expression, {
            modelMethod: {
              method: () => {
                effects++;
                return "ok";
              },
            },
          }),
        UserError,
      );
      assertEquals(error.code, "secret_reference_unavailable");
      assertStringIncludes(error.message, "inputs.cmd:1:");
      assertStringIncludes(error.message, "missing");
    }
    assertEquals(effects, 0);
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
    assertEquals(f.ctx.getOperationsByMethod("has").length, 5);
    assertEquals(f.bag.registry.isEmpty, true);
  });
});

Deno.test("CelEvaluator vault.get: argument failures and aliases cannot bypass checking", async () => {
  await withVault(async (f) => {
    for (
      const expression of [
        "true ? 'ok' : vault.get(prod, inputs.missing)",
        "true ? 'ok' : vault.get(prod, inputs.number)",
        "cel.bind(v, vault, v.get('prod','token'))",
        "dyn(vault).get('prod','token')",
        "[vault].map(m, m.get('prod','token'))",
        "vault",
        "vault.get(prod)",
        "[{'key': 'token'}].map(inputs, vault.get(prod, inputs.key))",
        "cel.bind(inputs, {'key': 'token'}, vault.get(prod, inputs.key))",
      ]
    ) {
      await assertRejects(
        () => f.evaluate(expression, { inputs: { number: 42, key: "token" } }),
        InvalidExpressionError,
      );
    }
    assertEquals(f.ctx.getOperations(), []);
  });
});

Deno.test("CelEvaluator vault.get: allowed operations and container/refusal rules include newly created secrets", async () => {
  await withVault(async (f) => {
    for (
      const expression of [
        "vault.get(prod,token) != null",
        "null != vault.get(prod,token)",
      ]
    ) assertEquals(await f.evaluate(expression), true);
    for (
      const expression of [
        "vault.get(prod,token) == null",
        "null == vault.get(prod,token)",
      ]
    ) assertEquals(await f.evaluate(expression), false);
    const joined = await f.evaluate(
      "'before-' + vault.get(prod,token) + '-after'",
    );
    assert(
      typeof joined === "string" && joined.startsWith("before-__SWAMP_VSEC_"),
    );
    for (
      const expression of [
        "size(vault.get(prod,token))",
        "size(vault.get(prod,token)) > 0 || true",
        "size(vault.get(prod,token)) > 0 && false",
        "[1].exists(x, size(vault.get(prod,token)) > 0) || true",
        "[1].all(x, size(vault.get(prod,token)) > 0) || true",
        "vault.get(prod,token) in []",
        "[vault.get(prod,token)] == []",
        "vault.get(prod,token) == vault.get(prod,token)",
      ]
    ) {
      const error = await assertRejects(
        () => f.evaluate(expression),
        SecretRefusedError,
      );
      assertEquals(error.code, "secret_operation_unsupported");
      assertEquals(error.cause, undefined);
      assertEquals(error.message.includes("private-canary-3625"), false);
    }
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
    assertEquals(await f.evaluate("1 + 1"), 2);
  });
});

Deno.test("CelEvaluator vault.get: refuses Secrets in either argument including nested calls", async () => {
  await withVault(async (f) => {
    const secret = f.bag.addSecret(
      { vaultName: "prod", key: "token" },
      "inputs.s",
    );
    for (
      const expression of [
        "vault.get(inputs.s, 'token')",
        "vault.get('prod', inputs.s)",
        "vault.get(inputs.s, inputs.s)",
        "true ? 'ok' : vault.get('prod', inputs.s)",
        "vault.get(vault.get(prod,token), token)",
        "vault.get(prod, vault.get(prod,token))",
      ]
    ) {
      await assertRejects(
        () => f.evaluate(expression, { inputs: { s: secret } }),
        SecretRefusedError,
      );
    }
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
  });
});

Deno.test("CelEvaluator vault.get: uses the checked argument once even when its getter changes", async () => {
  await withVault(async (f) => {
    let reads = 0;
    const inputs = {
      get key() {
        return ++reads === 1 ? "token" : "not-authorized";
      },
    };
    const result = await f.evaluate("vault.get(prod, inputs.key)", { inputs });
    assert(typeof result === "string");
    const entry = f.bag.registry.entryOf(result);
    assert(entry && "reference" in entry);
    assertEquals(entry.reference.key, "token");
    assertEquals(reads, 1);
    assertEquals(Object.keys(inputs), ["key"]);
  });
});

Deno.test("CelEvaluator vault.get: bindings include sentinels issued during context preparation", async () => {
  await withVault(async (f) => {
    const inputs = { key: "token" };
    await assertRejects(
      () =>
        f.evaluate("vault.get(prod, inputs.key)", {
          inputs,
          data: {
            prepare: () => {
              inputs.key = f.bag.addSecret(
                { vaultName: "prod", key: "token" },
                "test",
              );
              return Promise.resolve();
            },
          },
        }),
      SecretRefusedError,
    );
    assertEquals(f.ctx.getOperations(), []);
  });
});

Deno.test("CelEvaluator vault.get: grants are checked again after a cached positive result", async () => {
  await withVault(async (f) => {
    await f.evaluate("vault.get(prod,token)");
    const denied = RunVaultAccess.create({
      allowedVaults: [],
      allowListSource: "test",
    });
    await runWithVaultAccess(denied, async () => {
      const error = await assertRejects(
        () => f.evaluate("true ? 'ok' : vault.get(prod,token)"),
        UserError,
      );
      assertEquals(error.code, "vault_access_denied");
    });
    assertEquals(f.ctx.getOperationsByMethod("has").length, 1);
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
  });
});

Deno.test("CelEvaluator vault.get: synchronous and scopeless calls fail before provider access", async () => {
  await withVault(async (f) => {
    assertThrows(
      () => f.evaluator.evaluate("vault.get(prod,token)", {}, f.scope),
      InvalidExpressionError,
      "evaluateAsync",
    );
    await assertRejects(
      () => f.evaluator.evaluateAsync("vault.get(prod,token)", {}),
      InvalidExpressionError,
      "check scope",
    );
    assertEquals(f.evaluator.evaluate("1 + 2", {}, f.scope), 3);
    assertEquals(f.ctx.getOperations(), []);
  });
});

Deno.test("CelEvaluator vault.get: concurrent fallback checks probe once and do not populate the bag with values", async () => {
  await withVault(async (f) => {
    await Promise.all(
      Array.from(
        { length: 8 },
        () => f.evaluate("vault.get(prod,token) != null"),
      ),
    );
    assertEquals(f.ctx.getOperationsByMethod("get").length, 1);
    assertEquals(f.redacted, ["private-canary-3625"]);
    assertEquals(f.bag.registry.isEmpty, true);
  }, { withExistence: false });
});

Deno.test("CelEvaluator vault.get: provider failures preserve their contract and do not poison later evaluation", async () => {
  for (const withExistence of [true, false]) {
    await withVault(async (f) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await assertRejects(
          () => f.evaluate("vault.get(prod, token)"),
          Error,
          "Access denied to secret 'token'",
        );
        assertEquals(error instanceof InvalidExpressionError, false);
        assertStringIncludes(error.message, "inputs.cmd:1:1");
      }
      assertEquals(
        f.ctx.getOperationsByMethod(withExistence ? "has" : "get").length,
        2,
      );
      assertEquals(f.bag.registry.isEmpty, true);
      assertEquals(await f.evaluate("2 + 3"), 5);
    }, { withExistence, unauthorizedKeys: ["token"] });
  }
});

Deno.test("CelEvaluator vault.get: effectful arguments are rejected before checks or effects in any branch", async () => {
  await withVault(async (f) => {
    let effects = 0;
    const context = {
      modelMethod: {
        method: () => {
          effects++;
          return { key: "token" };
        },
      },
    };
    for (
      const expression of [
        "false && vault.get(prod, model.method('m','run',{}).key) != null",
        "vault.get(prod, model.method('m','run',{}).key)",
        "vault.get(prod, cel.bind(m, model, m.method('m','run',{}).key))",
        "[vault.get(prod,token), vault.get(prod, model.method('m','run',{}).key)]",
      ]
    ) {
      await assertRejects(
        () => f.evaluate(expression, context),
        InvalidExpressionError,
        "cannot invoke model.method",
      );
      assertEquals(f.evaluator.validate(expression).valid, false);
    }
    assertEquals(effects, 0);
    assertEquals(f.ctx.getOperations(), []);
  });
});

Deno.test("CelEvaluator vault.get: a ternary with a vault.get branch beside a string keeps its meaning, whichever branch is taken, and its result still refuses misuse", async () => {
  await withVault(async (f) => {
    const taken = await f.evaluate(
      "inputs.flag ? vault.get('prod', 'token') : 'none'",
      { inputs: { flag: true } },
    );
    assertEquals(
      f.bag.registry.issuedEntryOf(taken as string)?.reference,
      { vaultName: "prod", key: "token" },
    );
    assertEquals(
      await f.evaluate("inputs.flag ? vault.get('prod', 'token') : 'none'", {
        inputs: { flag: false },
      }),
      "none",
    );
    assertEquals(
      await f.evaluate("false ? vault.get('prod', 'token') + '-x' : 'none'"),
      "none",
    );
    const error = await assertRejects(
      () => f.evaluate("(true ? vault.get('prod', 'token') : 'none') == 'x'"),
      SecretRefusedError,
    );
    assertEquals(error.operation, "Secret == string");
  });
});

Deno.test("CelEvaluator: plain and env expressions do not initialize the vault scope", async () => {
  const evaluator = new CelEvaluator();
  let scopes = 0;
  const scope: EvaluationScope = {
    secretBag: new VaultSecretBag(new SecretBagRegistry()),
    getVault: () => {
      scopes++;
      return Promise.reject(new Error("unavailable vault configuration"));
    },
  };
  const context = { inputs: { x: 2 }, env: { VALUE: "plain" } };
  const prepared = await evaluator.prepareSynchronousReads(
    { value: "${{ env.VALUE }}" },
    context,
    scope,
  );
  assertEquals(evaluator.evaluate("inputs.x + 1", context, prepared), 3);
  assertEquals(
    await evaluator.evaluateAsync("env.VALUE", context, scope),
    "plain",
  );
  assertEquals(scopes, 0);
  await assertRejects(
    () => evaluator.evaluateAsync("vault.get(v, k)", context, scope),
    Error,
    "unavailable vault configuration",
  );
  assertEquals(scopes, 1);
});

Deno.test("CelEvaluator: default compatibility corpus preserves plain expressions and refuses secret observations", async () => {
  await withVault(async (f) => {
    const secret = "vault.get(prod, token)";
    const cases: readonly {
      expression: string;
      plain: string;
      expected: unknown;
      code?: string;
    }[] = [
      {
        expression: `${secret} == 'x'`,
        plain: "'x' == 'x'",
        expected: true,
        code: "secret_operation_unsupported",
      },
      {
        expression: `size(${secret})`,
        plain: "size('abc')",
        expected: 3,
        code: "secret_operation_unsupported",
      },
      {
        expression: `int(${secret})`,
        plain: "int('42')",
        expected: 42,
        code: "secret_operation_unsupported",
      },
      {
        expression: `string(${secret})`,
        plain: "string(42)",
        expected: "42",
        code: "secret_operation_unsupported",
      },
      {
        expression: `${secret}.contains('x')`,
        plain: "'abc'.contains('b')",
        expected: true,
        code: "secret_operation_unsupported",
      },
      {
        expression: `${secret} in ['x']`,
        plain: "'x' in ['x']",
        expected: true,
        code: "secret_operation_unsupported",
      },
      {
        expression: `${secret} != null && [1] == [1]`,
        plain: "true && [1] == [1]",
        expected: true,
        code: "secret_operation_unsupported",
      },
    ];
    for (const row of cases) {
      assertEquals(await f.evaluate(row.plain), row.expected, row.plain);
      if (row.code) {
        const error = await assertRejects(
          () => f.evaluate(row.expression),
          SecretRefusedError,
        );
        assertEquals(error.code, row.code, row.expression);
      } else {
        assertEquals(
          await f.evaluate(row.expression),
          row.expected,
          row.expression,
        );
      }
    }
    // type() observes the registered type name, not the value (Section 4.3).
    await f.evaluate(`type(${secret})`);
    assertEquals(await f.evaluate(`${secret} == null`), false);
    assertEquals(await f.evaluate(`${secret} != null`), true);
    for (
      const expression of [
        secret,
        "vault.get('prod', 'token')",
        `'prefix-' + ${secret}`,
      ]
    ) {
      const result = await f.evaluate(expression) as string;
      assertEquals(result.includes("private-canary-3625"), false);
      assertStringIncludes(result, "__SWAMP_VSEC_");
    }
    assertEquals(f.ctx.getOperationsByMethod("get"), []);
    assertEquals(f.ctx.getOperationsByMethod("has").length, 1);
  });
});
