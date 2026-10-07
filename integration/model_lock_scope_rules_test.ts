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
 * Fitness test for running a model method under per-model locks:
 *
 *   A file that takes per-model locks (`acquireModelLocks`) and runs a
 *   method (`modelMethodRun`) runs it inside `runUnderModelLocks`.
 *
 * Outside that scope a shell step's nested swamp gets no list of the locks
 * its run holds, so it falls back to skipping every lock this process holds,
 * other runs' included (swamp-club#2955). Nothing fails when a site forgets
 * the wrap, so this pins the sites. Workflow steps take their locks through
 * `StepLockHook` and are scoped in `execution_service.ts`.
 *
 * Static — no subprocesses, nothing is executed.
 */

import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/** How many times `source` calls `name`, outside comment lines. */
function callCount(source: string, name: string): number {
  const call = new RegExp(`\\b${name}\\s*\\(`, "g");
  return source.split("\n")
    .filter((line) => !isCommentLine(line))
    .reduce((count, line) => count + (line.match(call)?.length ?? 0), 0);
}

Deno.test("callCount: counts calls, not comments", () => {
  assertEquals(
    callCount("  await modelMethodRun(ctx, deps, {});", "modelMethodRun"),
    1,
  );
  assertEquals(callCount("  // modelMethodRun(ctx)", "modelMethodRun"), 0);
  assertEquals(callCount("   * modelMethodRun(ctx)", "modelMethodRun"), 0);
  assertEquals(
    callCount("  const x = otherModelMethodRun();", "modelMethodRun"),
    0,
  );
});

/** Files that take per-model locks and run any model's methods. */
const SCOPED = [
  "src/cli/commands/model_method_run.ts",
  "src/serve/handlers/model_handlers.ts",
];

/**
 * Files that take per-model locks and run only built-in models whose
 * methods start no process, so nothing reads the scope.
 */
const EXEMPT = [
  "src/cli/commands/access_grant.ts",
  "src/cli/commands/access_group.ts",
];

Deno.test("method runs under per-model locks are scoped with runUnderModelLocks", async () => {
  const sites: string[] = [];
  const unscoped: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    const runs = callCount(source, "modelMethodRun");
    if (callCount(source, "acquireModelLocks") === 0 || runs === 0) continue;
    const site = repoRelative(filePath);
    sites.push(site);
    if (
      SCOPED.includes(site) && callCount(source, "runUnderModelLocks") < runs
    ) {
      unscoped.push(site);
    }
  }

  assertPinnedSet(
    sites.sort(),
    [...SCOPED, ...EXEMPT],
    "files that take per-model locks and run model methods",
    "Run each method inside runUnderModelLocks (src/cli/repo_context.ts) " +
      "with the locks it took, then add the file to SCOPED.",
  );
  assertEquals(
    unscoped,
    [],
    "each modelMethodRun in these files needs a runUnderModelLocks around " +
      "the consumption of its events",
  );
});

/**
 * Files that run a client's request as also holding the locks the client
 * forwarded. Each must name the locks of every step it runs inside that
 * scope: a step whose lock hook leaves them out runs in the adopted scope
 * instead of outside any, so its nested swamp waits on the step's own lock.
 * `createStepLockHook` names them (src/serve/deps_test.ts pins that), and
 * serve_deps_rules_test.ts pins that serve's workflow runs use it.
 */
const ADOPTERS = ["src/serve/connection.ts"];

Deno.test("only serve's request dispatch adopts a client's forwarded lock list", async () => {
  const wrapperCallers: string[] = [];
  const markerCallers: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    const site = repoRelative(filePath);
    if (callCount(source, "runAdoptingForwardedLocks") > 0) {
      wrapperCallers.push(site);
    }
    if (callCount(source, "runAdopting") > 0) markerCallers.push(site);
  }

  assertPinnedSet(
    wrapperCallers.sort(),
    ADOPTERS,
    "files that run a request under a forwarded lock list",
    "A new adopter must name the locks of every step it runs inside the " +
      "adopted scope (swamp-club#2982), then be added to ADOPTERS.",
  );
  assertPinnedSet(
    markerCallers.sort(),
    ["src/domain/datastore/lock_holder_marker.ts"],
    "files that call LockHolderMarker.runAdopting directly",
    "Adopt through runAdoptingForwardedLocks, in the same file, so the " +
      "adopters stay pinned.",
  );
});

/**
 * Where a run's locks are lent to a hop. A hop is given them only through a
 * hand-off, and whoever begins one must end it when the hop returns and
 * before the run writes: the end is what re-keys the locks, so a swamp the
 * hop left running stops skipping them (swamp-club#3111). Reading the lock
 * list with `childLockEnv` or `remoteLockHolder` and handing it to a
 * process skips that, and nothing fails when a site does, so this pins the
 * sites.
 */
const HAND_OFF_SITES: Record<string, string[]> = {
  beginChildHandOff: [
    "src/domain/datastore/lock_holder_marker.ts",
    "src/domain/models/command/shell/shell_model.ts",
  ],
  remoteHandOff: [
    "src/domain/datastore/lock_holder_marker.ts",
    "src/domain/models/method_execution_service.ts",
  ],
  beginLockHandOff: ["src/serve/dispatch_service.ts"],
  // Read-only views: the marker's own use, never a hand-down.
  childLockEnv: ["src/domain/datastore/lock_holder_marker.ts"],
  remoteLockHolder: ["src/domain/datastore/lock_holder_marker.ts"],
};

Deno.test("a run's locks reach a hop only through a hand-off that is ended", async () => {
  const callers: Record<string, string[]> = {};
  for (const name of Object.keys(HAND_OFF_SITES)) callers[name] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const lines = (await Deno.readTextFile(filePath)).split("\n")
      .filter((line) => !isCommentLine(line));
    for (const name of Object.keys(HAND_OFF_SITES)) {
      // Also an optional call: `request.beginLockHandOff?.()`.
      const call = new RegExp(`\\b${name}\\s*(\\?\\.)?\\(`);
      if (lines.some((line) => call.test(line))) {
        callers[name].push(repoRelative(filePath));
      }
    }
  }

  for (const [name, pinned] of Object.entries(HAND_OFF_SITES)) {
    assertPinnedSet(
      callers[name].sort(),
      pinned,
      `files that call ${name}`,
      "Lend a run's locks through beginChildHandOff or a dispatch's " +
        "beginLockHandOff, await the hand-off's end when the hop returns " +
        "and before writing, then add the file to HAND_OFF_SITES.",
    );
  }
});
