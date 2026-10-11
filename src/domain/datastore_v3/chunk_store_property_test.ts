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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { restoreNamespace } from "../data/namespace.ts";
import { ChunkStore } from "./chunk_store.ts";
import { MemoryStorage, readAll, streamOf } from "./v3_test_helpers.ts";

const NS = restoreNamespace("team-a");
const live = () => new AbortController().signal;

Deno.test("ChunkStore: random content written and read back is identical, with a stable reference", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 300 }),
      fc.integer({ min: 1, max: 40 }),
      fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 8 }),
      fc.boolean(),
      async (content, maxChunkBytes, pieces, touch) => {
        const storage = new MemoryStorage({ maxChunkBytes, touch });
        const store = new ChunkStore(storage);
        const ref = await store.write(NS, content, live());
        assertEquals(await readAll(store.read(NS, ref, live())), content);
        // The same content, streamed in any pieces, gives an equal reference
        // and stores nothing new.
        const chunks = storage.chunks.size;
        const again = await store.write(
          NS,
          streamOf(content, pieces),
          live(),
        );
        assert(again.equals(ref));
        assertEquals(storage.chunks.size, chunks);
        // Every part but the last is a full chunk.
        const sizes = ref.parts?.map((p) => p.size) ?? [ref.size];
        assert(sizes.slice(0, -1).every((size) => size === maxChunkBytes));
        assert(
          sizes[sizes.length - 1] <= maxChunkBytes || content.length === 0,
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("ChunkStore: different content gives different references", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 100 }),
      fc.uint8Array({ maxLength: 100 }),
      fc.integer({ min: 1, max: 16 }),
      async (a, b, maxChunkBytes) => {
        const store = new ChunkStore(new MemoryStorage({ maxChunkBytes }));
        const refA = await store.write(NS, a, live());
        const refB = await store.write(NS, b, live());
        const same = a.length === b.length && a.every((x, i) => x === b[i]);
        assertEquals(refA.equals(refB), same);
      },
    ),
    { numRuns: 300 },
  );
});
