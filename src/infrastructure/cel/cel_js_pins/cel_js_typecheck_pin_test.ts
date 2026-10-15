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

// Pins for static checking and receiver types (design/enablers/
// typed-secrets.md Section 4.2: "`cel.bind(v, vault, v.get(...))` can call a
// registered receiver through an alias. Receiver typing does not enforce
// scope/effect restrictions.").

import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  Environment,
  EvaluationError,
  TypeError as CelTypeError,
} from "cel-js";
import {
  assertCelError,
  assertPlainError,
  dynEnvironment,
  pin,
} from "./cel_js_pin_test_helpers.ts";

class Vault {
  get(namespace: string, key: string): string {
    return `${namespace}/${key}`;
  }
}

function vaultEnvironment(): { env: Environment; calls: () => number } {
  let calls = 0;
  const env = new Environment()
    .registerType("Vault", { ctor: Vault, fields: {} })
    .registerFunction(
      "Vault.get(string, string): dyn",
      (v: Vault, namespace: string, key: string) => {
        calls++;
        return v.get(namespace, key);
      },
    )
    .registerVariable("vault", "Vault");
  return { env, calls: () => calls };
}

function checkError(env: Environment, expression: string) {
  const result = env.check(expression);
  assertEquals(result.valid, false, expression);
  assertInstanceOf(result.error, CelTypeError);
  return result.error;
}

Deno.test(
  pin(
    "evaluate runs the static checker: a bound but undeclared variable is rejected",
  ),
  () => {
    const strict = new Environment().registerVariable("x", "int");
    assertEquals(strict.check("x + 1"), { valid: true, type: "int" });
    assertEquals(checkError(strict, "y").code, "unknown_variable");
    assertCelError(
      () => strict.evaluate("y", { y: 1n }),
      EvaluationError,
      "unknown_variable",
    );
    assertCelError(
      () => strict.evaluate("x", { x: "str" }),
      EvaluationError,
      "variable_type_mismatch",
    );
  },
);

Deno.test(
  pin(
    "a type error anywhere in the expression stops evaluation before any handler runs",
  ),
  () => {
    let calls = 0;
    const env = dynEnvironment().registerFunction("f(): bool", () => {
      calls++;
      return true;
    });
    assertEquals(checkError(env, "true + 1").code, "no_such_overload");
    assertCelError(
      () => env.evaluate("f() && true + 1 == 2"),
      EvaluationError,
      "no_such_overload",
    );
    assertCelError(
      () => env.evaluate("f() || true + 1 == 2"),
      EvaluationError,
      "no_such_overload",
    );
    assertEquals(calls, 0);
  },
);

Deno.test(
  pin(
    "a dyn environment degrades the checker to dyn but still rejects unknown functions",
  ),
  () => {
    const env = dynEnvironment();
    assertEquals(env.check("s + 1"), { valid: true, type: "int" });
    assertEquals(env.check("s == 1"), { valid: true, type: "bool" });
    assertEquals(env.check("size(s)"), { valid: true, type: "int" });
    assertEquals(checkError(env, "nope()").code, "no_matching_overload");
    assertEquals(checkError(env, "s.nope()").code, "no_matching_overload");
  },
);

Deno.test(
  pin("a dotted function name cannot be declared without a receiver type"),
  () => {
    assertPlainError(
      () =>
        new Environment().registerFunction(
          "vault.get(string, string): dyn",
          () => null,
        ),
      "Invalid function declaration 'vault.get(string, string): dyn': Unknown type: vault",
    );
  },
);

Deno.test(
  pin("a receiver type plus a bound variable is checked and called"),
  () => {
    const { env, calls } = vaultEnvironment();
    const vault = new Vault();
    assertEquals(env.check("vault.get('a', 'b')"), {
      valid: true,
      type: "dyn",
    });
    assertEquals(env.parse("vault.get('a', 'b')").check(), {
      valid: true,
      type: "dyn",
    });
    assertEquals(env.evaluate("vault.get('a', 'b')", { vault }), "a/b");
    assertEquals(calls(), 1);
    assertEquals(
      checkError(env, "vault.get('a')").code,
      "no_matching_overload",
    );
    assertEquals(
      checkError(env, "vault.nope('a')").code,
      "no_matching_overload",
    );
    assertEquals(checkError(env, "vault.secret").code, "no_such_key");
  },
);

Deno.test(
  pin(
    "a receiver call with wrong argument types is rejected before the handler runs",
  ),
  () => {
    const { env, calls } = vaultEnvironment();
    assertEquals(
      checkError(env, "vault.get(1, 'b')").code,
      "no_matching_overload",
    );
    assertCelError(
      () => env.evaluate("vault.get(1, 'b')", { vault: new Vault() }),
      EvaluationError,
      "no_matching_overload",
    );
    assertEquals(calls(), 0);
  },
);

Deno.test(
  pin("a receiver bound with registerConstant needs no evaluation context"),
  () => {
    const env = new Environment()
      .registerType("Vault", { ctor: Vault, fields: {} })
      .registerFunction(
        "Vault.get(string, string): dyn",
        (v: Vault, a: string, b: string) => v.get(a, b),
      )
      .registerConstant("v2", "Vault", new Vault());
    assertEquals(env.evaluate("v2.get('x', 'y')"), "x/y");
  },
);

Deno.test(
  pin("cel.bind and comprehension variables can alias a receiver and call it"),
  () => {
    const { env, calls } = vaultEnvironment();
    const vault = new Vault();
    assertEquals(env.check("cel.bind(v, vault, v.get('a', 'b'))"), {
      valid: true,
      type: "dyn",
    });
    assertEquals(
      env.evaluate("cel.bind(v, vault, v.get('a', 'b'))", { vault }),
      "a/b",
    );
    assertEquals(env.evaluate("[vault].map(v, v.get('x', 'y'))", { vault }), [
      "x/y",
    ]);
    assertEquals(calls(), 2);
  },
);
