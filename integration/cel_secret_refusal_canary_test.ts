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

// Typed-secrets refusals carry no value (design/enablers/typed-secrets.md
// Section 4, typed-secrets 3.1). A Secret holds no value, so the canaries go
// where a value can still be: a data-origin bag entry that holds its value
// until Phase 4, a non-secret operand of the refused operation, and the text
// parts of a composition. Each is bound into the expression, never written
// into it, because a refusal names the expression. The CelEvaluator, the
// run's bag registry and the canary classes are wired together in-process.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { SecretRefusedError } from "../src/domain/expressions/errors.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import { type Canary, generateCanaries } from "./canary_values.ts";

/** Every form a value could take in error text: raw, escaped, encoded. */
function forms(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    btoa(String.fromCharCode(...new TextEncoder().encode(value))),
  ];
}

/** Everything an error shows: its fields, its cause chain and its inspection. */
function errorText(error: SecretRefusedError): string {
  const parts: string[] = [
    error.message,
    error.code,
    error.operation,
    error.expression,
    Deno.inspect(error, { depth: 10 }),
    JSON.stringify(error),
  ];
  let cause: unknown = error.cause;
  while (cause !== undefined) {
    parts.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join("\n");
}

const REFUSED = [
  "inputs.secret == inputs.other",
  "inputs.other == inputs.secret",
  "inputs.secret == inputs.other || true",
  "inputs.mixed == inputs.other",
  "inputs.mixed < inputs.other",
  "size(inputs.mixed)",
  "inputs.other.contains(inputs.secret)",
  "inputs.mixed.all(x, true) || true",
  "inputs.secret in [inputs.other]",
  "inputs.rec.password in [inputs.other, inputs.mixed]",
  "data.latest(inputs.other, 'd', [inputs.mixed])",
  "model.method('m', 'n', {'p': inputs.mixed, 'q': inputs.other})",
];

Deno.test("CelEvaluator typed secrets: no refusal carries a canary, in any form, whatever the operands hold", () => {
  const evaluator = new CelEvaluator({ typedSecrets: true });
  const canaries = generateCanaries().filter((canary) => canary.unique);
  assert(canaries.length > 0);
  for (const canary of canaries) {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const secret = bag.addDataSecret(canary.value, {
      vaultName: "prod",
      key: "PASSWORD",
    });
    const context = {
      inputs: {
        secret,
        other: canary.value,
        mixed: `${canary.value}:${secret}:${canary.value}`,
        rec: { password: secret },
      },
      data: { latest: () => null },
      modelMethod: { method: () => null },
    };
    for (const expression of REFUSED) {
      const error = assertThrows(
        () => evaluator.evaluate(expression, context, { secretBag: bag }),
        SecretRefusedError,
        undefined,
        `${canary.class}: ${expression}`,
      );
      assertNoCanary(errorText(error), canary, expression);
    }
  }
});

Deno.test("CelEvaluator typed secrets: a released composition carries its text parts and a sentinel, never the entry's value", () => {
  const evaluator = new CelEvaluator({ typedSecrets: true });
  for (const canary of generateCanaries().filter((c) => c.unique)) {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const secret = bag.addDataSecret(canary.value, {
      vaultName: "prod",
      key: "PASSWORD",
    });
    const result = evaluator.evaluate(
      "'user:' + inputs.secret",
      { inputs: { secret } },
      { secretBag: bag },
    );
    assertEquals(result, `user:${secret}`, canary.class);
  }
});

function assertNoCanary(text: string, canary: Canary, expression: string) {
  for (const form of forms(canary.value)) {
    assert(
      !text.includes(form),
      `${canary.class}: the refusal of ${expression} carries the canary`,
    );
  }
}
