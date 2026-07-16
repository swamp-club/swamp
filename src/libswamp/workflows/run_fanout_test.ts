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
import { collectBounded } from "./run_fanout.ts";

Deno.test("collectBounded: flattens all per-item results", async () => {
  const out = await collectBounded(
    [1, 2, 3],
    2,
    (n) => Promise.resolve([n, n * 10]),
  );
  assertEquals(out.sort((a, b) => a - b), [1, 2, 3, 10, 20, 30]);
});

Deno.test("collectBounded: returns empty for empty input", async () => {
  const out = await collectBounded([], 4, () => Promise.resolve([1]));
  assertEquals(out, []);
});

Deno.test("collectBounded: never exceeds the concurrency bound", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  await collectBounded(items, 3, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return [n];
  });

  assert(
    maxInFlight <= 3,
    `expected at most 3 concurrent, saw ${maxInFlight}`,
  );
});
