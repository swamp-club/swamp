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

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { Environment } from "cel-js";
import {
  SECRET_DESTINATION_REFUSED,
  SECRET_OPERATION_UNSUPPORTED,
} from "../../domain/expressions/errors.ts";
import {
  functionRefusalSignatures,
  operatorRefusalSignatures,
  secretCapableBuiltins,
} from "./cel_js_secret_refusal_inventory.ts";
import { runInFaultScope, SecretRefusal } from "./secret_fault_context.ts";
import {
  registerAllowedSet,
  registerSecretRefusals,
  registerSecretType,
} from "./secret_registrations.ts";
import { secretParts, vaultReferenceSecret } from "./secret_value.ts";

const s = vaultReferenceSecret({ vaultName: "v", key: "k" }, "a");

function environment(): Environment {
  return registerAllowedSet(
    registerSecretType(
      new Environment({
        unlistedVariablesAreDyn: true,
        enableOptionalTypes: true,
        homogeneousAggregateLiterals: false,
      }),
    ),
  );
}

Deno.test("registerAllowedSet: + composes in both operand orders, and == null answers false", () => {
  const env = environment();
  runInFaultScope((scope) => {
    const composed = env.evaluate("'a' + s + 'b'", { s });
    assertEquals(secretParts(composed), ["a", ...secretParts(s)!, "b"]);
    assertEquals(env.evaluate("s == null", { s }), false);
    assertEquals(env.evaluate("null != s", { s }), true);
    assertStrictEquals(env.evaluate("s", { s }), s);
    assertEquals(String(env.evaluate("type(s)", { s })), "Type<Secret>");
    assertEquals(scope.faults, []);
  });
});

Deno.test("registerSecretRefusals: registers every operator and function refusal the inventory yields, synchronously", () => {
  class Custom {}
  const env = environment().registerType("Custom", Custom);
  const builtins = secretCapableBuiltins(env).map((fn) => fn.signature);
  const registration = registerSecretRefusals(env, {
    customTypes: ["Custom"],
  });
  assertEquals(registration.operators, operatorRefusalSignatures(["Custom"]));
  assertEquals(registration.functions, functionRefusalSignatures(builtins));
  runInFaultScope((scope) => {
    const result = env.evaluate("s == 'x' || true", { s });
    assertEquals(result instanceof Promise, false);
    assertEquals(result, true);
    assertEquals(scope.faults, [
      { operation: "Secret == string", code: SECRET_OPERATION_UNSUPPORTED },
    ]);
    assertThrows(() => env.evaluate("size(s)", { s }), SecretRefusal);
  });
});

Deno.test("registerSecretRefusals: refuses swamp's own signatures it is given, without treating them as built-ins", () => {
  const env = environment().registerFunction(
    "literal(string): string",
    (value: string) => value,
    { async: false },
  );
  const registration = registerSecretRefusals(env, {
    swampSignatures: ["literal(string): string"],
  });
  assertEquals(
    registration.functions.filter((signature) =>
      signature.startsWith("literal(")
    ),
    ["literal(Secret): string"],
  );
  runInFaultScope((scope) => {
    assertThrows(() => env.evaluate("literal(s)", { s }), SecretRefusal);
    assertEquals(scope.faults.map((fault) => fault.operation), [
      "literal(Secret): string",
    ]);
  });
});

Deno.test("registerSecretRefusals: codeFor chooses the code a function refusal records, by signature", () => {
  const env = environment();
  env.registerFunction(
    "route(string): string",
    (value: string) => value,
    { async: false },
  );
  env.registerFunction(
    "plain(string): string",
    (value: string) => value,
    { async: false },
  );
  // Both are read from the environment as secret-capable functions.
  registerSecretRefusals(env, {
    codeFor: (signature) =>
      signature.startsWith("route(") ? SECRET_DESTINATION_REFUSED : undefined,
  });
  runInFaultScope((scope) => {
    assertThrows(() => env.evaluate("route(s)", { s }), SecretRefusal);
    assertThrows(() => env.evaluate("plain(s)", { s }), SecretRefusal);
    assertEquals(scope.faults, [
      { operation: "route(Secret): string", code: SECRET_DESTINATION_REFUSED },
      {
        operation: "plain(Secret): string",
        code: SECRET_OPERATION_UNSUPPORTED,
      },
    ]);
  });
});
