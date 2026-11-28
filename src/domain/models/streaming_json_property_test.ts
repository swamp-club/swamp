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
import { StreamingJson } from "./streaming_json.ts";

// lone and paired surrogates, escapes and multi-byte characters, often enough
// to land on a slice edge
const unit = fc.oneof(
  fc.constantFrom(
    "\ud83d",
    "\ude00",
    "😀",
    "\ud800",
    "\udfff",
    '"',
    "\\",
    "\n",
    "\u0000",
    "\u001f",
    " ",
    "é",
    "€",
    "a",
  ),
  fc.fullUnicode(),
  fc.char16bits(),
);
const text = fc.array(unit, { maxLength: 24 }).map((units) => units.join(""));

const { value } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    text,
    fc.double(),
    fc.constantFrom(-0, NaN, Infinity, -Infinity, 0, null, true, false),
    fc.constant(undefined),
    fc.constant(() => 1),
    fc.constant(Symbol("s")),
    fc.date({ noInvalidDate: false }),
    text.map((s) => new String(s)),
    fc.double().map((n) => new Number(n)),
    fc.boolean().map((b) => new Boolean(b)),
    fc.sparseArray(tie("value"), { maxLength: 6 }),
    fc.array(tie("value"), { maxLength: 6 }),
    fc.dictionary(text, tie("value"), { maxKeys: 6 }),
    // toJSON is called with the key it is reached by
    tie("value").map((inner) => ({
      toJSON: (key: string) => [key, inner],
    })),
  ),
}));

async function bytesOf(json: StreamingJson): Promise<Uint8Array> {
  return await new Response(ReadableStream.from(json.chunks())).bytes();
}

Deno.test("StreamingJson: writes exactly the bytes JSON.stringify encodes to, and counts them, for any value and slice size", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.dictionary(text, value, { maxKeys: 6 }),
      fc.integer({ min: 0, max: 8 }),
      fc.integer({ min: 1, max: 9 }),
      async (data, longStringUnits, sliceUnits) => {
        const expected = new TextEncoder().encode(JSON.stringify(data));
        const json = StreamingJson.resolve(data, {
          longStringUnits,
          sliceUnits,
        });
        assertEquals(await bytesOf(json), expected);
        assertEquals(json.byteLength(), expected.length);
        if (!json.streams) assertEquals(json.bytes(), expected);
      },
    ),
    { numRuns: 3000 },
  );
});
