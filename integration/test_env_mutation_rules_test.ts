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

import { assertGreater } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { assertPinnedSet, repoRelative, ROOT } from "./arch_fitness_helpers.ts";

const SCAN_DIRS = [
  join(ROOT, "src"),
  join(ROOT, "integration"),
  join(ROOT, "packages"),
  // extension tests run in the same parallel test process
  join(ROOT, "extensions"),
];

const ENV_MUTATION = /\bDeno\.env\.(set|delete)\(/;

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
