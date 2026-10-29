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
import { BrokenLineageMoveGuard } from "./broken_lineage_move.ts";

/**
 * Drives the guard as serve's probe does, through replacement outcomes in
 * order (true: succeeded, keeping the broken lineage), and counts the
 * moves of the lease.
 */
function movesThrough(
  guard: BrokenLineageMoveGuard,
  lineageFence: number,
  outcomes: readonly boolean[],
): number {
  let moves = 0;
  for (const succeeds of outcomes) {
    const move = guard.decide(lineageFence);
    if (move === "none") continue;
    if (move === "advance") {
      moves++;
      guard.advanced(lineageFence);
    }
    if (succeeds) guard.replacementSucceeded();
    else guard.replacementFailed();
  }
  return moves;
}

Deno.test("BrokenLineageMoveGuard: a broken lineage is moved from once", () => {
  const guard = new BrokenLineageMoveGuard();
  assertEquals(guard.decide(3), "advance");
  guard.advanced(3);
  guard.replacementSucceeded();
  assertEquals(guard.decide(3), "none");
});

Deno.test("BrokenLineageMoveGuard: a replacement failing N times moves the lease once", () => {
  for (const failures of [1, 2, 5, 20]) {
    const guard = new BrokenLineageMoveGuard();
    assertEquals(
      movesThrough(guard, 7, Array(failures).fill(false)),
      1,
      `${failures} failures`,
    );
  }
});

Deno.test("BrokenLineageMoveGuard: a failed replacement is retried at the fence the move took", () => {
  const guard = new BrokenLineageMoveGuard();
  guard.advanced(4);
  guard.replacementFailed();
  assertEquals(guard.decide(4), "replace");
  guard.replacementSucceeded();
  assertEquals(guard.decide(4), "none");
});

Deno.test("BrokenLineageMoveGuard: failures between replacements that keep the lineage move the lease once", () => {
  // A copy that fails its own check keeps the broken lineage, so a
  // replacement can succeed and leave it broken.
  const guard = new BrokenLineageMoveGuard();
  assertEquals(
    movesThrough(guard, 9, [false, true, false, true, false, false, true]),
    1,
  );
});

Deno.test("BrokenLineageMoveGuard: a new lineage found broken is moved from again (swamp-club#3935)", () => {
  const guard = new BrokenLineageMoveGuard();
  assertEquals(movesThrough(guard, 2, [false, true]), 1);
  assertEquals(guard.decide(5), "advance");
});

Deno.test("BrokenLineageMoveGuard: a failed replacement before any move owes no retry", () => {
  const guard = new BrokenLineageMoveGuard();
  guard.replacementFailed();
  assertEquals(guard.decide(1), "advance");
});
