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
import { assembleDataGetContent, contentPieces } from "./data_get_parts.ts";

// strings mixing astral characters, lone surrogates and escapes
const text = fc.string({ unit: fc.oneof(fc.fullUnicode(), fc.char16bits()) });

Deno.test("data get parts: the pieces of any content reassemble to it over JSON, for any slice size", () => {
  fc.assert(
    fc.property(text, fc.integer({ min: 1, max: 64 }), (content, chars) => {
      const pieces = [...contentPieces(content, chars)];
      for (const piece of pieces) {
        assertEquals(piece.length > 0, true);
        assertEquals(piece.length <= chars, true);
      }
      const parts = JSON.parse(
        JSON.stringify(pieces.map((piece) => ({ content: piece }))),
      );
      assertEquals(
        assembleDataGetContent(parts, pieces.length, content.length),
        content,
      );
    }),
  );
});
