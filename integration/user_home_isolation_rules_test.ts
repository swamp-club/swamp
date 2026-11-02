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

// tests share one process and Deno.env, so a RepoService on the ambient home
// overwrites real global skills and races tests that repoint HOME; pass
// explicit homeDir/configDir

import { assertGreater } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { assertPinnedSet, repoRelative, ROOT } from "./arch_fitness_helpers.ts";

const SCAN_DIRS = [join(ROOT, "src"), join(ROOT, "integration")];

const CONSTRUCTOR_CALL = "new RepoService(";

/**
 * pinned empty on purpose: root homeDir and configDir in the test's temp dir
 * instead of adding an entry
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
 * angle brackets are not counted: => appears in argument lists far more often
 * than a type argument and would unbalance the depth
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
      // this rule names the call it searches for
      if (filePath === fromFileUrl(import.meta.url)) continue;
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
