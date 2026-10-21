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

import fc from "fast-check";
import { assertEquals } from "@std/assert";
import { RunSensitiveValues } from "../secrets/run_sensitive_values.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { forEachNameWithoutSecrets } from "./persisted_workflow.ts";

/**
 * forEachNameWithoutSecrets (typed-secrets 4.1): whatever text surrounds
 * them, every sentinel the run issued becomes sensitive-<index>, text outside
 * the sentinels is kept, sentinel-shaped text of another prefix is left
 * alone, and the stand-in is the same whether the secret arrived as a
 * sentinel (typed run) or as a recorded value (untyped run).
 */

const plainText = fc.stringMatching(/^[a-z0-9-]{0,12}$/);
const otherSentinel = fc.hexaString({ minLength: 32, maxLength: 32 }).map(
  (prefix) => `__SWAMP_VSEC_${prefix}_0__`,
);

Deno.test("forEachNameWithoutSecrets: property: sentinels become the index, other text survives", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(plainText, fc.boolean()), { maxLength: 6 }),
      otherSentinel,
      fc.nat({ max: 50 }),
      (parts, other, index) => {
        const registry = new SecretBagRegistry({ typedSecrets: true });
        const values = new RunSensitiveValues(undefined, registry);
        const bag = new VaultSecretBag(registry);
        let name = "";
        let expected = "";
        parts.forEach(([text, secret], i) => {
          name += text;
          expected += text;
          if (secret) {
            name += bag.addSecret({ vaultName: "v", key: `k${i}` }, "in");
            expected += `sensitive-${index}`;
          }
        });
        name += other;
        expected += other;
        assertEquals(forEachNameWithoutSecrets(name, index, values), expected);
      },
    ),
  );
});

Deno.test("forEachNameWithoutSecrets: property: a sentinel and a recorded value of the same secret give the same name", () => {
  fc.assert(
    fc.property(
      plainText,
      fc.stringMatching(/^[A-Za-z0-9]{3,16}$/),
      plainText,
      fc.nat({ max: 50 }),
      (before, secret, after, index) => {
        const typedRegistry = new SecretBagRegistry({ typedSecrets: true });
        const typed = new RunSensitiveValues(undefined, typedRegistry);
        const sentinel = new VaultSecretBag(typedRegistry).addSecret(
          { vaultName: "v", key: "k" },
          "in",
        );
        const untyped = new RunSensitiveValues();
        untyped.addSecret(secret, { vaultName: "v", key: "k" });
        assertEquals(
          forEachNameWithoutSecrets(
            `${before}${sentinel}${after}`,
            index,
            typed,
          ),
          forEachNameWithoutSecrets(
            `${before}${secret}${after}`,
            index,
            untyped,
          ),
        );
      },
    ),
  );
});
