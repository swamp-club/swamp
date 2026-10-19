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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { Optional } from "cel-js";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { SecretBoundary } from "./secret_boundary.ts";
import {
  composeSecrets,
  isSecret,
  type Secret,
  vaultReferenceSecret,
} from "./secret_value.ts";

/** Text that may itself look like a sentinel under a prefix of no bag. */
const text = fc.oneof(
  fc.string(),
  fc.stringMatching(/^[0-9a-f]{32}$/).map((prefix) =>
    `__SWAMP_VSEC_${prefix}_3__`
  ),
);

/** A run whose bag issued `count` vault references. */
function run(count: number): { bag: VaultSecretBag; sentinels: string[] } {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinels = Array.from(
    { length: count },
    (_, i) => bag.addSecret({ vaultName: "v", key: `k${i}` }, `loc${i}`),
  );
  return { bag, sentinels };
}

Deno.test("SecretBoundary: text bound in and released out round-trips, sentinels of the run and all", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(text, fc.nat({ max: 2 })), { maxLength: 8 }),
      (pieces) => {
        const { bag, sentinels } = run(3);
        const original = pieces.map((piece) =>
          typeof piece === "number" ? sentinels[piece] : piece
        ).join("");
        const boundary = new SecretBoundary(bag);
        const bound = boundary.bind({ v: original }).v;
        // Text holds a Secret exactly when it holds one of the run's sentinels.
        assertEquals(
          isSecret(bound),
          sentinels.some((sentinel) => original.includes(sentinel)),
        );
        assertEquals(boundary.release(bound), original);
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("SecretBoundary: a released composition is the concatenation of its released operands", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string(), fc.nat({ max: 2 })), {
        minLength: 1,
        maxLength: 6,
      }),
      (pieces) => {
        const { bag } = run(0);
        const boundary = new SecretBoundary(bag);
        const secrets = [0, 1, 2].map((i) =>
          vaultReferenceSecret({ vaultName: "v", key: `k${i}` }, `loc${i}`)
        );
        const operands: (Secret | string)[] = pieces.map((piece) =>
          typeof piece === "number" ? secrets[piece] : piece
        );
        const released = operands.map((operand) => boundary.release(operand));
        if (operands.every((operand) => typeof operand === "string")) return;
        const composed = operands.reduce((a, b) =>
          typeof a === "string" && typeof b === "string"
            ? a + b
            : composeSecrets(a, b)
        );
        assertEquals(boundary.release(composed), released.join(""));
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("SecretBoundary: each reference with no sentinel is issued a sentinel of its own, unique in the run", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 12 }), (count) => {
      const { bag } = run(2);
      const boundary = new SecretBoundary(bag);
      const released = Array.from(
        { length: count },
        (_, i) =>
          boundary.release(
            vaultReferenceSecret({ vaultName: "v", key: `n${i}` }, "loc"),
          ) as string,
      );
      assertEquals(new Set(released).size, count);
      for (const sentinel of released) {
        assert(bag.registry.issuedEntryOf(sentinel) !== undefined);
      }
    }),
    { numRuns: 50 },
  );
});

Deno.test("SecretBoundary: structures round-trip, with Optionals at any depth", () => {
  const { bag, sentinels } = run(2);
  const value = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: "small" },
      text,
      fc.constantFrom(...sentinels),
      fc.array(tie("node"), { maxLength: 3 }),
      fc.dictionary(fc.string(), tie("node"), { maxKeys: 3 }),
    ),
  })).node;
  fc.assert(
    fc.property(value, (original) => {
      const boundary = new SecretBoundary(bag);
      const bound = boundary.bind({ v: original }).v;
      assertEquals(boundary.release(bound), original);
      const optional = boundary.release(Optional.of(bound)) as Optional;
      assertEquals(optional.value(), original);
    }),
    { numRuns: 200 },
  );
});
