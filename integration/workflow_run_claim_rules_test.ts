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
 * a command that loads, changes and saves a suspended run must hold its claim
 * or a concurrent save overwrites it; unclaimedRuns opts out only where
 * something else excludes other writers
 */

import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

function mentions(source: string, pattern: RegExp): boolean {
  return source.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("//") || trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      return false;
    }
    return pattern.test(line);
  });
}

const UNCLAIMED_RUNS = /\bunclaimedRuns\b/;

const WITH_CLAIM_CALL = /\.withClaim\s*\(/;

Deno.test("mentions: matches code lines, not comments or declarations", () => {
  assertEquals(mentions("  runClaims: unclaimedRuns,", UNCLAIMED_RUNS), true);
  assertEquals(mentions("  // unclaimedRuns here", UNCLAIMED_RUNS), false);
  assertEquals(mentions("   * pass `unclaimedRuns`", UNCLAIMED_RUNS), false);
  assertEquals(
    mentions("  await runClaims.withClaim(run.id, fn);", WITH_CLAIM_CALL),
    true,
  );
  assertEquals(
    mentions(
      "  await this.runClaims\n    .withClaim(id, fn);",
      WITH_CLAIM_CALL,
    ),
    true,
  );
  assertEquals(
    mentions("  withClaim<T>(runId: string): Promise<T>;", WITH_CLAIM_CALL),
    false,
  );
  assertEquals(
    mentions("    withClaim: async (runId, fn) => {", WITH_CLAIM_CALL),
    false,
  );
});

async function filesMentioning(pattern: RegExp): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (mentions(await Deno.readTextFile(filePath), pattern)) {
      files.push(repoRelative(filePath));
    }
  }
  return files.sort();
}

/**
 * resume uses lock-backed claims because serve's run reservation is local to
 * one process; the other pinned files reserve the run in serve's registry first
 */
const UNCLAIMED_PINNED = [
  "src/domain/workflows/execution_service.ts",
  "src/domain/workflows/run_claim.ts",
  "src/serve/handlers/workflow_handlers.ts",
  "src/serve/nested_run_cascade.ts",
];

Deno.test("unclaimedRuns is named only where another claim already holds", async () => {
  assertPinnedSet(
    await filesMentioning(UNCLAIMED_RUNS),
    UNCLAIMED_PINNED,
    "unclaimedRuns references",
    "Pass lock-backed claims (createWorkflowRunClaims in " +
      "src/cli/repo_context.ts) to code that loads, changes and saves a " +
      "workflow run. Use unclaimedRuns only where something else keeps " +
      "other writers off the run, and add the file here with the reason.",
  );
});

/**
 * workflow signal is not one of them: it creates the wait's outcome record and
 * never writes a run, so it has nothing to claim
 */
const CLAIMED_PINNED = [
  "src/cli/commands/workflow_cancel.ts",
  "src/domain/workflows/execution_service.ts",
  "src/libswamp/workflows/approve.ts",
  "src/libswamp/workflows/nested_cascade.ts",
  "src/libswamp/workflows/reject.ts",
  "src/libswamp/workflows/supersede.ts",
];

Deno.test("withClaim is called by the pinned run writers", async () => {
  assertPinnedSet(
    await filesMentioning(WITH_CLAIM_CALL),
    CLAIMED_PINNED,
    "withClaim callers",
    "A path that stops taking the run's claim can save over a concurrent " +
      "approve, reject, cancel, supersede or resume (swamp-club#2919). A " +
      "new claimed path is welcome: add the file here.",
  );
});
