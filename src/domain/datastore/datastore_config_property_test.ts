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
import {
  type DatastoreConfigData,
  mergeSetupDatastoreBlock,
  SETUP_PRESERVED_DATASTORE_KEYS,
} from "./datastore_config.ts";

const arbBlock: fc.Arbitrary<DatastoreConfigData> = fc.record(
  {
    type: fc.constantFrom("filesystem", "@swamp/s3-datastore"),
    path: fc.string(),
    config: fc.dictionary(fc.string(), fc.string()),
    directories: fc.array(fc.string()),
    exclude: fc.array(fc.string()),
    hydrationStrategy: fc.constantFrom("full" as const, "lazy" as const),
    namespace: fc.string(),
    managedConfig: fc.boolean(),
  },
  { requiredKeys: ["type"] },
);

const preserved = new Set<string>(SETUP_PRESERVED_DATASTORE_KEYS);

Deno.test("mergeSetupDatastoreBlock: every key comes from the new block or is a preserved key of the old one", () => {
  fc.assert(
    fc.property(arbBlock, arbBlock, (existing, next) => {
      const merged = mergeSetupDatastoreBlock(existing, next);
      const nextRecord = next as unknown as Record<string, unknown>;
      const existingRecord = existing as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(merged)) {
        if (nextRecord[key] !== undefined) {
          assertEquals(value, nextRecord[key]);
        } else {
          assertEquals(preserved.has(key), true);
          assertEquals(value, existingRecord[key]);
        }
      }
      for (const key of SETUP_PRESERVED_DATASTORE_KEYS) {
        const expected = next[key] ?? existing[key];
        assertEquals(merged[key], expected);
      }
    }),
  );
});

Deno.test("mergeSetupDatastoreBlock: merging is idempotent", () => {
  fc.assert(
    fc.property(arbBlock, arbBlock, (existing, next) => {
      const once = mergeSetupDatastoreBlock(existing, next);
      assertEquals(mergeSetupDatastoreBlock(once, next), once);
    }),
  );
});
