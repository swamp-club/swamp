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
import { CalVer } from "./calver.ts";

const arbCanonical = fc
  .record({
    date: fc.date({
      min: new Date(Date.UTC(1000, 0, 1)),
      max: new Date(Date.UTC(9999, 11, 31)),
      noInvalidDate: true,
    }),
    micro: fc.nat({ max: 2_000_000_000 }),
  })
  .map(({ date, micro }) =>
    [
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
      String(micro + 1),
    ].join(".")
  );

Deno.test("CalVer.fromUserInput: a canonical version reads back unchanged", () => {
  fc.assert(
    fc.property(arbCanonical, (version) => {
      assertEquals(CalVer.isValid(version), true);
      assertEquals(CalVer.fromUserInput(version).value, version);
    }),
  );
});

Deno.test("CalVer.fromUserInput: a v-prefixed canonical version reads back as the bare version", () => {
  fc.assert(
    fc.property(arbCanonical, fc.constantFrom("v", "V"), (version, prefix) => {
      assertEquals(CalVer.fromUserInput(`${prefix}${version}`).value, version);
    }),
  );
});

Deno.test("CalVer.fromUserInput: an unpadded month and day pad to the canonical version", () => {
  fc.assert(
    fc.property(arbCanonical, (version) => {
      const [year, month, day, micro] = version.split(".");
      const unpadded = [year, String(Number(month)), String(Number(day)), micro]
        .join(".");
      assertEquals(CalVer.fromUserInput(unpadded).value, version);
    }),
  );
});
