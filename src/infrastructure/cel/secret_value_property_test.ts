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

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  composeSecrets,
  type Secret,
  type SecretPart,
  secretParts,
  vaultReferenceSecret,
} from "./secret_value.ts";

/** A secret or text operand of a concatenation. */
const operand: fc.Arbitrary<Secret | string> = fc.oneof(
  fc.string(),
  fc.record({ vaultName: fc.string(), key: fc.string() }).map((reference) =>
    vaultReferenceSecret(reference, "loc")
  ),
);

/** `+` as CEL dispatches it: text with text is the built-in, else composition. */
function concat(a: Secret | string, b: Secret | string): Secret | string {
  return typeof a === "string" && typeof b === "string"
    ? a + b
    : composeSecrets(a, b);
}

/** The parts an operand stands for, as a flat list of text and references. */
function flatten(values: readonly (Secret | string)[]): SecretPart[] {
  return values.flatMap((value) =>
    typeof value === "string" ? [value] : [...secretParts(value)!]
  );
}

/** Adjacent text joined and empty text dropped, as a Secret keeps parts. */
function normalize(parts: readonly SecretPart[]): SecretPart[] {
  const out: SecretPart[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (typeof part === "string") {
      if (part === "") continue;
      if (typeof last === "string") out[out.length - 1] = last + part;
      else out.push(part);
    } else out.push(part);
  }
  return out;
}

Deno.test("composeSecrets: any concatenation holds the operands' parts in order, whatever the grouping", () => {
  fc.assert(
    fc.property(
      fc.array(operand, { minLength: 1, maxLength: 6 }),
      operand,
      (rest, first) => {
        const operands = [first, ...rest];
        if (operands.every((value) => typeof value === "string")) return;
        // Left to right, and right to left: concatenation is associative.
        const left = operands.reduce(concat);
        const right = operands.reduceRight((b, a) => concat(a, b));
        const expected = normalize(flatten(operands));
        if (typeof left !== "string") {
          assertEquals(secretParts(left), expected);
        }
        if (typeof right !== "string") {
          assertEquals(secretParts(right), expected);
        }
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("Secret: every composition refuses to be cloned or stringified", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (before, after) => {
      const reference = { vaultName: "v", key: "k" };
      const secret = composeSecrets(
        composeSecrets(before, vaultReferenceSecret(reference, "l")),
        after,
      );
      assertThrows(() => structuredClone(secret));
      assertThrows(() => JSON.stringify(secret));
      assertThrows(() => String(secret));
      assertThrows(() => Object.keys(secret));
    }),
    { numRuns: 100 },
  );
});
