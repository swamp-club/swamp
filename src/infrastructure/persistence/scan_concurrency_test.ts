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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { mapBounded } from "./scan_concurrency.ts";

/** A macrotask, so calls overlap. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("mapBounded: returns results in the items' order, at most limit at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await mapBounded(items, 4, async (item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Later items finish first, so order comes from the index, not timing.
    for (let i = 0; i < 20 - item; i++) await tick();
    inFlight--;
    return item * 2;
  });
  assertEquals(results, items.map((item) => item * 2));
  assertEquals(peak, 4);
});

Deno.test("mapBounded: starts no item after one fails, and raises only once started calls settle", async () => {
  const started: number[] = [];
  let settled = 0;
  await assertRejects(
    () =>
      mapBounded([0, 1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
        started.push(item);
        try {
          await tick();
          if (item === 1) throw new Error("boom");
          await tick();
        } finally {
          settled++;
        }
      }),
    Error,
    "boom",
  );
  assertEquals(settled, started.length);
  assert(!started.includes(7), `started ${started}`);
});

Deno.test("mapBounded: once the signal aborts, starts no further item and rejects with its reason", async () => {
  const abort = new AbortController();
  const started: number[] = [];
  await assertRejects(
    () =>
      mapBounded(
        [0, 1, 2, 3, 4, 5],
        1,
        async (item) => {
          started.push(item);
          if (item === 1) abort.abort(new Error("cancelled"));
          await tick();
        },
        abort.signal,
      ),
    Error,
    "cancelled",
  );
  assertEquals(started, [0, 1]);
});
