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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { extractZipEntry, ZipArchiveError } from "./zip_archive.ts";
import { buildZip, type TestZipEntry } from "./zip_test_helpers.ts";

const arbEntry = fc.record({
  name: fc.constantFrom(
    "a.txt",
    "swamp",
    "bin/swamp.exe",
    "é.txt",
  ),
  data: fc.uint8Array({ maxLength: 4096 }),
  method: fc.constantFrom(0 as const, 8 as const),
  dataDescriptor: fc.boolean(),
  localExtra: fc.uint8Array({ maxLength: 40 }),
});

const arbArchive = fc.record({
  target: fc.record({
    data: fc.oneof(
      fc.uint8Array({ maxLength: 8192 }),
      fc.string({ maxLength: 2000 }).map((s) => new TextEncoder().encode(s)),
    ),
    method: fc.constantFrom(0 as const, 8 as const),
    dataDescriptor: fc.boolean(),
    localExtra: fc.uint8Array({ maxLength: 40 }),
  }),
  others: fc.array(arbEntry, { maxLength: 4 }),
  position: fc.nat(),
  comment: fc.uint8Array({ maxLength: 300 }),
});

type Archive = typeof arbArchive extends fc.Arbitrary<infer T> ? T : never;

function entriesOf(archive: Archive): TestZipEntry[] {
  const entries = [...archive.others];
  entries.splice(archive.position % (entries.length + 1), 0, {
    name: "swamp.exe",
    ...archive.target,
  });
  return entries;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "zip-prop-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("extractZipEntry: extracting the named entry yields exactly its bytes", async () => {
  await fc.assert(
    fc.asyncProperty(arbArchive, async (archive) => {
      await withTmp(async (dir) => {
        const path = join(dir, "a.zip");
        const dest = join(dir, "out");
        await Deno.writeFile(
          path,
          await buildZip(entriesOf(archive), { comment: archive.comment }),
        );
        await extractZipEntry(path, "swamp.exe", dest);
        assertEquals(await Deno.readFile(dest), archive.target.data);
      });
    }),
    { numRuns: 50 },
  );
});

Deno.test("extractZipEntry: a damaged archive yields the exact bytes or a ZipArchiveError, and no partial output", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbArchive,
      fc.array(
        fc.record({ at: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }),
        {
          minLength: 1,
          maxLength: 4,
        },
      ),
      fc.option(fc.nat(), { nil: undefined }),
      async (archive, flips, cut) => {
        await withTmp(async (dir) => {
          let zip = await buildZip(entriesOf(archive), {
            comment: archive.comment,
          });
          zip = zip.slice();
          for (const flip of flips) zip[flip.at % zip.length] = flip.value;
          if (cut !== undefined) zip = zip.subarray(0, cut % (zip.length + 1));
          const path = join(dir, "a.zip");
          const dest = join(dir, "out");
          await Deno.writeFile(path, zip);
          try {
            await extractZipEntry(path, "swamp.exe", dest);
          } catch (error) {
            assertInstanceOf(error, ZipArchiveError);
            let left = true;
            await Deno.stat(dest).catch(() => left = false);
            assertEquals(left, false, "no partial output after a refusal");
            return;
          }
          assertEquals(await Deno.readFile(dest), archive.target.data);
        });
      },
    ),
    { numRuns: 300 },
  );
});
