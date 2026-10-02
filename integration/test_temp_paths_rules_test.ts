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

// Architectural fitness test: no test opens a database at a fixed host path.
//
// A database file at a literal path such as `/tmp/test-repo/_catalog.db` is
// shared by every test run on the host, including parallel verification runs
// from worktrees on different code. Two runs on different catalog schema
// versions raced on one such file and left it in a state that failed every
// later run (swamp-club#2994). Tests open their databases under a per-test
// `Deno.makeTempDir` (or `withTempDir`) directory, or use `:memory:`.
//
// The scan is textual and spans line breaks, because `deno fmt` wraps a long
// path onto the line after the constructor. A path held in a variable gets
// past it; the pattern self-check below proves it still matches the shapes it
// targets.

import { assert, assertEquals, assertGreater } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { repoRelative, ROOT } from "./arch_fitness_helpers.ts";

// This file's self-check samples are fixed paths on purpose.
const THIS_FILE = fromFileUrl(import.meta.url);

const SCAN_DIRS = [
  join(ROOT, "src"),
  join(ROOT, "integration"),
  join(ROOT, "packages"),
  // Extension tests run in the same `deno test --parallel` process.
  join(ROOT, "extensions"),
];

// A database constructor whose first argument is an absolute string literal,
// directly or as the first argument of `join(...)`.
const FIXED_PATH_DATABASE =
  /\bnew\s+(?:CatalogStore|ExtensionCatalogStore|DatabaseSync)\(\s*(?:join\(\s*)?["'`](?:\/|\\|[A-Za-z]:[\\/])/g;

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

function fixedPathLines(source: string): number[] {
  return [...source.matchAll(FIXED_PATH_DATABASE)].map((m) =>
    source.slice(0, m.index).split("\n").length
  );
}

Deno.test("fitness: the fixed-path database pattern matches the shapes it targets", () => {
  const flagged = [
    `new CatalogStore(join("/tmp/test-repo", "_catalog.db"))`,
    `new CatalogStore(\n    join("/tmp/nonexistent-repo", "_catalog.db"),\n  )`,
    `new ExtensionCatalogStore("/tmp/catalog.db")`,
    `new DatabaseSync('C:\\\\tmp\\\\catalog.db')`,
  ];
  for (const sample of flagged) {
    assertEquals(fixedPathLines(sample).length, 1, sample);
  }

  const allowed = [
    `new CatalogStore(join(tmpDir, "_catalog.db"))`,
    `new CatalogStore(":memory:")`,
    `new DatabaseSync(dbPath)`,
  ];
  for (const sample of allowed) {
    assertEquals(fixedPathLines(sample), [], sample);
  }
});

Deno.test("fitness: tests do not open databases at fixed host paths", async () => {
  const violations: string[] = [];
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    for await (const filePath of testFiles(dir)) {
      if (filePath === THIS_FILE) continue;
      scanned++;
      const source = await Deno.readTextFile(filePath);
      for (const line of fixedPathLines(source)) {
        violations.push(`${repoRelative(filePath)}:${line}`);
      }
    }
  }

  assertGreater(
    scanned,
    0,
    "scan found no test files — the walk has drifted and this check is no " +
      "longer doing anything",
  );

  assert(
    violations.length === 0,
    "Tests open a database at a fixed host path, shared by every test run " +
      "on the host:\n" + violations.map((v) => `  ${v}`).join("\n") +
      "\n\nOpen it under a per-test Deno.makeTempDir (or withTempDir) " +
      'directory, or use ":memory:".',
  );
});
