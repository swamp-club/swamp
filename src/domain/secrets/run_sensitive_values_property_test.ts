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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { RunSensitiveValues } from "./run_sensitive_values.ts";
import { SecretRedactor } from "./secret_redactor.ts";

const REF = { vaultName: "v", key: "k" };

Deno.test("RunSensitiveValues: in a typed run a registered sentinel is masked and stood in for whatever its value, with no value read", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 12 }),
      fc.string({ maxLength: 6 }),
      fc.string({ maxLength: 6 }),
      fc.constantFrom("vault", "data", "legacy"),
      (value, before, after, origin) => {
        const registry = new SecretBagRegistry();
        const redactor = new SecretRedactor();
        const values = new RunSensitiveValues(redactor, registry);
        const bag = new VaultSecretBag(registry);
        // The value is the key, so a stand-in can be checked without any load.
        const reference = { vaultName: "v", key: value === "" ? "k" : value };
        const sentinel = origin === "vault"
          ? bag.addSecret(reference, "loc")
          : origin === "data"
          ? bag.addDataReference(reference, "db/main.f")
          : bag.addDataSecret(value, reference);
        const text = `${before}${sentinel}${after}`;
        // Masks never depend on the length or contents of a value.
        assertEquals(values.masked(text), `${before}***${after}`);
        assertEquals(redactor.redact(text), `${before}***${after}`);
        assertEquals(
          values.withPlaceholders(text),
          `${before}${values.placeholderFor(reference)}${after}`,
        );
      },
    ),
  );
});

Deno.test("RunSensitiveValues: sentinel-shaped text the run did not issue is kept", () => {
  fc.assert(
    fc.property(
      fc.hexaString({ minLength: 32, maxLength: 32 }),
      fc.nat({ max: 99 }),
      (prefix, n) => {
        const registry = new SecretBagRegistry();
        new VaultSecretBag(registry).addSecret(REF, "loc");
        const values = new RunSensitiveValues(undefined, registry);
        const text = `a __SWAMP_VSEC_${prefix}_${n}__ b`;
        assertEquals(values.masked(text), text);
        assertEquals(values.withPlaceholders(text), text);
      },
    ),
  );
});
