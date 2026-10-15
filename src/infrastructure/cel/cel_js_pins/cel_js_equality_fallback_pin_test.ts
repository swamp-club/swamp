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

// Pins for equality fallback and container shortcuts
// (design/enablers/typed-secrets.md Section 4.2: "Container equality has
// identity/type shortcuts. It does not reliably call a `Secret == string`
// overload for secret/string leaves, and the same unloaded object can compare
// equal by identity. Membership has the same issue." and "Direct unmatched dyn
// equality falls back to identity ... An evaluation frame populated only by
// custom operator handlers cannot see a handler never called.").

import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  type Environment,
  EvaluationError,
  TypeError as CelTypeError,
} from "cel-js";
import {
  assertCelError,
  dynEnvironment,
  FixtureSecret,
  pin,
} from "./cel_js_pin_test_helpers.ts";

function countingEnvironment<R>(
  signature: string,
  handler: (a: FixtureSecret, b: R) => boolean,
): { env: Environment; calls: () => number } {
  let calls = 0;
  const env = dynEnvironment()
    .registerType("Secret", { ctor: FixtureSecret, fields: {} })
    .registerOperator(signature, (a: FixtureSecret, b: R) => {
      calls++;
      return handler(a, b);
    });
  return { env, calls: () => calls };
}

function assertUncalled(
  env: Environment,
  calls: () => number,
  cases: Array<[string, unknown]>,
  bindings: Record<string, unknown>,
): void {
  for (const [expression, expected] of cases) {
    const before = calls();
    assertEquals(env.evaluate(expression, bindings), expected, expression);
    assertEquals(calls() - before, 0, `${expression} called the handler`);
  }
}

Deno.test(
  pin(
    "dyn equality with no matching overload falls back to identity without calling any handler",
  ),
  () => {
    const { env, calls } = countingEnvironment(
      "Secret == Secret",
      (a, b: FixtureSecret) => a.v === b.v,
    );
    const s = new FixtureSecret("x");
    const plain = { v: "x" };
    assertUncalled(env, calls, [
      ["s == 'x'", false],
      ["s != 'x'", true],
      ["'x' == s", false],
      ["s == 1", false],
      ["s == 1.0", false],
      ["s == null", false],
      ["null == s", false],
      ["s == true", false],
      ["s == [s]", false],
      ["s == {}", false],
      ["s == plain", false],
      ["plain == s", false],
      ["s in ['x']", false],
      ["'x' in [s]", false],
      ["s in [1, s]", true],
      ["1 in [s, 1]", true],
    ], { s, plain });
    assertEquals(
      env.evaluate("s == t", { s, t: new FixtureSecret("x") }),
      true,
    );
    assertEquals(calls(), 1);
  },
);

Deno.test(
  pin("with no equality overload at all, custom values compare by identity"),
  () => {
    const env = dynEnvironment().registerType("Secret", {
      ctor: FixtureSecret,
      fields: {},
    });
    const s = new FixtureSecret("x");
    const t = new FixtureSecret("x");
    const cases: Array<[string, unknown]> = [
      ["s == t", false],
      ["s != t", true],
      ["s == s", true],
      ["[s] == [t]", false],
      ["s in [t]", false],
      ["s in [s]", true],
      ["[s] == [s]", true],
    ];
    for (const [expression, expected] of cases) {
      assertEquals(env.evaluate(expression, { s, t }), expected, expression);
    }
  },
);

Deno.test(
  pin(
    "containers short-circuit on identity even when the == handler says not equal",
  ),
  () => {
    const { env, calls } = countingEnvironment("Secret == Secret", () => false);
    const s = new FixtureSecret("x");
    assertUncalled(env, calls, [
      ["[s] == [s]", true],
      ["s in [s]", true],
    ], { s });
  },
);

Deno.test(
  pin(
    "a Secret == string overload is called directly but never from containers or membership",
  ),
  () => {
    const { env, calls } = countingEnvironment(
      "Secret == string",
      (a, b: string) => a.v === b,
    );
    const s = new FixtureSecret("hunter2");
    assertEquals(env.evaluate("s == 'hunter2'", { s }), true);
    assertEquals(env.evaluate("'hunter2' == s", { s }), true);
    assertEquals(calls(), 2);
    assertUncalled(env, calls, [
      ["[s] == ['hunter2']", false],
      ["['hunter2'] == [s]", false],
      ["{'k': s} == {'k': 'hunter2'}", false],
      ["'hunter2' in [s]", false],
      ["s in ['hunter2']", false],
      ["[s] == [s]", true],
      ["s in [s]", true],
    ], { s });
  },
);

Deno.test(
  pin(
    "static typing turns an unmatched comparison into a check-time no_such_overload",
  ),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerOperator(
        "Secret == Secret",
        (a: FixtureSecret, b: FixtureSecret) => a.v === b.v,
      )
      .registerVariable("s", "Secret")
      .registerVariable("t", "Secret");
    const s = new FixtureSecret("x");
    const t = new FixtureSecret("x");
    for (
      const expression of [
        "s == 'x'",
        "s != 'x'",
        "s == 1",
        "s == null",
        "s in ['x']",
      ]
    ) {
      const result = env.check(expression);
      assertEquals(result.valid, false, expression);
      assertInstanceOf(result.error, CelTypeError);
      assertEquals(result.error.code, "no_such_overload", expression);
      assertCelError(
        () => env.evaluate(expression, { s, t }),
        EvaluationError,
        "no_such_overload",
      );
    }
    assertEquals(env.evaluate("s == t", { s, t }), true);
    assertEquals(env.evaluate("s in [t]", { s, t }), true);
  },
);

Deno.test(
  pin("dyn() escapes the static check and falls back to identity"),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerOperator(
        "Secret == Secret",
        (a: FixtureSecret, b: FixtureSecret) => a.v === b.v,
      )
      .registerVariable("s", "Secret");
    assertEquals(env.check("s == dyn('x')").valid, true);
    assertEquals(
      env.evaluate("s == dyn('x')", { s: new FixtureSecret("x") }),
      false,
    );
  },
);

Deno.test(
  pin(
    "statically typed custom values with no == overload cannot be compared at all",
  ),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerVariable("s", "Secret")
      .registerVariable("t", "Secret");
    const s = new FixtureSecret("x");
    const t = new FixtureSecret("x");
    for (const expression of ["s == t", "s != t", "s == 'x'"]) {
      assertEquals(env.check(expression).error?.code, "no_such_overload");
      assertCelError(
        () => env.evaluate(expression, { s, t }),
        EvaluationError,
        "no_such_overload",
      );
    }
  },
);
