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
  applyLockfileDelta,
  diffLockfileEntries,
  isEmptyLockfileDelta,
} from "./lockfile_delta.ts";

interface Entry {
  version: string;
  files: string[];
}

const nameArb = fc.constantFrom("@a/x", "@a/y", "@a/z", "@b/p", "@b/q");
const entryArb: fc.Arbitrary<Entry> = fc.record({
  version: fc.constantFrom("1", "2", "3"),
  files: fc.array(fc.constantFrom("f1", "f2"), { maxLength: 2 }),
});
const entriesArb = fc.dictionary(nameArb, entryArb);

Deno.test("diffLockfileEntries: applying the diff of before to after yields after", () => {
  fc.assert(
    fc.property(entriesArb, entriesArb, (before, after) => {
      assertEquals(
        applyLockfileDelta(before, diffLockfileEntries(before, after)),
        after,
      );
    }),
  );
});

Deno.test("diffLockfileEntries: an entry set diffed with itself is empty", () => {
  fc.assert(
    fc.property(entriesArb, (entries) => {
      assertEquals(
        isEmptyLockfileDelta(diffLockfileEntries(entries, entries)),
        true,
      );
    }),
  );
});

Deno.test("applyLockfileDelta: replaying a local change onto a peer's lockfile keeps the peer's other entries", () => {
  fc.assert(
    fc.property(
      entriesArb,
      entriesArb,
      entriesArb,
      (base, local, peer) => {
        const delta = diffLockfileEntries(base, local);
        const merged = applyLockfileDelta(peer, delta);
        const touched = new Set([
          ...Object.keys(delta.upserts),
          ...delta.removals,
        ]);
        for (const [name, entry] of Object.entries(peer)) {
          if (!touched.has(name)) assertEquals(merged[name], entry);
        }
        for (const [name, entry] of Object.entries(delta.upserts)) {
          assertEquals(merged[name], entry);
        }
        for (const name of delta.removals) {
          assertEquals(Object.hasOwn(merged, name), false);
        }
      },
    ),
  );
});
