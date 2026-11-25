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
import { clearEmptyPlacement, type ResolvedPlacement } from "./placement.ts";

const valueArb = fc.constantFrom("", " ", "w1", "linux", "gpu");
const placementArb: fc.Arbitrary<ResolvedPlacement> = fc.record(
  {
    target: valueArb,
    platform: valueArb,
    labels: fc.dictionary(fc.constantFrom("host", "pool", "env"), valueArb),
    queueTimeoutMs: fc.nat(),
  },
  { requiredKeys: [] },
);

Deno.test("clearEmptyPlacement: a cleared placement never holds an empty value, and clearing again changes nothing", () => {
  fc.assert(
    fc.property(placementArb, (placement) => {
      const { placement: cleared } = clearEmptyPlacement(placement);
      if (cleared === undefined) return;
      assert(cleared.target !== "");
      assert(cleared.platform !== "");
      assert(Object.values(cleared.labels ?? {}).every((value) => value));
      assert(
        cleared.target !== undefined || cleared.platform !== undefined ||
          Object.keys(cleared.labels ?? {}).length > 0,
      );
      assertEquals(clearEmptyPlacement(cleared), {
        placement: cleared,
        cleared: [],
      });
    }),
  );
});

Deno.test("clearEmptyPlacement: every non-empty value survives and every empty one is named", () => {
  fc.assert(
    fc.property(placementArb, (placement) => {
      const { placement: kept, cleared } = clearEmptyPlacement(placement);
      const expected = [
        ...(placement.target === "" ? ["target"] : []),
        ...(placement.platform === "" ? ["platform"] : []),
        ...Object.entries(placement.labels ?? {})
          .filter(([, value]) => value === "")
          .map(([key]) => `labels.${key}`),
      ];
      assertEquals([...cleared].sort(), expected.sort());
      for (const [key, value] of Object.entries(placement.labels ?? {})) {
        if (value !== "") assertEquals(kept?.labels?.[key], value);
      }
      if (placement.target) assertEquals(kept?.target, placement.target);
      if (placement.platform) assertEquals(kept?.platform, placement.platform);
    }),
  );
});
