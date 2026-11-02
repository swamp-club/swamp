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
 * endAsCancelled and complete() change only status, leaving open work in a
 * settled record; cancels go through cancelAndSettle and rejects through
 * completeAndSettle
 */

import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const END_AS_CANCELLED_CALL = /\.endAsCancelled\s*\(/;

const COMPLETE_CALL = /\.complete\s*\(\s*\)/;

function callsEndAsCancelled(source: string): boolean {
  return callsOutsideComments(source, END_AS_CANCELLED_CALL);
}

function callsComplete(source: string): boolean {
  return callsOutsideComments(source, COMPLETE_CALL);
}

function callsOutsideComments(source: string, call: RegExp): boolean {
  return source.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("//") || trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      return false;
    }
    return call.test(line);
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

Deno.test("callsComplete: matches a run's complete(), not a tracker's or a comment", () => {
  assertEquals(callsComplete("  run.complete();"), true);
  assertEquals(callsComplete("  existingRun.complete( );"), true);
  assertEquals(
    callsComplete('  deps.runTracker.complete(run.id, "failed");'),
    false,
  );
  assertEquals(callsComplete("  complete(): void {"), false);
  assertEquals(callsComplete("  // service after run.complete())."), false);
});

const PINNED_COMPLETE = [
  "src/domain/workflows/abort_settlement.ts",
  "src/domain/workflows/execution_service.ts",
];

Deno.test("WorkflowRun.complete is called only by the live walk and completeAndSettle", async () => {
  const callers: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (callsComplete(await Deno.readTextFile(filePath))) {
      callers.push(repoRelative(filePath));
    }
  }

  assertPinnedSet(
    callers.sort(),
    PINNED_COMPLETE,
    "WorkflowRun.complete callers",
    "End a stored run with completeAndSettle from " +
      "src/domain/workflows/abort_settlement.ts, which settles the run's " +
      "unfinished jobs and steps before completing it.",
  );
});
