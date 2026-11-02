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

// the source fingerprint depends only on the set of files and their contents,
// so the order and repeats of the module graph listing must not change it

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import {
  computeSourceFingerprint,
  type SourceModuleLookup,
} from "./bundle_freshness.ts";

const FILE_COUNT = 6;

const arbListing = fc.array(fc.nat({ max: FILE_COUNT - 1 }), {
  minLength: 1,
  maxLength: 3 * FILE_COUNT,
});

function lookupFor(entry: string, modules: string[]): SourceModuleLookup {
  return {
    findSourceModules: (path) => path === entry ? modules : undefined,
  };
}

Deno.test("computeSourceFingerprint: the recorded modules' order and repeats do not change the fingerprint", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_property_" });
  try {
    const entry = join(dir, "models", "entry.ts");
    await Deno.mkdir(join(dir, "models"));
    await Deno.mkdir(join(dir, "lib"));
    await Deno.writeTextFile(entry, "export const e = 0;");
    const files: string[] = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const file = join(dir, i % 2 ? "lib" : "models", `m${i}.ts`);
      if (i !== FILE_COUNT - 1) {
        await Deno.writeTextFile(file, `export const m${i} = ${i};`);
      }
      files.push(file);
    }
    const boundary = join(dir, "models");

    await fc.assert(
      fc.asyncProperty(arbListing, async (listing) => {
        const listed = listing.map((i) => files[i]);
        const canonical = [...new Set(listed)].sort();
        assertEquals(
          await computeSourceFingerprint(
            entry,
            boundary,
            lookupFor(entry, listed),
          ),
          await computeSourceFingerprint(
            entry,
            boundary,
            lookupFor(entry, canonical),
          ),
        );
      }),
      { numRuns: 100 },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
