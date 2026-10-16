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

// Phase 1.2 pins for the refusing overload set (design/enablers/
// typed-secrets.md Section 4.3 item 1, and the Phase 1.2 list in Section 11:
// "The refusing overload set covers every built-in and every swamp
// registration a `Secret` can reach, including `==` between two secrets, as
// the full cross product over each signature's refusal positions. The `==`
// overloads name every type cel-js accepts in a signature and answer a
// comparison with `null` in both operand orders. Adding `Secret == Secret`
// beside `Secret == dyn` does not remove the overlap, so the enumerated set is
// the only shape. `in` and `type(S)` have no registrable refusal." and
// "Synchronous entry points still return synchronous results with the
// `Secret` registrations in place, although every operator use is marked
// maybe-async.").
//
// Three observations shaped the inventory: `in` overloads overlap the
// built-in at evaluation, `type(Secret)` is registered by cel-js itself and
// cannot be replaced, and one refusal per parameter position leaves a call
// with two secrets to a missing-overload error that records no fault, which
// is why the inventory generates the full cross product.
import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Environment, EvaluationError } from "cel-js";
import {
  CelDataNamespace,
  CelFileNamespace,
  CelModelNamespace,
  CelWorkersNamespace,
} from "../cel_evaluator.ts";
import {
  assertCelError,
  assertPlainError,
  pin,
  readMaybeAsync,
} from "./cel_js_pin_test_helpers.ts";
import {
  createSecret,
  type RefusalRegistration,
  refuse,
  registerAllowedSet,
  registerSecretRefusals,
  registerSecretType,
  secretEnvironmentOptions,
  SecretRefusedError,
  withFaultContext,
} from "./cel_js_secret_fixture.ts";
import {
  functionRefusalSignatures,
  operatorRefusalSignatures,
  secretCapableBuiltins,
  SWAMP_FUNCTION_SIGNATURES,
  SWAMP_NAMESPACE_TYPES,
} from "./cel_js_secret_refusal_inventory.ts";

const s = createSecret("v/k");
const t = createSecret("v/k2");
const namespaces = {
  data: new CelDataNamespace({}),
  file: new CelFileNamespace({}),
  model: new CelModelNamespace({}),
  workers: new CelWorkersNamespace({}),
};

function secretEnvironment(): Environment {
  return registerSecretType(new Environment(secretEnvironmentOptions()));
}

/**
 * The internal environment's shape: the Secret type, swamp's namespace
 * types, stubs for swamp's own registrations (the `inputs` delivery returns
 * what it was given), the allowed set, then every refusal.
 */
function internalEnvironment(): {
  env: Environment;
  registration: RefusalRegistration;
} {
  const env = secretEnvironment()
    .registerType("CelFileNamespace", CelFileNamespace)
    .registerType("CelDataNamespace", CelDataNamespace)
    .registerType("CelWorkersNamespace", CelWorkersNamespace)
    .registerType("CelModelNamespace", CelModelNamespace);
  for (const signature of SWAMP_FUNCTION_SIGNATURES) {
    const handler = signature.endsWith("dyn): dyn")
      ? (...args: unknown[]) => args[args.length - 1]
      : () => null;
    env.registerFunction(signature, handler, { async: false });
  }
  registerAllowedSet(env);
  const registration = registerSecretRefusals(env, {
    customTypes: SWAMP_NAMESPACE_TYPES,
    swamp: true,
  });
  return { env, registration };
}

function assertRefused(
  env: Environment,
  expression: string,
  operation: string,
  context: Record<string, unknown> = { s, t, ...namespaces },
): void {
  withFaultContext((faults) => {
    const error = assertThrows(
      () => env.evaluate(expression, context),
      SecretRefusedError,
      `Secret refuses ${operation}`,
      expression,
    );
    assertEquals(error.operation, operation, expression);
    assertEquals(faults, [{ operation }], expression);
  });
}

Deno.test(
  pin(
    "the whole inventory registers beside swamp's own signatures without an overlap, and its size is pinned",
  ),
  () => {
    // The counts are pins on cel-js 7.6.1 plus the inventory's swamp lists.
    // When one changes, run this test: the failure prints the new number, and
    // the change is a decision to record, not a number to copy.
    const plain = secretEnvironment();
    assertEquals(plain.getDefinitions().functions.length, 108);
    const builtins = secretCapableBuiltins(plain).map((fn) => fn.signature);
    assertEquals(builtins.length, 49);
    assertEquals(functionRefusalSignatures(builtins).length, 56);
    assertEquals(
      functionRefusalSignatures(SWAMP_FUNCTION_SIGNATURES).length,
      41,
    );
    assertEquals(operatorRefusalSignatures().length, 163);
    assertEquals(operatorRefusalSignatures(SWAMP_NAMESPACE_TYPES).length, 167);

    const { registration } = internalEnvironment();
    assertEquals(registration.operators.length, 167);
    assertEquals(registration.functions.length, 97);
  },
);

Deno.test(
  pin(
    "each Secret == T refuses in both operand orders and through the derived !=",
  ),
  () => {
    const { env } = internalEnvironment();
    const values: Array<[string, string]> = [
      ["string", "'x'"],
      ["bool", "true"],
      ["int", "1"],
      ["uint", "1u"],
      ["double", "1.5"],
      ["bytes", "b'x'"],
      ["type", "type(1)"],
      ["list", "[1]"],
      ["map", "{'a': 1}"],
      ["optional", "optional.of(1)"],
      ["Secret", "t"],
      ["CelDataNamespace", "data"],
    ];
    for (const [type, value] of values) {
      const operation = `Secret == ${type}`;
      assertRefused(env, `s == ${value}`, operation);
      assertRefused(env, `${value} == s`, operation);
      assertRefused(env, `s != ${value}`, operation);
      assertRefused(env, `${value} != s`, operation);
    }
    assertRefused(env, "s == s", "Secret == Secret");
    assertRefused(env, "s == dyn('x')", "Secret == string");
    assertRefused(env, "dyn(s) == 'x'", "Secret == string");
  },
);

Deno.test(
  pin("Secret == null answers false in both operand orders, and != true"),
  () => {
    const { env } = internalEnvironment();
    withFaultContext((faults) => {
      assertEquals(env.evaluate("s == null", { s }), false);
      assertEquals(env.evaluate("null == s", { s }), false);
      assertEquals(env.evaluate("s != null", { s }), true);
      assertEquals(env.evaluate("null != s", { s }), true);
      assertEquals(faults, []);
    });
  },
);

Deno.test(
  pin(
    "Secret == dyn beside the enumerated set registers, then overlaps at s == s",
  ),
  () => {
    const env = registerAllowedSet(secretEnvironment());
    for (const signature of operatorRefusalSignatures()) {
      env.registerOperator(signature, () => refuse(signature));
    }
    env.registerOperator("Secret == dyn", () => false);
    assertPlainError(
      () => env.evaluate("s == s", { s }),
      "Operator overload 'Secret == Secret: bool' overlaps with 'dyn == Secret: bool'.",
    );
  },
);

Deno.test(
  pin("Secret in list and Secret in map overlap the built-in at evaluation"),
  () => {
    const env = secretEnvironment()
      .registerOperator("Secret in list", () => refuse("Secret in list"))
      .registerOperator("Secret in map", () => refuse("Secret in map"));
    withFaultContext((faults) => {
      assertPlainError(
        () => env.evaluate("s in [1]", { s }),
        "Operator overload 'V in list<V>: bool' overlaps with 'Secret in list<dyn>: bool'.",
      );
      assertPlainError(
        () => env.evaluate("s in {'a': 1}", { s }),
        "Operator overload 'K in map<K, V>: bool' overlaps with 'Secret in map<dyn, dyn>: bool'.",
      );
      assertEquals(faults, []);
    });
    // Without the overload, list membership answers by identity with no
    // fault, and map membership refuses through the key coercion trap.
    const { env: internal } = internalEnvironment();
    withFaultContext((faults) => {
      assertEquals(internal.evaluate("s in [1]", { s }), false);
      assertEquals(internal.evaluate("s in [s]", { s }), true);
      assertEquals(faults, []);
    });
    assertRefused(internal, "s in {'a': 1}", "Symbol(Symbol.toPrimitive)");
  },
);

Deno.test(
  pin("type(Secret) is registered by cel-js itself and cannot be replaced"),
  () => {
    const env = secretEnvironment();
    assertPlainError(
      () => env.registerFunction("type(Secret): type", () => null),
      "Function signature 'type(Secret): type' overlaps with existing overload 'type(Secret): type'.",
    );
    const { env: internal } = internalEnvironment();
    withFaultContext((faults) => {
      assertEquals(String(internal.evaluate("type(s)", { s })), "Type<Secret>");
      assertEquals(faults, []);
    });
  },
);

Deno.test(
  pin(
    "one refusal per position leaves a call with two secrets unrefused; the cross product closes it",
  ),
  () => {
    const partial = secretEnvironment()
      .registerType("CelDataNamespace", CelDataNamespace)
      .registerFunction(
        "CelDataNamespace.latest(string, string): dyn",
        () => null,
        {
          async: false,
        },
      )
      .registerFunction(
        "CelDataNamespace.latest(Secret, string): dyn",
        () => refuse("latest(Secret, string)"),
        { async: false },
      )
      .registerFunction(
        "CelDataNamespace.latest(string, Secret): dyn",
        () => refuse("latest(string, Secret)"),
        { async: false },
      );
    const context = { s, data: namespaces.data };
    withFaultContext((faults) => {
      assertCelError(
        () => partial.evaluate("data.latest(s, s)", context),
        EvaluationError,
        "no_matching_overload",
      );
      assertEquals(
        partial.evaluate("data.latest(s, s) == 'x' || true", context),
        true,
      );
      assertEquals(faults, []);
    });
    assertRefused(
      partial,
      "data.latest(s, 'b')",
      "latest(Secret, string)",
      context,
    );

    partial.registerFunction(
      "CelDataNamespace.latest(Secret, Secret): dyn",
      () => refuse("latest(Secret, Secret)"),
      { async: false },
    );
    assertRefused(
      partial,
      "data.latest(s, s)",
      "latest(Secret, Secret)",
      context,
    );
    withFaultContext((faults) => {
      assertEquals(
        partial.evaluate("data.latest(s, s) == 'x' || true", context),
        true,
      );
      assertEquals(faults, [{ operation: "latest(Secret, Secret)" }]);
    });
  },
);

Deno.test(
  pin("the conversion, string, time and swamp refusals fire with a fault"),
  () => {
    const { env } = internalEnvironment();
    const cases: Array<[string, string]> = [
      ["size(s)", "size(Secret): int"],
      ["string(s)", "string(Secret): string"],
      ["int(s)", "int(Secret): int"],
      ["uint(s)", "uint(Secret): uint"],
      ["double(s)", "double(Secret): double"],
      ["bool(s)", "bool(Secret): bool"],
      ["bytes(s)", "bytes(Secret): bytes"],
      ["timestamp(s)", "timestamp(Secret): google.protobuf.Timestamp"],
      ["duration(s)", "duration(Secret): google.protobuf.Duration"],
      ["s.matches('x')", "Secret.matches(string): bool"],
      ["'x'.matches(s)", "string.matches(Secret): bool"],
      ["s.size()", "Secret.size(): int"],
      ["s.contains(s)", "Secret.contains(Secret): bool"],
      ["'abc'.indexOf(s, 1)", "string.indexOf(Secret, int): int"],
      ["s.substring(1)", "Secret.substring(int): string"],
      ["s.split(s)", "Secret.split(Secret): list<string>"],
      ["['a'].join(s)", "list<string>.join(Secret): string"],
      ["s.lowerAscii()", "Secret.lowerAscii(): string"],
      [
        "timestamp('2020-01-01T00:00:00Z').getDate(s)",
        "google.protobuf.Timestamp.getDate(Secret): int",
      ],
      ["data.latest(s, 'b')", "CelDataNamespace.latest(Secret, string): dyn"],
      ["data.latest('a', s)", "CelDataNamespace.latest(string, Secret): dyn"],
      ["data.latest(s, s)", "CelDataNamespace.latest(Secret, Secret): dyn"],
      [
        "data.version(s, 'b', [1], 1)",
        "CelDataNamespace.version(Secret, string, list<dyn>, int): dyn",
      ],
      ["data.query(s)", "CelDataNamespace.query(Secret): dyn"],
      [
        "data.findByTag('k', s)",
        "CelDataNamespace.findByTag(string, Secret): dyn",
      ],
      [
        "model.method(s, 'm', {})",
        "CelModelNamespace.method(Secret, string, dyn): dyn",
      ],
      [
        "model.method('m', s, {})",
        "CelModelNamespace.method(string, Secret, dyn): dyn",
      ],
      [
        "file.contents(s, 'x')",
        "CelFileNamespace.contents(Secret, string): dyn",
      ],
      ["literal(s)", "literal(Secret): string"],
      ["latestRun(s)", "latestRun(Secret): dyn"],
      ["model(s)", "model(Secret): bool"],
      ["behavior(s)", "behavior(Secret): bool"],
    ];
    for (const [expression, operation] of cases) {
      assertRefused(env, expression, operation);
    }
  },
);

Deno.test(
  pin("every operator in the table refuses a Secret operand with a fault"),
  () => {
    const { env } = internalEnvironment();
    const cases: Array<[string, string]> = [
      ["s - 1", "Secret - int"],
      ["1 - s", "int - Secret"],
      ["s + 1", "Secret + int"],
      ["[1] + s", "list + Secret"],
      ["s * 2.5", "Secret * double"],
      ["s / 1u", "Secret / uint"],
      ["s % 2", "Secret % int"],
      ["s < 'x'", "Secret < string"],
      ["'x' > s", "string > Secret"],
      ["s <= s", "Secret <= Secret"],
      ["s >= b'x'", "Secret >= bytes"],
      ["-s", "-Secret"],
      ["!s", "!Secret"],
    ];
    for (const [expression, operation] of cases) {
      assertRefused(env, expression, operation);
    }
  },
);

Deno.test(
  pin(
    "the allowed set composes, and the named deliveries and containers pass a Secret through",
  ),
  () => {
    const { env } = internalEnvironment();
    withFaultContext((faults) => {
      const composed = env.evaluate("'a' + s + t + 'b'", { s, t });
      assertEquals(
        (composed as { parts?: unknown }).parts,
        undefined,
        "the composition is a Secret, not a record",
      );
      assertEquals(
        String(env.evaluate("type('a' + s)", { s })),
        "Type<Secret>",
      );
      assertStrictEquals(env.evaluate("dyn(s)", { s }), s);
      assertStrictEquals(env.evaluate("cel.bind(v, s, v)", { s }), s);
      assertStrictEquals(
        (env.evaluate("model.method('m', 'n', {'p': s})", {
          s,
          ...namespaces,
        }) as {
          p: unknown;
        }).p,
        s,
      );
      assertStrictEquals(
        (env.evaluate("[s].map(x, x)", { s }) as unknown[])[0],
        s,
      );
      assertStrictEquals(env.evaluate("[s][0]", { s }), s);
      assertStrictEquals(env.evaluate("{'a': s}.a", { s }), s);
      assertEquals(env.evaluate("size([s])", { s }), 1n);
      assertEquals(env.evaluate("[s].size()", { s }), 1n);
      assertEquals(String(env.evaluate("type([s])", { s })), "Type<list>");
      assertEquals(env.evaluate("[s].exists(x, x == null)", { s }), false);
      assertEquals(faults, []);
      assertCelError(
        () => env.evaluate("['a', s].join(',')", { s }),
        EvaluationError,
        "invalid_list_element_type",
      );
      assertEquals(
        faults,
        [],
        "join refuses the list type and records nothing",
      );
    });
  },
);

Deno.test(
  pin(
    "synchronous entry points return synchronous results with the registrations in place",
  ),
  () => {
    const { env } = internalEnvironment();
    const cases: Array<[string, unknown]> = [
      ["1 == 2", false],
      ["'a' + 'b'", "ab"],
      ["'a' < 'b'", true],
      ["1 in [1]", true],
      ["[1, 2].exists(x, x == 2)", true],
      ["size('abc')", 3n],
      ["'abc'.matches('a')", true],
      ["{'a': 1}.a == 1 && 'x' in ['x']", true],
      ["s == null", false],
      ["has(s.x)", false],
    ];
    for (const [expression, expected] of cases) {
      const result = env.evaluate(expression, { s });
      assertEquals(result instanceof Promise, false, expression);
      assertEquals(result, expected, expression);
    }
    const composed = env.evaluate("s + 'x'", { s });
    assertEquals(composed instanceof Promise, false);
    assertInstanceOf(composed, Object);
    const program = env.parse("s != null && 1 == 1");
    assertEquals(program({ s }), true);
    // The custom binary overloads mark every use of their operator maybe-async
    // (fact 4); the result is still synchronous because every handler is.
    assertEquals(readMaybeAsync(program), true);
    const sizeProgram = env.parse("size('abc')");
    sizeProgram({});
    assertEquals(readMaybeAsync(sizeProgram), false);
  },
);
