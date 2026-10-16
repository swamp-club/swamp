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

// Pins for custom operator registration (design/enablers/typed-secrets.md
// Section 4.2, fact 4: "`==` creates derived `!=` and mirrored mixed-type
// equality, so register `==` only. A `Secret == dyn` overload overlaps its own
// mirror when both operands are secrets. Addition is not mirrored, so each
// operand order needs its own registration. The `map` type alias is valid in
// custom signatures, but a parameterized type spelled with a comma is not.
// Overlapping built-in list and map registrations are not a reliable override.
// A custom binary overload marks every use of its operator maybe-async, and so
// does a function registered without `{ async: false }`.").

import { assertEquals, assertInstanceOf } from "@std/assert";
import { type Environment, EvaluationError } from "cel-js";
import {
  assertCelError,
  assertPlainError,
  dynEnvironment,
  FixtureSecret,
  pin,
  readMaybeAsync,
} from "./cel_js_pin_test_helpers.ts";

function secretEnvironment(): Environment {
  return dynEnvironment().registerType("Secret", {
    ctor: FixtureSecret,
    fields: {},
  });
}

const s = new FixtureSecret("hunter2");
const t = new FixtureSecret("hunter2");
const u = new FixtureSecret("other");

Deno.test(
  pin("operator signatures use infix syntax, not the _op_ function form"),
  () => {
    assertPlainError(
      () =>
        secretEnvironment().registerOperator(
          "_+_(Secret, string): Secret",
          () => s,
        ),
      "Operator overload invalid: _+_(Secret, string): Secret",
    );
    assertPlainError(
      () =>
        secretEnvironment().registerFunction(
          "_+_(Secret, string): Secret",
          () => s,
        ),
      "Invalid signature: _+_(Secret, string): Secret",
    );
    const env = secretEnvironment().registerOperator(
      "Secret + string: Secret",
      (a: FixtureSecret, b: string) => new FixtureSecret(a.v + b),
    );
    const result = env.evaluate("s + 'x'", { s });
    assertInstanceOf(result, FixtureSecret);
    assertEquals(result.v, "hunter2x");
  },
);

Deno.test(pin("an operator signature may omit its return type"), () => {
  const env = secretEnvironment().registerOperator(
    "Secret + string",
    (a: FixtureSecret, b: string) => new FixtureSecret(a.v + b),
  );
  assertInstanceOf(env.evaluate("s + 'x'", { s }), FixtureSecret);
  secretEnvironment().registerOperator("Secret % Secret", () => s);
});

Deno.test(
  pin(
    "addition is not mirrored: Secret + string does not answer string + Secret",
  ),
  () => {
    const env = secretEnvironment().registerOperator(
      "Secret + string: Secret",
      (a: FixtureSecret, b: string) => new FixtureSecret(a.v + b),
    );
    assertCelError(
      () => env.evaluate("'x' + s", { s }),
      EvaluationError,
      "no_such_overload",
    );
  },
);

Deno.test(pin("comparison operators must return bool"), () => {
  assertPlainError(
    () =>
      secretEnvironment().registerOperator("Secret < Secret: Secret", () => s),
    "Comparison operator '<' must return 'bool', got 'Secret'",
  );
  const env = secretEnvironment().registerOperator(
    "Secret < Secret",
    (a: FixtureSecret, b: FixtureSecret) => a.v < b.v,
  );
  assertEquals(env.evaluate("s < u", { s, u }), true);
});

Deno.test(pin("a unary operator overload registers and dispatches"), () => {
  const env = secretEnvironment().registerOperator(
    "!Secret: bool",
    (a: FixtureSecret) => a.v.length === 0,
  );
  assertEquals(env.evaluate("!s", { s }), false);
});

Deno.test(
  pin("registering == and != for the same types throws in either order"),
  () => {
    const eqFirst = secretEnvironment().registerOperator(
      "Secret == Secret",
      () => true,
    );
    assertPlainError(
      () => eqFirst.registerOperator("Secret != Secret", () => false),
      "Operator overload already registered: Secret != Secret: bool",
    );
    const neFirst = secretEnvironment().registerOperator(
      "Secret != Secret",
      () => false,
    );
    assertPlainError(
      () => neFirst.registerOperator("Secret == Secret", () => true),
      "Operator overload already registered: Secret != Secret: bool",
    );
  },
);

Deno.test(pin("!= is derived from the == handler"), () => {
  let calls = 0;
  const env = secretEnvironment().registerOperator(
    "Secret == Secret",
    (a: FixtureSecret, b: FixtureSecret) => {
      calls++;
      return a.v === b.v;
    },
  );
  assertEquals(env.evaluate("s == t", { s, t }), true);
  assertEquals(env.evaluate("s != t", { s, t }), false);
  assertEquals(env.evaluate("s != u", { s, u }), true);
  assertEquals(calls, 3);
});

Deno.test(pin("registering only != leaves == as identity"), () => {
  let calls = 0;
  const env = secretEnvironment().registerOperator(
    "Secret != Secret",
    (a: FixtureSecret, b: FixtureSecret) => {
      calls++;
      return a.v !== b.v;
    },
  );
  assertEquals(env.evaluate("s != t", { s, t }), false);
  assertEquals(calls, 1);
  // s and t hold the same value but are different objects.
  assertEquals(env.evaluate("s == t", { s, t }), false);
  assertEquals(env.evaluate("s == s", { s }), true);
  assertEquals(calls, 1);
});

Deno.test(
  pin("Secret == string is mirrored to string == Secret and both != forms"),
  () => {
    const env = secretEnvironment().registerOperator(
      "Secret == string",
      (a: FixtureSecret, b: string) => a.v === b,
    );
    assertEquals(env.evaluate("s == 'hunter2'", { s }), true);
    assertEquals(env.evaluate("'hunter2' == s", { s }), true);
    assertEquals(env.evaluate("'x' != s", { s }), true);
    assertEquals(env.evaluate("s != 'x'", { s }), true);
    assertPlainError(
      () =>
        env.registerOperator(
          "string == Secret",
          (a: string, b: FixtureSecret) => a === b.v,
        ),
      "Operator overload already registered: string == Secret: bool",
    );
  },
);

Deno.test(
  pin(
    "Secret == dyn overlaps with its own mirror only when both operands are Secret, and only at evaluation",
  ),
  () => {
    const env = secretEnvironment().registerOperator(
      "Secret == dyn",
      () => true,
    );
    assertEquals(env.check("s == t").valid, true);
    assertEquals(env.evaluate("s == 1", { s }), true);
    assertEquals(env.evaluate("s == 'x'", { s }), true);
    assertEquals(env.evaluate("1 == s", { s }), true);
    assertPlainError(
      () => env.evaluate("s == t", { s, t }),
      "Operator overload 'dyn == Secret: bool' overlaps with 'Secret == dyn: bool'.",
    );
  },
);

Deno.test(
  pin(
    "a Secret in list<Secret> overload overlaps the built-in at evaluation, not registration",
  ),
  () => {
    const handler = (a: FixtureSecret, l: FixtureSecret[]) =>
      l.some((x) => x.v === a.v);
    const dynOperands = secretEnvironment().registerOperator(
      "Secret in list<Secret>",
      handler,
    );
    assertEquals(dynOperands.evaluate("s in [1]", { s }), false);
    assertPlainError(
      () => dynOperands.evaluate("s in [t]", { s, t }),
      "Operator overload 'V in list<V>: bool' overlaps with 'Secret in list<Secret>: bool'.",
    );
    // With static types the custom overload is the only candidate and runs.
    const typed = secretEnvironment()
      .registerOperator("Secret in list<Secret>", handler)
      .registerVariable("s", "Secret")
      .registerVariable("l", "list<Secret>");
    assertEquals(typed.evaluate("s in l", { s, l: [t] }), true);
  },
);

Deno.test(
  pin("the bare map and list aliases are valid in operator signatures"),
  () => {
    for (
      const signature of [
        "Secret in map: bool",
        "string in map: bool",
        "map == Secret: bool",
        "Secret == list: bool",
        "Secret == list<Secret>: bool",
      ]
    ) {
      secretEnvironment().registerOperator(signature, () => true);
    }
  },
);

Deno.test(
  pin(
    "an operator signature cannot spell a comma-separated parameterized type",
  ),
  () => {
    for (
      const signature of [
        "Secret in map<string, Secret>",
        "Secret == map<string, Secret>: bool",
        "Secret == map<string,Secret>: bool",
      ]
    ) {
      assertPlainError(
        () => secretEnvironment().registerOperator(signature, () => true),
        `Operator overload invalid: ${signature}`,
      );
    }
    // A function signature accepts the same parameter type.
    secretEnvironment().registerFunction(
      "Secret.f(map<string, Secret>): bool",
      () => true,
    );
    secretEnvironment().registerFunction("Secret.f(map): bool", () => true);
  },
);

Deno.test(
  pin(
    "size() and matches() on a custom type are ordinary function registrations",
  ),
  () => {
    const env = secretEnvironment()
      .registerFunction(
        "size(Secret): int",
        (a: FixtureSecret) => BigInt(a.v.length),
      )
      .registerFunction(
        "Secret.size(): int",
        (a: FixtureSecret) => BigInt(a.v.length),
      )
      .registerFunction(
        "Secret.matches(string): bool",
        (a: FixtureSecret, re: string) => new RegExp(re).test(a.v),
      );
    assertEquals(env.evaluate("size(s)", { s }), 7n);
    assertEquals(env.evaluate("s.size()", { s }), 7n);
    assertEquals(env.evaluate("s.matches('^hunt')", { s }), true);
  },
);

// ast.maybeAsync is internal evaluator state, read after a run because the
// flag is only settled once overload candidates are resolved.
function maybeAsyncAfterRun(env: Environment, expression: string): boolean {
  const program = env.parse(expression);
  program({});
  return readMaybeAsync(program);
}

Deno.test(
  pin("built-in operators and {async: false} functions are not maybe-async"),
  () => {
    assertEquals(maybeAsyncAfterRun(dynEnvironment(), "1 == 2"), false);
    assertEquals(maybeAsyncAfterRun(dynEnvironment(), "1 + 2"), false);
    const env = dynEnvironment().registerFunction("f(): int", () => 1n, {
      async: false,
    });
    assertEquals(maybeAsyncAfterRun(env, "f() + 1"), false);
  },
);

Deno.test(
  pin("a custom binary overload marks every use of that operator maybe-async"),
  () => {
    const withEquality = secretEnvironment().registerOperator(
      "Secret == Secret",
      (a: FixtureSecret, b: FixtureSecret) => a.v === b.v,
    );
    assertEquals(maybeAsyncAfterRun(withEquality, "1 == 2"), true);
    const withAddition = dynEnvironment().registerOperator(
      "double + int",
      (a: number, b: bigint) => a + Number(b),
    );
    assertEquals(maybeAsyncAfterRun(withAddition, "1 + 2"), true);
  },
);

Deno.test(
  pin("a function registered without options is maybe-async even when sync"),
  () => {
    const env = dynEnvironment().registerFunction("g(): int", () => 1n);
    assertEquals(maybeAsyncAfterRun(env, "g() + 1"), true);
  },
);
