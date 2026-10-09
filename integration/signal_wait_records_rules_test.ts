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
 *      families, `waits/` and `wait-outcomes/`, and only
 *      `wait_key_claim.ts` names the third, `wait-keys/` (swamp-club#3209).
 *   2. `workflow signal` never saves a run and never takes a run claim,
 *      locally or delivered through `swamp serve` (swamp-club#3094).
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
import { WAIT_KEY_RECORD_PREFIX } from "../src/domain/workflows/wait_key_claim.ts";

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

/** A string literal that starts with the family of key records. */
const KEY_RECORD_LITERAL = /["'`]wait-keys\//;

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
  assertEquals(WAIT_KEY_RECORD_PREFIX, "wait-keys/");
  assertEquals(
    mentions('const P = "wait-keys/";', KEY_RECORD_LITERAL),
    true,
  );
  assertEquals(
    mentions("  // under wait-keys/<id>", KEY_RECORD_LITERAL),
    false,
  );
  assertEquals(mentions('const P = "wait-keys/";', WAIT_KEY_LITERAL), false);
});

Deno.test("only wait_key_claim.ts names the family of key records", async () => {
  assertPinnedSet(
    await filesMentioning(KEY_RECORD_LITERAL),
    ["src/domain/workflows/wait_key_claim.ts"],
    "key record family literals",
    "Build the store key of a key record with waitKeyRecordKey from " +
      "src/domain/workflows/wait_key_claim.ts, and read or write the " +
      "records through a SignalWaitStore, so every writer validates the " +
      "workflow id and the key, and a highest claim is superseded by a " +
      "release instead of deleted.",
  );
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

/**
 * The files a signal passes through on its way to the outcome record: the
 * acceptance use case, and serve's delivery function and HTTP route. The
 * WebSocket handler shares a file with handlers that do save runs, so it is
 * held to calling the delivery function instead (the next test).
 *
 * The key claims are on the list for a signal addressed by key
 * (swamp-club#3210), which finds its wait through them. That holds every
 * function of the file to the rule, the ones a step claims and releases a
 * key with included: none of them has a reason to write a run.
 */
const SIGNAL_PATH_FILES = [
  ["src", "libswamp", "workflows", "signal.ts"],
  ["src", "domain", "workflows", "wait_key_claim.ts"],
  ["src", "serve", "signal_delivery.ts"],
  ["src", "serve", "signal_http.ts"],
];

Deno.test("workflow signal never saves a run and never takes a run claim", async () => {
  for (const parts of SIGNAL_PATH_FILES) {
    await assertWritesNoRun(parts);
  }
});

Deno.test("workflow signal reads who holds a key and writes no key record", async () => {
  const source = await Deno.readTextFile(
    join(ROOT, "src", "libswamp", "workflows", "signal.ts"),
  );
  assertEquals(
    mentions(source, /\bfindKeyHolder\s*\(/),
    true,
    "src/libswamp/workflows/signal.ts: a signal addressed by key resolves " +
      "its wait with findKeyHolder.",
  );
  assertEquals(
    mentions(
      source,
      /\bclaimWaitKey\b|\breleaseKeyClaims\b|\.createKeyRecord\s*\(|\.removeKeyRecord\s*\(|\.removeKeyRecordsOfWorkflow\s*\(/,
    ),
    false,
    "src/libswamp/workflows/signal.ts: a signal must not claim, release " +
      "or remove a key. It resolves a key to the wait that holds it with " +
      "findKeyHolder, which writes nothing, and the outcome it then creates " +
      "is the only record a signal writes.",
  );
});

Deno.test("both serve transports deliver a signal through deliverSignalForCaller", async () => {
  const handlers = await Deno.readTextFile(
    join(ROOT, "src", "serve", "handlers", "workflow_handlers.ts"),
  );
  const http = await Deno.readTextFile(
    join(ROOT, "src", "serve", "signal_http.ts"),
  );
  for (
    const [name, source] of [["workflow_handlers.ts", handlers], [
      "signal_http.ts",
      http,
    ]]
  ) {
    assertEquals(
      mentions(source, /\bdeliverSignalForCaller\s*\(/),
      true,
      `${name} must deliver a signal through deliverSignalForCaller, the ` +
        "one place a serve caller is authorized on the wait's workflow.",
    );
    assertEquals(
      mentions(source, /\bworkflowSignal\s*\(/),
      false,
      `${name} must not call workflowSignal itself: that would deliver a ` +
        "signal without the authorization deliverSignalForCaller applies.",
    );
  }
});

async function assertWritesNoRun(parts: string[]): Promise<void> {
  const source = await Deno.readTextFile(join(ROOT, ...parts));
  assertEquals(
    mentions(source, /\.save\s*\(/),
    false,
    `${parts.join("/")}: workflow signal must not save a run: it is ` +
      "delivered by creating the wait's outcome record, and a resume " +
      "applies it under the run's claim.",
  );
  assertEquals(
    mentions(
      source,
      /\bwithClaim\b|\brunClaims\b|\bunclaimedRuns\b|\.reserve\s*\(/,
    ),
    false,
    `${parts.join("/")}: workflow signal must not take a run claim or a ` +
      "registry reservation: it writes no run record.",
  );
  assertEquals(
    mentions(source, /\bRunTracker|\bownerIs/),
    false,
    `${parts.join("/")}: workflow signal must not ask about the run's ` +
      "owner: nothing the owner saves can erase an outcome record.",
  );
  assertEquals(
    mentions(source, /\bpushChangedToRemote\b|\brunInRootUnitOfWork\b/),
    false,
    `${parts.join("/")}: workflow signal must not push: an outcome record ` +
      "is written straight to the control-plane store.",
  );
}

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
