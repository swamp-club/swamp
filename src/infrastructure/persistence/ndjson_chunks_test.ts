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
import { chunkEnd } from "./ndjson_chunks.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

function decodeAll(content: Uint8Array, chunkBytes: number): string[] {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (let at = 0; at < content.length;) {
    const end = chunkEnd(content, at, chunkBytes);
    chunks.push(decoder.decode(content.subarray(at, end)));
    at = end;
  }
  return chunks;
}

Deno.test("chunkEnd: ends each chunk after a newline", () => {
  const chunks = decodeAll(bytes("aa\nbb\ncc\n"), 4);
  assertEquals(chunks, ["aa\n", "bb\n", "cc\n"]);
});

Deno.test("chunkEnd: a line longer than the chunk is decoded whole", () => {
  const chunks = decodeAll(bytes("a\nbbbbbbbb\nc"), 3);
  assertEquals(chunks, ["a\n", "bbbbbbbb\n", "c"]);
});

Deno.test("chunkEnd: never splits a multibyte character", () => {
  const text = "é€\n€é\n😀😀\n";
  const chunks = decodeAll(bytes(text), 5);
  assertEquals(chunks.join(""), text);
  for (const chunk of chunks) assertEquals(chunk.includes("�"), false);
});
