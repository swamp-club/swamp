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
import { jsonStringChunks, prettyJsonChunks } from "./json_stream.ts";

Deno.test("prettyJsonChunks: always joins to JSON.stringify(value, null, 2)", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    assertEquals(
      [...prettyJsonChunks(value)].join(""),
      JSON.stringify(value, null, 2),
    );
  }));
});

// full code units, so lone surrogates and pairs land on every slice boundary
const anyString = fc.string({ unit: "binary", maxLength: 40 });

Deno.test("jsonStringChunks: always joins to JSON.stringify at any slice size", () => {
  fc.assert(
    fc.property(anyString, fc.integer({ min: 2, max: 8 }), (text, slice) => {
      assertEquals(
        [...jsonStringChunks(text, slice)].join(""),
        JSON.stringify(text),
      );
    }),
  );
});

Deno.test("prettyJsonChunks: with any slice size, always joins to JSON.stringify(value, null, 2)", () => {
  const value = fc.jsonValue({ maxDepth: 3, stringUnit: "binary" });
  fc.assert(
    fc.property(value, fc.integer({ min: 2, max: 8 }), (v, slice) => {
      assertEquals(
        [...prettyJsonChunks(v, slice)].join(""),
        JSON.stringify(v, null, 2),
      );
    }),
  );
});
