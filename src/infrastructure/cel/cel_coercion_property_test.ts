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
import { coerceBigInts, coerceBigIntsShared } from "./cel_coercion.ts";

const leaf = fc.oneof(
  fc.jsonValue({ maxDepth: 0 }),
  fc.bigInt(),
  fc.date({ noInvalidDate: true }),
  fc.uint8Array({ maxLength: 8 }),
);
const value = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("node"), { maxKeys: 4 }),
  ),
})).node;

Deno.test("coerceBigIntsShared: serializes exactly as coerceBigInts for any value", () => {
  fc.assert(
    fc.property(value, (v) => {
      const toJson = (x: unknown) =>
        JSON.stringify(x, (_k, y) => typeof y === "bigint" ? `${y}n` : y);
      assertEquals(toJson(coerceBigIntsShared(v)), toJson(coerceBigInts(v)));
    }),
  );
});

Deno.test("coerceBigIntsShared: returns the input itself when coerceBigInts would change nothing", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (v) => {
      assertEquals(coerceBigIntsShared(v) === v, true);
    }),
  );
});
