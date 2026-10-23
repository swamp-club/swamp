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
import { z } from "zod";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { secretOccurrencesOf } from "../vaults/secret_occurrences.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  refuseSecretsInRefusingFields,
  SecretDestinationRefusedError,
} from "./secret_destinations.ts";

const REF = { vaultName: "v", key: "k" };

/** Refusing fields inside list elements and record values, beside a free one. */
const schema = z.object({
  items: z.array(
    z.object({ x: z.string().meta({ secrets: "refuse" }), y: z.string() }),
  ),
  labels: z.record(z.string(), z.string().meta({ secrets: "refuse" })),
  free: z.string(),
});

type Args = z.infer<typeof schema>;

const arbText = fc.string({ maxLength: 8 });
const arbArgs: fc.Arbitrary<Args> = fc.record({
  items: fc.array(fc.record({ x: arbText, y: arbText }), { maxLength: 3 }),
  labels: fc.dictionary(fc.constantFrom("a", "b", "c", "d"), arbText, {
    maxKeys: 3,
  }),
  free: arbText,
});

interface Slot {
  refusing: boolean;
  set: (args: Args, value: string) => void;
}

/** Every string slot of `args`, saying whether its field refuses secrets. */
function slotsOf(args: Args): Slot[] {
  const slots: Slot[] = [{ refusing: false, set: (a, v) => a.free = v }];
  args.items.forEach((_, i) => {
    slots.push({ refusing: true, set: (a, v) => a.items[i].x = v });
    slots.push({ refusing: false, set: (a, v) => a.items[i].y = v });
  });
  for (const key of Object.keys(args.labels)) {
    slots.push({ refusing: true, set: (a, v) => a.labels[key] = v });
  }
  return slots;
}

Deno.test("refuseSecretsInRefusingFields: a sentinel under a refusing path always refuses, anywhere else never, whatever surrounds it", () => {
  fc.assert(
    fc.property(
      arbArgs,
      fc.nat(),
      arbText,
      arbText,
      fc.boolean(),
      (args, pick, before, after, dataOrigin) => {
        const registry = new SecretBagRegistry();
        const bag = new VaultSecretBag(registry);
        const sentinel = dataOrigin
          ? bag.addDataReference(REF, "db/main.password")
          : bag.addSecret(REF, "methods.run.arguments.x");
        const slots = slotsOf(args);
        const slot = slots[pick % slots.length];
        const target = structuredClone(args);
        slot.set(target, `${before}${sentinel}${after}`);
        const secrets = secretOccurrencesOf(registry);
        if (slot.refusing) {
          const error = assertThrows(
            () =>
              refuseSecretsInRefusingFields(
                schema,
                target,
                secrets,
                "method argument",
              ),
            SecretDestinationRefusedError,
          );
          assertEquals(error.message.includes(sentinel), false);
          assertEquals(error.reference, REF);
        } else {
          refuseSecretsInRefusingFields(
            schema,
            target,
            secrets,
            "method argument",
          );
        }
      },
    ),
  );
});

Deno.test("refuseSecretsInRefusingFields: sentinel-shaped text the run did not issue never refuses", () => {
  fc.assert(
    fc.property(
      arbArgs,
      fc.nat(),
      fc.hexaString({ minLength: 32, maxLength: 32 }),
      fc.nat({ max: 99 }),
      (args, pick, prefix, n) => {
        const registry = new SecretBagRegistry();
        new VaultSecretBag(registry).addSecret(REF, "loc");
        const slots = slotsOf(args);
        const target = structuredClone(args);
        slots[pick % slots.length].set(
          target,
          `__SWAMP_VSEC_${prefix}_${n}__`,
        );
        refuseSecretsInRefusingFields(
          schema,
          target,
          secretOccurrencesOf(registry),
          "method argument",
        );
      },
    ),
  );
});
