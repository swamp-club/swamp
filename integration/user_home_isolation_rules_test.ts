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

// Architectural fitness test: no test may let RepoService write into the
// ambient user home.
//
// `RepoService.init`/`.upgrade` install bundled skills into ~/.claude/skills,
// ~/.agents/skills, ~/.kiro/skills and the skill-dir registries under the
// config dir. `deno test --parallel` runs every test file in ONE process with
// ONE shared `Deno.env`, so a construction that falls back to the ambient home
// does two bad things: it overwrites the developer's real global skills on
// every `deno run test`, and it races any test that has temporarily repointed
// HOME or XDG_CONFIG_HOME at a temp directory it is about to delete — which
// surfaces as a `Directory not empty (os error 66)` failure in whichever
// unrelated test lost the race.
//
// Passing explicit `homeDir`/`configDir` is what keeps those writes inside the
// test's own temp directory. The count assertion is load-bearing: a rename
// that stops the scan matching anything would otherwise make this a vacuous
// pass.

import { assertGreater } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { assertPinnedSet, repoRelative, ROOT } from "./arch_fitness_helpers.ts";

const SCAN_DIRS = [join(ROOT, "src"), join(ROOT, "integration")];

const CONSTRUCTOR_CALL = "new RepoService(";

/**
 * Test-file `new RepoService(...)` constructions that pass only a version and
 * therefore resolve their global skill targets from the ambient environment.
 *
 * Pinned empty on purpose. A new entry means a test is about to write into the
 * developer's home directory: give it `{ homeDir, configDir }` rooted in the
 * test's temp dir (see `testService` in
 * `src/domain/repo/repo_service_test.ts`) rather than adding it here.
 */
const PINNED_AMBIENT_HOME_CONSTRUCTIONS: readonly string[] = [];

async function* testFiles(dir: string): AsyncGenerator<string> {
  for await (
    const entry of walk(dir, {
      exts: [".ts", ".tsx"],
      includeDirs: false,
      match: [/_test\.tsx?$/],
    })
  ) {
    yield entry.path;
  }
}

/**
 * Returns the argument text of every `new RepoService(...)` in `source`,
 * paired with its 1-based line number. Arguments are read by balancing
 * parentheses rather than by regex so multi-line constructions are seen.
 */
function repoServiceArguments(
  source: string,
): Array<{ line: number; args: string }> {
  const found: Array<{ line: number; args: string }> = [];
  let from = 0;
  while (true) {
    const start = source.indexOf(CONSTRUCTOR_CALL, from);
    if (start === -1) return found;

    const open = start + CONSTRUCTOR_CALL.length;
    let depth = 1;
    let cursor = open;
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      cursor++;
    }
    found.push({
      line: source.slice(0, start).split("\n").length,
      args: source.slice(open, cursor - 1),
    });
    from = cursor;
  }
}

/**
 * Reports whether `args` holds more than one argument — i.e. a comma that is
 * not nested inside a call, object or array. Angle brackets are deliberately
 * not counted: `=>` appears in argument lists far more often than a type
 * argument does, and treating it as a bracket would unbalance the depth.
 */
function hasSecondArgument(args: string): boolean {
  let depth = 0;
  for (const ch of args) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

Deno.test("fitness: tests construct RepoService with explicit user dirs", async () => {
  const violations: string[] = [];
  let total = 0;

  for (const dir of SCAN_DIRS) {
    for await (const filePath of testFiles(dir)) {
      const source = await Deno.readTextFile(filePath);
      for (const { line, args } of repoServiceArguments(source)) {
        total++;
        // A second argument is the user-dirs override; a lone version
        // argument falls back to the ambient HOME/XDG_CONFIG_HOME.
        if (hasSecondArgument(args)) continue;
        violations.push(`${repoRelative(filePath)}:${line}`);
      }
    }
  }

  assertGreater(
    total,
    0,
    "scan matched no `new RepoService(...)` in any test file — the pattern " +
      "has drifted and this check is no longer doing anything",
  );

  assertPinnedSet(
    violations.sort(),
    PINNED_AMBIENT_HOME_CONSTRUCTIONS,
    "RepoService constructions in tests without explicit user dirs",
    "Pass { homeDir, configDir } rooted in the test's own temp directory so " +
      "the global skill install cannot touch the real home.",
  );
});
