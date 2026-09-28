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

// Architectural fitness test: no test may mutate the process environment.
//
// `deno test --parallel` runs every test file in ONE process with ONE shared
// environment. A test that calls `Deno.env.set` or `Deno.env.delete` changes
// what every other file running at that moment reads — for example a
// `SWAMP_DATASTORE` set by resolve_datastore_test made a parallel
// workflow_recover_test resolve a test-only datastore type (swamp-club#2658).
//
// `withMockedEnv` from `src/infrastructure/persistence/path_test_helpers.ts`
// replaces the env readers for the current file's worker only, so tests use it
// instead (self-contained extensions, which cannot import it, patch the readers
// the same way in-file). The scan is textual — `Deno.env["set"]` or an aliased
// `Deno.env` gets past it; the pin-list proves the pattern still matches.

import { assertGreater } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { assertPinnedSet, repoRelative, ROOT } from "./arch_fitness_helpers.ts";

const SCAN_DIRS = [
  join(ROOT, "src"),
  join(ROOT, "integration"),
  join(ROOT, "packages"),
  // Extension tests run in the same `deno test --parallel` process.
  join(ROOT, "extensions"),
];

const ENV_MUTATION = /\bDeno\.env\.(set|delete)\(/;

/**
 * Test files allowed to contain a `Deno.env.set` / `Deno.env.delete` call.
 *
 * - integration/tls_trust_test.ts: the only match is inside the source of a
 *   child script it spawns with `clearEnv` and an explicit `env`; the test
 *   process itself never mutates its environment. Being file-level, this
 *   entry would also hide a real mutation added to that file later.
 *
 * Do not add to this list. Use `withMockedEnv` instead, and pass child
 * processes an explicit `env` — they never see the mocked readers.
 */
const PINNED_ENV_MUTATING_TEST_FILES: readonly string[] = [
  "integration/tls_trust_test.ts",
];

async function* testFiles(dir: string): AsyncGenerator<string> {
  for await (
    const entry of walk(dir, {
      exts: [".ts", ".tsx"],
      includeDirs: false,
      match: [/_test\.tsx?$/],
      skip: [/node_modules/],
    })
  ) {
    yield entry.path;
  }
}

Deno.test("fitness: tests do not mutate the process environment", async () => {
  const violations: string[] = [];
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    for await (const filePath of testFiles(dir)) {
      scanned++;
      const source = await Deno.readTextFile(filePath);
      if (ENV_MUTATION.test(source)) violations.push(repoRelative(filePath));
    }
  }

  assertGreater(
    scanned,
    0,
    "scan found no test files — the walk has drifted and this check is no " +
      "longer doing anything",
  );

  assertPinnedSet(
    violations.sort(),
    PINNED_ENV_MUTATING_TEST_FILES,
    "Test files that call Deno.env.set or Deno.env.delete",
    "Replace the mutation with withMockedEnv from " +
      "src/infrastructure/persistence/path_test_helpers.ts: a real write is " +
      "visible to every test file running in parallel.",
  );
});
