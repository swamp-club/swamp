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

// Phase 1.2 pins for the Proxy-based Secret (design/enablers/typed-secrets.md
// Section 3.1, and the Phase 1.2 list in Section 11: "cel-js recognizes the
// Proxy-based `Secret` by its constructor. Building a macro range over it
// records a fault and throws; cel-js absorbs the error like a handler error,
// so the fault is what fails the evaluation." and "An async custom function
// can return a `Secret`, and awaiting it reads `then` without a fault.").
//
// The absorption is the one place the design's first draft was wrong: the
// fact 3 pin covers an error while evaluating a list literal range, which is
// not absorbed; iterating a range value whose `ownKeys` throws is absorbed
// like any handler error. The recorded fault is what makes the refusal
// visible (Section 4.3, item 2).
import {
  assertEquals,
  assertInstanceOf,
  AssertionError,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Environment, EvaluationError, Optional } from "cel-js";
import { assertCelError, pin } from "./cel_js_pin_test_helpers.ts";
import {
  createSecret,
  registerAllowedSet,
  registerSecretType,
  Secret,
  secretEnvironmentOptions,
  SecretRefusedError,
  secretState,
  withFaultContext,
} from "./cel_js_secret_fixture.ts";

function secretEnvironment(): Environment {
  return registerSecretType(new Environment(secretEnvironmentOptions()));
}

const s = createSecret("v/k");

Deno.test(
  pin("cel-js resolves the Proxy-based Secret by its constructor"),
  () => {
    withFaultContext((faults) => {
      assertEquals(
        String(secretEnvironment().evaluate("type(s)", { s })),
        "Type<Secret>",
      );
      const typed = registerAllowedSet(secretEnvironment()).registerVariable(
        "v",
        "Secret",
      );
      assertEquals(typed.evaluate("v == null", { v: s }), false);
      assertCelError(
        () => typed.evaluate("v == null", { v: {} }),
        EvaluationError,
        "variable_type_mismatch",
      );
      assertEquals(s instanceof Secret, true);
      assertEquals(secretState(s), { parts: [{ reference: "v/k" }] });
      assertEquals(faults, []);
    });
  },
);

Deno.test(
  pin(
    "a comprehension macro over a dyn Secret calls ownKeys, which records a fault and throws",
  ),
  () => {
    for (
      const expression of [
        "s.map(x, x)",
        "s.map(x, true, x)",
        "s.filter(x, true)",
        "s.all(x, true)",
        "s.exists(x, true)",
        "s.exists_one(x, true)",
      ]
    ) {
      withFaultContext((faults) => {
        const error = assertThrows(
          () => secretEnvironment().evaluate(expression, { s }),
          SecretRefusedError,
          "Secret refuses ownKeys",
          expression,
        );
        assertEquals(error.operation, "ownKeys");
        assertEquals(faults, [{ operation: "ownKeys" }], expression);
      });
    }
  },
);

Deno.test(
  pin(
    "the range error over a Secret is absorbed like a handler error, and only the recorded fault shows it",
  ),
  () => {
    // The third column is how many ranges were built: one fault each.
    const absorbed: Array<[string, unknown, number]> = [
      ["s.exists(x, true) || true", true, 1],
      ["s.all(x, true) && false", false, 1],
      ["[1, 2].exists(i, i == 2 || s.exists(x, true))", true, 1],
      ["[1, 2].exists(i, s.exists(x, true) || i == 2)", true, 2],
      ["[1, 3].all(i, i == 1 && s.all(x, true))", false, 1],
    ];
    for (const [expression, expected, ranges] of absorbed) {
      withFaultContext((faults) => {
        assertEquals(
          secretEnvironment().evaluate(expression, { s }),
          expected,
          expression,
        );
        assertEquals(
          faults,
          Array.from({ length: ranges }, () => ({ operation: "ownKeys" })),
          expression,
        );
      });
    }
    // An unselected branch builds no range and records nothing.
    withFaultContext((faults) => {
      assertEquals(
        secretEnvironment().evaluate("true || s.exists(x, true)", { s }),
        true,
      );
      assertEquals(faults, []);
    });
    // When the other side does not decide, the error is rethrown.
    withFaultContext((faults) => {
      assertThrows(
        () => secretEnvironment().evaluate("s.exists(x, true) || false", { s }),
        SecretRefusedError,
        "Secret refuses ownKeys",
      );
      assertEquals(faults, [{ operation: "ownKeys" }]);
    });
  },
);

Deno.test(
  pin("has(), .? and field selection on a Secret touch no trap"),
  () => {
    withFaultContext((faults) => {
      const env = secretEnvironment();
      assertEquals(env.evaluate("has(s.x)", { s }), false);
      const optional = env.evaluate("s.?x", { s });
      assertInstanceOf(optional, Optional);
      assertEquals(optional.hasValue(), false);
      assertEquals(env.evaluate("s.?x.orValue('d')", { s }), "d");
      assertCelError(
        () => env.evaluate("s.x", { s }),
        EvaluationError,
        "no_such_key",
      );
      assertCelError(
        () => env.evaluate("s['x']", { s }),
        EvaluationError,
        "no_such_key",
      );
      assertEquals(faults, []);
    });
  },
);

Deno.test(
  pin(
    "an async custom function can return a Secret, and awaiting it reads then without a fault",
  ),
  async () => {
    const env = registerAllowedSet(secretEnvironment()).registerFunction(
      "load(): Secret",
      async () => {
        await Promise.resolve();
        return s;
      },
    );
    await withFaultContext(async (faults) => {
      const pending = env.evaluate("load()", {});
      assertInstanceOf(pending, Promise);
      assertStrictEquals(await pending, s);
      assertEquals(await env.evaluate("load() == null", {}), false);
      assertStrictEquals(await env.evaluate("[load()][0]", {}), s);
      assertEquals(faults, []);
    });
    assertEquals((s as { then?: unknown }).then, undefined);
    assertStrictEquals(await Promise.resolve(s), s);
  },
);

Deno.test(
  pin(
    "every JavaScript path that would reveal or copy a Secret records a fault and throws",
  ),
  () => {
    const cases: Array<[string, () => unknown, string]> = [
      ["structuredClone", () => structuredClone(s), "getOwnPropertyDescriptor"],
      ["JSON.stringify", () => JSON.stringify(s), "toJSON"],
      ["String()", () => String(s), "Symbol(Symbol.toPrimitive)"],
      ["template literal", () => `${s}`, "Symbol(Symbol.toPrimitive)"],
      ["Object.keys", () => Object.keys(s), "ownKeys"],
      ["spread", () => ({ ...s }), "ownKeys"],
    ];
    for (const [label, fn, operation] of cases) {
      withFaultContext((faults) => {
        assertThrows(
          fn,
          SecretRefusedError,
          `Secret refuses ${operation}`,
          label,
        );
        assertEquals(faults, [{ operation }], label);
      });
    }
  },
);

Deno.test(
  pin(
    "inspecting a Secret is harmless: Deno.inspect prints the class and touches no trap, except with showProxy",
  ),
  () => {
    withFaultContext((faults) => {
      assertEquals(Deno.inspect(s), "Secret {}");
      assertEquals(Deno.inspect({ a: s }), "{ a: Secret {} }");
      assertEquals("x" in s, false);
      assertStrictEquals(Object.getPrototypeOf(s), Secret.prototype);
      assertEquals(faults, []);
      Deno.inspect(s, { showProxy: true });
      assertEquals(faults, [{ operation: "getOwnPropertyDescriptor" }]);
    });
  },
);

Deno.test(
  pin(
    "assertEquals between two different Secrets walks their keys; assertStrictEquals does not",
  ),
  () => {
    const t = createSecret("v/k");
    withFaultContext((faults) => {
      assertStrictEquals(s, s);
      assertEquals(s, s);
      assertEquals([s], [s]);
      assertThrows(() => assertStrictEquals(s, t), AssertionError);
      assertEquals(faults, []);
      assertThrows(
        () => assertEquals(s, t),
        SecretRefusedError,
        "Secret refuses ownKeys",
      );
      assertEquals(faults, [{ operation: "ownKeys" }]);
    });
  },
);
