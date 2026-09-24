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
import { encodeContent, type EncodedContent } from "./content_encoding.ts";

const BOM = [0xef, 0xbb, 0xbf];

function decode(encoded: EncodedContent): Uint8Array {
  return encoded.contentEncoding === "base64"
    ? Uint8Array.fromBase64(encoded.content)
    : new TextEncoder().encode(encoded.content);
}

function startsWithBom(bytes: Uint8Array): boolean {
  return BOM.every((b, i) => bytes[i] === b);
}

Deno.test("encodeContent property: any bytes decode back to the input", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
      const encoded = encodeContent(bytes);
      // utf-8 text drops a leading byte-order mark; base64 keeps every byte.
      const expected =
        encoded.contentEncoding === "utf-8" && startsWithBom(bytes)
          ? bytes.subarray(BOM.length)
          : bytes;
      assertEquals(decode(encoded), expected);
    }),
  );
});

Deno.test("encodeContent property: UTF-8 text is returned as the same utf-8 text", () => {
  fc.assert(
    fc.property(
      // Whole code points only (no lone surrogates, which TextEncoder would
      // replace), and no leading U+FEFF, which the decoder drops as a BOM.
      fc.string({ unit: "grapheme", maxLength: 128 }).filter((s) =>
        !s.startsWith("﻿")
      ),
      (text) => {
        assertEquals(encodeContent(new TextEncoder().encode(text)), {
          content: text,
          contentEncoding: "utf-8",
        });
      },
    ),
  );
});

Deno.test("encodeContent property: bytes that are not valid UTF-8 are base64", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 256 }),
      fc.nat(),
      fc.constantFrom(0x80, 0xbf, 0xc0, 0xc1, 0xf5, 0xff),
      (bytes, position, invalid) => {
        // 0x80/0xbf are continuation bytes with no lead byte; the others can
        // never appear in UTF-8. Placed right after an ASCII byte (or at the
        // start), each one makes the buffer invalid wherever it is.
        const at = bytes.length === 0 ? 0 : position % bytes.length;
        const withInvalid = new Uint8Array([
          ...bytes.subarray(0, at),
          0x41,
          invalid,
          ...bytes.subarray(at),
        ]);
        const encoded = encodeContent(withInvalid);
        assertEquals(encoded.contentEncoding, "base64");
        assertEquals(Uint8Array.fromBase64(encoded.content), withInvalid);
      },
    ),
  );
});
