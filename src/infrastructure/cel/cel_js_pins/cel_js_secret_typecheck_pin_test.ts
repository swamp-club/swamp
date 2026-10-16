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

// Phase 1.2 pins for check-time refusal (design/enablers/typed-secrets.md
// Section 4.3 item 4, and the Phase 1.2 list in Section 11: "`vault.get`,
// with the static return type `Secret`, gives check-time errors in the
// validation environment, except for the allowed set in Section 4.1 and four
// escapes: a dyn operand, a map literal keyed by the result and `type()` check
// as valid, and `has()` on a call result fails as `invalid_macro_argument`.").
//
// The validation environment registers the allowed set's overloads in place
// of the refusing ones. A dyn operand and a map-literal key are refused at
// run time instead; `type()` is never refused, it answers the type name and
// reveals nothing; and the `has()` case fails for a reason of its own
// although `has()` is in the allowed set.
import { assertEquals, assertInstanceOf } from "@std/assert";
import { Environment, TypeError as CelTypeError } from "cel-js";
import { pin } from "./cel_js_pin_test_helpers.ts";
import {
  createSecret,
  registerAllowedSet,
  registerSecretType,
  secretEnvironmentOptions,
} from "./cel_js_secret_test_helpers.ts";

class Vault {}

function validationEnvironment(): Environment {
  const env = registerSecretType(new Environment(secretEnvironmentOptions()))
    .registerType("Vault", { ctor: Vault, fields: {} })
    .registerFunction(
      "Vault.get(string, string): Secret",
      () => createSecret("v/k"),
      { async: false },
    )
    .registerVariable("vault", "Vault");
  return registerAllowedSet(env);
}

function checkOutcome(env: Environment, expression: string): string {
  const result = env.check(expression);
  if (result.valid) return `valid ${result.type}`;
  assertInstanceOf(result.error, CelTypeError, expression);
  return `invalid ${result.error.code}`;
}

Deno.test(pin("the allowed set on a vault.get result passes the check"), () => {
  const env = validationEnvironment();
  const cases: Array<[string, string]> = [
    ["vault.get('v', 'k')", "valid Secret"],
    ["vault.get('v', 'k') + 'x'", "valid Secret"],
    ["'x' + vault.get('v', 'k')", "valid Secret"],
    ["vault.get('v', 'k') + vault.get('v', 'k')", "valid Secret"],
    ["vault.get('v', 'k') == null", "valid bool"],
    ["null == vault.get('v', 'k')", "valid bool"],
    ["vault.get('v', 'k') != null", "valid bool"],
    ["null != vault.get('v', 'k')", "valid bool"],
    ["vault.get('v', 'k').?x", "valid optional<dyn>"],
    ["[vault.get('v', 'k')]", "valid list<Secret>"],
    ["{'a': vault.get('v', 'k')}", "valid map<string, Secret>"],
    ["cel.bind(v, vault.get('v', 'k'), v + 'x')", "valid Secret"],
  ];
  for (const [expression, expected] of cases) {
    assertEquals(checkOutcome(env, expression), expected, expression);
  }
});

Deno.test(
  pin("every other operation on a vault.get result is a check-time error"),
  () => {
    const env = validationEnvironment();
    const cases: Array<[string, string]> = [
      ["vault.get('v', 'k') == 'x'", "invalid no_such_overload"],
      ["'x' == vault.get('v', 'k')", "invalid no_such_overload"],
      [
        "vault.get('v', 'k') == vault.get('v', 'k')",
        "invalid no_such_overload",
      ],
      ["vault.get('v', 'k') < 'x'", "invalid no_such_overload"],
      ["vault.get('v', 'k') in ['x']", "invalid no_such_overload"],
      ["[vault.get('v', 'k')] == ['x']", "invalid no_such_overload"],
      ["size(vault.get('v', 'k'))", "invalid no_matching_overload"],
      ["string(vault.get('v', 'k'))", "invalid no_matching_overload"],
      ["int(vault.get('v', 'k'))", "invalid no_matching_overload"],
      ["vault.get('v', 'k').matches('x')", "invalid no_matching_overload"],
      ["vault.get('v', 'k').size()", "invalid no_matching_overload"],
      ["vault.get(vault.get('v', 'k'), 'k')", "invalid no_matching_overload"],
      ["vault.get('v', 'k').map(x, x)", "invalid invalid_comprehension_range"],
      ["vault.get('v', 'k') ? 1 : 2", "invalid invalid_condition_type"],
      ["!vault.get('v', 'k')", "invalid no_such_overload"],
      ["-vault.get('v', 'k')", "invalid no_such_overload"],
      ["vault.get('v', 'k') || true", "invalid invalid_logical_operand"],
      ["vault.get('v', 'k').x", "invalid no_such_key"],
      [
        "cel.bind(v, vault.get('v', 'k'), v == 'x')",
        "invalid no_such_overload",
      ],
    ];
    for (const [expression, expected] of cases) {
      assertEquals(checkOutcome(env, expression), expected, expression);
    }
  },
);

Deno.test(
  pin(
    "a dyn operand, a map-literal key, type() and has() on a call escape or fail the check differently",
  ),
  () => {
    const env = validationEnvironment();
    const cases: Array<[string, string]> = [
      ["x == vault.get('v', 'k')", "valid bool"],
      ["vault.get('v', 'k') == dyn('x')", "valid bool"],
      ["dyn(vault.get('v', 'k')) == 'x'", "valid bool"],
      ["{vault.get('v', 'k'): 1}", "valid map<Secret, int>"],
      ["type(vault.get('v', 'k'))", "valid type"],
      ["has(vault.get('v', 'k').x)", "invalid invalid_macro_argument"],
    ];
    for (const [expression, expected] of cases) {
      assertEquals(checkOutcome(env, expression), expected, expression);
    }
  },
);
