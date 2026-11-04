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

import { assertEquals, assertMatch } from "@std/assert";
import fc from "fast-check";
import { coerceToSuffix } from "./data_suffix.ts";

const unnamedObject = fc.dictionary(
  fc.string().filter((k) => !["key", "name", "id"].includes(k)),
  fc.jsonValue(),
  { minKeys: 1 },
);

Deno.test("coerceToSuffix: an object without key, name or id always yields a 16-hex suffix", () => {
  fc.assert(
    fc.property(unnamedObject, (obj) => {
      assertMatch(coerceToSuffix(obj), /^[0-9a-f]{16}$/);
    }),
  );
});

Deno.test("coerceToSuffix: the hash suffix does not depend on key order", () => {
  fc.assert(
    fc.property(unnamedObject, (obj) => {
      const reversed = Object.fromEntries(Object.entries(obj).reverse());
      assertEquals(coerceToSuffix(reversed), coerceToSuffix(obj));
    }),
  );
});
