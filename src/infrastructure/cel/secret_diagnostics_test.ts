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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { SECRET_OPERATION_UNSUPPORTED } from "../../domain/expressions/errors.ts";
import {
  CONTAINER_COMPARISON_REASON,
  diagnoseSecretMisuse,
} from "./secret_diagnostics.ts";

const AT = "methods.run.arguments.cmd";

function reasons(expression: string): string[] {
  return diagnoseSecretMisuse(expression, AT).map((f) => f.reason);
}

Deno.test("diagnoseSecretMisuse: an operation outside the allowed set on a vault.get result is a type error attributed to the secret", () => {
  const cases: Record<string, string> = {
    "vault.get('v', 'k') == 'x'": "Secret == string",
    "'x' != vault.get('v', 'k')": "string != Secret",
    "size(vault.get('v', 'k'))": "size(Secret)",
    "string(vault.get('v', 'k'))": "string(Secret)",
    "vault.get('v', 'k').startsWith('a')": "Secret.startsWith(string)",
    "int(vault.get('v', 'k')) + 1": "int(Secret)",
  };
  for (const [expression, mention] of Object.entries(cases)) {
    const findings = diagnoseSecretMisuse(expression, AT);
    assertEquals(findings.length, 1, expression);
    assertEquals(findings[0].code, SECRET_OPERATION_UNSUPPORTED, expression);
    assertEquals(findings[0].location.startsWith(`${AT}:1:`), true);
    assertEquals(
      findings[0].reason.includes(mention),
      true,
      findings[0].reason,
    );
  }
});

Deno.test("diagnoseSecretMisuse: the allowed set passes, and so do the pinned cel-js escapes", () => {
  for (
    const expression of [
      "vault.get('v', 'k') + 'x'",
      "'x' + vault.get('v', 'k')",
      "vault.get('v', 'k') + vault.get('v', 'j')",
      "vault.get('v', 'k') == null",
      "vault.get('v', 'k') != null",
      "vault.get('v', 'k') == null ? 'a' : 'b'",
      // A dyn operand escapes the type check; with a scalar literal beside
      // it the container rule has nothing to say either.
      "dyn(vault.get('v', 'k')) == 'x'",
      "inputs.x == 'a' && vault.get('v', 'k') != null",
      // A map literal keyed by the result escapes it too.
      "{vault.get('v', 'k'): 1}",
      // type() checks as valid and reveals nothing.
      "type(vault.get('v', 'k'))",
      // Containers that hold the result are not comparisons.
      "[vault.get('v', 'k')]",
      "{'a': vault.get('v', 'k')}",
      // Legacy bare-token names are literals.
      "vault.get(my-vault, KEY) + '-x'",
    ]
  ) {
    assertEquals(reasons(expression), [], expression);
  }
});

Deno.test("diagnoseSecretMisuse: a type error that names no Secret type is not the secret's", () => {
  for (
    const expression of [
      // has() on a call result fails for its own invalid_macro_argument reason.
      "has(vault.get('v', 'k').x)",
      // An error unrelated to the secret.
      "vault.get('v', 'k') + 'x' + ('a' + 1)",
      "vault.get('v', 'k') == null && size(1)",
    ]
  ) {
    assertEquals(reasons(expression), [], expression);
  }
});

Deno.test("diagnoseSecretMisuse: a container comparison in an expression that calls vault.get is reported, a dyn operand included", () => {
  for (
    const expression of [
      "vault.get('v', 'k') != null && self.item in ['a']",
      "vault.get('v', 'k') != null && inputs.a == self.item",
      "[vault.get('v', 'k')] == [vault.get('v', 'k')]",
      // The type check lets a dyn operand through; the container rule does
      // not, since neither operand is a scalar literal or null, and the run
      // refuses it the same way.
      "inputs.x == vault.get('v', 'k')",
      "self.globalArguments.t == vault.get('v', 'k')",
    ]
  ) {
    const findings = diagnoseSecretMisuse(expression, AT);
    assertEquals(
      findings.map((f) => f.reason),
      [CONTAINER_COMPARISON_REASON],
      expression,
    );
    assertEquals(findings[0].code, SECRET_OPERATION_UNSUPPORTED);
    assertEquals(findings[0].location.startsWith(`${AT}:1:`), true);
  }
  // A scalar comparison beside the call is not a container comparison.
  assertEquals(reasons("vault.get('v', 'k') != null && inputs.a == 'x'"), []);
});

Deno.test("diagnoseSecretMisuse: in and == on the result itself report both the type error and the container rule", () => {
  for (
    const [expression, mention] of [
      ["vault.get('v', 'k') in ['a']", "Secret in list"],
      ["vault.get('v', 'k') == vault.get('v', 'k')", "Secret == Secret"],
    ]
  ) {
    const findings = diagnoseSecretMisuse(expression, AT);
    assertEquals(findings.length, 2, expression);
    assertEquals(findings[0].reason.includes(mention), true, expression);
    assertEquals(findings[1].reason, CONTAINER_COMPARISON_REASON);
  }
});

Deno.test("diagnoseSecretMisuse: an operation the legacy string result would also have refused is still the secret's, since the run refuses it with the secret's code", () => {
  const findings = diagnoseSecretMisuse("vault.get('v', 'k') == 1", AT);
  assertEquals(findings.map((f) => f.code), [SECRET_OPERATION_UNSUPPORTED]);
  assertEquals(findings[0].reason.includes("Secret == int"), true);
});

Deno.test("diagnoseSecretMisuse: the location names the authored path and the first call's line and column", () => {
  const findings = diagnoseSecretMisuse(
    "inputs.a == 'x' &&\n  size(vault.get('v', 'k')) > 1",
    "globalArguments.token",
  );
  assertEquals(findings.map((f) => f.location), [
    "globalArguments.token:2:8",
  ]);
});

Deno.test("diagnoseSecretMisuse: text without a direct vault.get call, an alias, or unparsable text yields nothing", () => {
  for (
    const expression of [
      "inputs.x == 'x'",
      "size(data.latest('m', 'd').attributes.password)",
      "data.latest('m', 'd').attributes.password == 'x'",
      "vault.get('v', 'k'",
      "not cel at all {{",
    ]
  ) {
    assertEquals(reasons(expression), [], expression);
  }
});

Deno.test("diagnoseSecretMisuse: nothing is evaluated, so a function beside the call never runs and no value appears", () => {
  for (
    const expression of [
      "size(model.method('m', 'run', {'p': 1}) + vault.get('v', 'hunter2-key'))",
      "model.method('m', 'run', {'p': 1}) == vault.get('v', 'hunter2-key')",
    ]
  ) {
    const findings = diagnoseSecretMisuse(expression, AT);
    assertEquals(findings.length, 1, expression);
    assertEquals(findings[0].reason.includes("hunter2"), false);
    assertEquals(findings[0].location.includes("hunter2"), false);
  }
});

Deno.test("diagnoseSecretMisuse: a ternary with a Secret branch is an escape, as the evaluator binds the call as dyn", () => {
  for (
    const expression of [
      "inputs.flag ? vault.get('v', 'k') : 'none'",
      "false ? vault.get('v', 'k') : 'none'",
      "inputs.flag ? vault.get('v', 'k') + '-x' : 'none'",
      // What follows the ternary is refused only at run time.
      "(inputs.flag ? vault.get('v', 'k') : 'none') == 'x'",
    ]
  ) {
    assertEquals(reasons(expression), [], expression);
  }
  // A misuse before the ternary is still reported.
  assertEquals(
    reasons("size(vault.get('v', 'k')) > 1 ? vault.get('v', 'j') : 'none'")
      .length,
    1,
  );
});

Deno.test("diagnoseSecretMisuse: indirect vault use is a static error without a direct call", () => {
  for (
    const expression of [
      "dyn(vault).get('v', 'k')",
      "cel.bind(v, vault, v.get('v', 'k'))",
      "vault.get",
    ]
  ) {
    const findings = diagnoseSecretMisuse(
      expression,
      "methods.run.arguments.token",
    );
    assertEquals(findings.length, 1, expression);
    assertEquals(findings[0].code, "invalid_expression");
    assertStringIncludes(
      findings[0].location,
      "methods.run.arguments.token:1:",
    );
    assertStringIncludes(findings[0].reason, "directly");
  }
});

Deno.test("diagnoseSecretMisuse: embedded secret containers are refused but whole fields and scalar results are allowed", () => {
  for (
    const expression of [
      "{'token': vault.get('v', 'k')}",
      "[vault.get('v', 'k')]",
      "{'nested': [vault.get('v', 'k')], 'count': 1}",
      "[vault.get('v', 'k'), 1] + ['public']",
      "dyn({'token': vault.get('v', 'k')})",
      "inputs.flag ? {'token': vault.get('v', 'k')} : {}",
    ]
  ) {
    assertEquals(diagnoseSecretMisuse(expression, AT), [], expression);
    const findings = diagnoseSecretMisuse(expression, AT, true);
    assertEquals(findings.length, 1, expression);
    assertEquals(findings[0].code, SECRET_OPERATION_UNSUPPORTED);
    assertEquals(
      findings[0].reason,
      "interpolating a container holding a secret into text",
    );
  }
  for (
    const expression of [
      "vault.get('v', 'k')",
      "'prefix-' + vault.get('v', 'k')",
      "size([vault.get('v', 'k')])",
      "{'count': size([vault.get('v', 'k')])}",
      "{'isNull': vault.get('v', 'k') == null}",
      "{'token': vault.get('v', 'k')}.token",
      "false ? {'token': vault.get('v', 'k')} : {}",
    ]
  ) {
    assertEquals(diagnoseSecretMisuse(expression, AT, true), [], expression);
  }
});
