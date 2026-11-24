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
import { join } from "@std/path";
import fc from "fast-check";
import { atomicWriteTextFileChunked } from "./atomic_write.ts";

const loneSurrogate = fc.integer({ min: 0xd800, max: 0xdfff }).map((unit) =>
  String.fromCharCode(unit)
);

const unicodeText = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.string({ unit: "binary-ascii" }),
  fc.string({
    unit: fc.oneof(fc.constantFrom("a", "é", "€", "\u{1f680}"), loneSurrogate),
  }),
);

Deno.test("atomicWriteTextFileChunked: writes the bytes TextEncoder encodes, at any chunk size", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-atomic-write-prop-" });
  try {
    const path = join(dir, "record.txt");
    await fc.assert(
      fc.asyncProperty(
        unicodeText,
        fc.integer({ min: 4, max: 16 }),
        async (content, chunkSize) => {
          await atomicWriteTextFileChunked(path, content, { chunkSize });
          assertEquals(
            await Deno.readFile(path),
            new TextEncoder().encode(content),
          );
        },
      ),
      { numRuns: 300 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
