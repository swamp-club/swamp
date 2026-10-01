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

/**
 * Fitness test for cancelling a workflow run:
 *
 *   Only `src/domain/workflows/abort_settlement.ts` calls
 *   `WorkflowRun.endAsCancelled`.
 *
 * `endAsCancelled` changes only the run's status. Called directly, it leaves
 * the run's jobs `running` and its steps `running`, `waiting_approval` or
 * `pending` in a record marked cancelled (swamp-club#2895). Every cancel
 * goes through `cancelAndSettle`, which settles that work first.
 *
 * Static — no subprocesses, nothing is executed.
 */

import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/** A call of the raw cancel transition, not its declaration. */
const END_AS_CANCELLED_CALL = /\.endAsCancelled\s*\(/;

/** True when `source` calls `endAsCancelled` outside a comment line. */
function callsEndAsCancelled(source: string): boolean {
  return source.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("//") || trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      return false;
    }
    return END_AS_CANCELLED_CALL.test(line);
  });
}

Deno.test("callsEndAsCancelled: matches a call, not the declaration or a comment", () => {
  assertEquals(callsEndAsCancelled("  run.endAsCancelled(reason);"), true);
  assertEquals(callsEndAsCancelled("  run\n    .endAsCancelled();"), true);
  assertEquals(
    callsEndAsCancelled("  endAsCancelled(reason?: string): void {"),
    false,
  );
  assertEquals(
    callsEndAsCancelled("   * `run.endAsCancelled(reason)` changes status"),
    false,
  );
  assertEquals(callsEndAsCancelled("  // run.endAsCancelled()"), false);
});

/** The only production file allowed to call `endAsCancelled`. */
const PINNED = ["src/domain/workflows/abort_settlement.ts"];

Deno.test("WorkflowRun.endAsCancelled is called only by cancelAndSettle", async () => {
  const callers: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (callsEndAsCancelled(await Deno.readTextFile(filePath))) {
      callers.push(repoRelative(filePath));
    }
  }

  assertPinnedSet(
    callers.sort(),
    PINNED,
    "WorkflowRun.endAsCancelled callers",
    "Cancel a run with cancelAndSettle from " +
      "src/domain/workflows/abort_settlement.ts, which settles the run's " +
      "unfinished jobs and steps before marking it cancelled.",
  );
});
