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
 * Fitness test for the records of workflow signal waits (swamp-club#3093):
 *
 *   1. Only `signal_wait_records.ts` names the two control-plane key
 *      families, `waits/` and `wait-outcomes/`.
 *   2. `workflow signal` never saves a run and never takes a run claim.
 *   3. A run repository's `beforeSave` hook, which closes the waits of a
 *      run saved as ended, is assigned in one place.
 *   4. Every file that builds a WorkflowExecutionService gives it its wait
 *      support.
 *
 * A signal is delivered by creating a write-once outcome record, and the
 * run record changes only inside a resume. A second writer of either key
 * family, a signal path that writes the run, or a context that builds its
 * repository without the hook would each bring back a race this design
 * removes. Pinning them makes each a change someone reviews.
 *
 * Static — no subprocesses, nothing is executed.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import {
  WAIT_OUTCOME_PREFIX,
  WAIT_REGISTRATION_PREFIX,
} from "../src/domain/workflows/signal_wait_records.ts";

/** True when a line of `source` outside a comment matches `pattern`. */
function mentions(source: string, pattern: RegExp): boolean {
  return source.split("\n").some((line) =>
    !isCommentLine(line) && pattern.test(line)
  );
}

async function filesMentioning(pattern: RegExp): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (mentions(await Deno.readTextFile(filePath), pattern)) {
      files.push(repoRelative(filePath));
    }
  }
  return files.sort();
}

/** A string literal that starts with one of the two key families. */
const WAIT_KEY_LITERAL = /["'`](?:waits|wait-outcomes)\//;

/** An assignment of a run repository's save hook. */
const BEFORE_SAVE_ASSIGNMENT = /\.beforeSave\s*=[^=]/;

const EXECUTION_SERVICE_CONSTRUCTION = /new WorkflowExecutionService\(/;
const SIGNAL_WAITS_ASSIGNMENT = /\.signalWaits\s*=[^=]/;

Deno.test("signal wait rules: the patterns match code and skip comments", () => {
  assertEquals(mentions("  return `waits/${id}`;", WAIT_KEY_LITERAL), true);
  assertEquals(
    mentions('const P = "wait-outcomes/";', WAIT_KEY_LITERAL),
    true,
  );
  assertEquals(mentions("  // under waits/<id>", WAIT_KEY_LITERAL), false);
  assertEquals(mentions('  "workflow waits"', WAIT_KEY_LITERAL), false);
  assertEquals(mentions('  "awaits/x"', WAIT_KEY_LITERAL), false);
  assertEquals(
    mentions("  repo.beforeSave = hook;", BEFORE_SAVE_ASSIGNMENT),
    true,
  );
  assertEquals(
    mentions("  if (repo.beforeSave === hook) {", BEFORE_SAVE_ASSIGNMENT),
    false,
  );
  assertEquals(
    mentions("  await this.beforeSave?.(run);", BEFORE_SAVE_ASSIGNMENT),
    false,
  );
});

Deno.test("signal wait rules: the key families are what the pattern looks for", () => {
  assertEquals(WAIT_REGISTRATION_PREFIX, "waits/");
  assertEquals(WAIT_OUTCOME_PREFIX, "wait-outcomes/");
});

Deno.test("only signal_wait_records.ts names the wait key families", async () => {
  assertPinnedSet(
    await filesMentioning(WAIT_KEY_LITERAL),
    ["src/domain/workflows/signal_wait_records.ts"],
    "wait key family literals",
    "Build wait keys with waitRegistrationKey and waitOutcomeKey from " +
      "src/domain/workflows/signal_wait_records.ts, and read or write the " +
      "records through a SignalWaitStore, so every writer validates the id " +
      "and creates an outcome only if none exists.",
  );
});

Deno.test("workflow signal never saves a run and never takes a run claim", async () => {
  const source = await Deno.readTextFile(
    join(ROOT, "src", "libswamp", "workflows", "signal.ts"),
  );
  assertEquals(
    mentions(source, /\.save\s*\(/),
    false,
    "workflow signal must not save a run: it is delivered by creating the " +
      "wait's outcome record, and a resume applies it under the run's claim.",
  );
  assertEquals(
    mentions(source, /\bwithClaim\b|\brunClaims\b/),
    false,
    "workflow signal must not take a run claim: it writes no run record.",
  );
  assertEquals(
    mentions(source, /\bRunTracker|\bownerIs/),
    false,
    "workflow signal must not ask about the run's owner: nothing the owner " +
      "saves can erase an outcome record.",
  );
});

Deno.test("the run repository's save hook is assigned only where a context gets its wait support", async () => {
  assertPinnedSet(
    await filesMentioning(BEFORE_SAVE_ASSIGNMENT),
    ["src/cli/repo_context.ts"],
    "beforeSave assignments",
    "Give a repository context its wait support with attachSignalWaits in " +
      "src/cli/repo_context.ts, which sets the hook that closes the waits of " +
      "a run saved as ended. A second assignment would replace it.",
  );
});

Deno.test("every file that builds a WorkflowExecutionService gives it its wait support", async () => {
  const built = await filesMentioning(EXECUTION_SERVICE_CONSTRUCTION);
  const wired = new Set(await filesMentioning(SIGNAL_WAITS_ASSIGNMENT));
  assertEquals(
    built.filter((file) => !wired.has(file)),
    [],
    "A WorkflowExecutionService without signalWaits refuses every workflow " +
      "that waits for a signal. Set service.signalWaits where it is built " +
      "(signalWaitsOf(repoContext) in a command, the parent's in a child).",
  );
});
