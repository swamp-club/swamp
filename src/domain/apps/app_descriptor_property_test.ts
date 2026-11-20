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
import { capabilityKey } from "./app_descriptor.ts";

const names = fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 });

Deno.test("capabilityKey: order and repeats never change it", () => {
  fc.assert(
    fc.property(names, names, (capabilities, run) => {
      const shuffled = {
        capabilities: [...capabilities, ...capabilities].reverse(),
        run: [...run].reverse(),
      };
      assertEquals(
        capabilityKey({ capabilities, run }, "local"),
        capabilityKey(shuffled, "local"),
      );
    }),
  );
});

Deno.test("capabilityKey: distinct sets never share a key", () => {
  fc.assert(
    fc.property(names, names, (a, b) => {
      const same = new Set(a).size === new Set(b).size &&
        a.every((value) => b.includes(value));
      assertEquals(
        capabilityKey({ capabilities: a, run: [] }, "local") ===
          capabilityKey({ capabilities: b, run: [] }, "local"),
        same,
      );
    }),
  );
});
