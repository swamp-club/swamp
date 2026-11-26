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
import {
  effectiveWorkerLabels,
  type MaxEnrollments,
  type TokenLabelSource,
  tokenSuppliedLabels,
  workerLabelRefusal,
} from "./enrollment_token_model.ts";

// a small key space so offered, bound and reserved keys collide often
const arbKey = fc.constantFrom("fleet", "region", "gpu", "tier", "zone");
const arbValue = fc.constantFrom("a", "b", "pool", "eu", "true");
const arbLabels = fc.dictionary(arbKey, arbValue, { maxKeys: 5 });
const arbMaxEnrollments: fc.Arbitrary<MaxEnrollments> = fc.oneof(
  fc.constant(1),
  fc.integer({ min: 2, max: 5 }),
  fc.constant("unlimited" as const),
);
const arbToken: fc.Arbitrary<TokenLabelSource> = fc.record({
  name: fc.constantFrom("pool", "a", "b"),
  maxEnrollments: arbMaxEnrollments,
  labels: fc.option(arbLabels, { nil: undefined }),
});
const arbReserved = fc.uniqueArray(arbKey, { maxLength: 5 });

function legacyInjection(
  name: string,
  maxEnrollments: MaxEnrollments,
  offered: Record<string, string>,
): Record<string, string> {
  const labels = { ...offered };
  if (maxEnrollments !== 1 && labels.fleet === undefined) labels.fleet = name;
  return labels;
}

Deno.test("effectiveWorkerLabels: carries every bound label exactly", () => {
  fc.assert(
    fc.property(arbToken, arbLabels, (token, offered) => {
      const labels = effectiveWorkerLabels(token, offered);
      for (const [key, value] of Object.entries(token.labels ?? {})) {
        assertEquals(labels[key], value);
      }
    }),
  );
});

Deno.test("effectiveWorkerLabels: with nothing bound it equals the old fleet injection", () => {
  fc.assert(
    fc.property(
      arbToken,
      arbLabels,
      (token, offered) => {
        const unbound = { ...token, labels: undefined };
        assertEquals(
          effectiveWorkerLabels(unbound, offered),
          legacyInjection(token.name, token.maxEnrollments, offered),
        );
        assertEquals(workerLabelRefusal(unbound, offered, []), undefined);
      },
    ),
  );
});

Deno.test("workerLabelRefusal: refuses exactly when a bound or reserved key differs from what the token supplies", () => {
  fc.assert(
    fc.property(
      arbToken,
      arbLabels,
      arbReserved,
      (token, offered, reserved) => {
        const bound = token.labels ?? {};
        const supplied = tokenSuppliedLabels(token);
        const violates = Object.entries(offered).some(([key, value]) =>
          Object.hasOwn(bound, key)
            ? bound[key] !== value
            : reserved.includes(key) && supplied[key] !== value
        );
        assertEquals(
          workerLabelRefusal(token, offered, reserved) !== undefined,
          violates,
        );
      },
    ),
  );
});

Deno.test("workerLabelRefusal: an accepted worker carries only token-supplied values on reserved keys", () => {
  fc.assert(
    fc.property(
      arbToken,
      arbLabels,
      arbReserved,
      (token, offered, reserved) => {
        if (workerLabelRefusal(token, offered, reserved) !== undefined) return;
        const labels = effectiveWorkerLabels(token, offered);
        const supplied = tokenSuppliedLabels(token);
        for (const key of reserved) {
          assertEquals(labels[key], supplied[key]);
        }
      },
    ),
  );
});
