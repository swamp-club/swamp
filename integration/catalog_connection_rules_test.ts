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

// Architectural fitness test: `swamp datastore compact` swaps the catalog
// file through the repository context's own CatalogStore.
//
// CatalogStore.vacuum rebuilds `_catalog.db` into a temp file, closes its
// connection and renames the rebuilt file into place. On Windows the rename
// fails while any other connection in the process still has the file open, so
// a compact command that opens a second store next to
// `repoContext.catalogStore` failed on every run (swamp-club#3167). On POSIX
// the same split leaves the repository context's connection on the replaced
// file. Windows CI only runs after merge, so this rule keeps the single
// connection on every platform.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { isCommentLine, SRC_DIR } from "./arch_fitness_helpers.ts";

const COMPACT_COMMAND = join(
  SRC_DIR,
  "cli",
  "commands",
  "datastore_compact.ts",
);

/** The command's source with comment lines dropped. */
async function compactCode(): Promise<string> {
  const source = await Deno.readTextFile(COMPACT_COMMAND);
  return source.split("\n").filter((line) => !isCommentLine(line)).join("\n");
}

Deno.test("catalog connection: datastore compact opens no catalog store of its own (swamp-club#3167)", async () => {
  const code = await compactCode();
  assertEquals(
    code.match(/\b(?:createCatalogStore|new CatalogStore)\b/g) ?? [],
    [],
    "datastore_compact.ts opens its own catalog store. vacuum renames " +
      "_catalog.db, which Windows refuses while repoContext.catalogStore " +
      "holds it open. Compact through repoContext.catalogStore instead.",
  );
});

Deno.test("catalog connection: datastore compact checkpoints and vacuums through the repo context's store (swamp-club#3167)", async () => {
  const code = await compactCode();
  assert(
    /repoContext\.catalogStore\.checkpoint\(\)/.test(code) &&
      /repoContext\.catalogStore\.vacuum\(\)/.test(code),
    "datastore_compact.ts must call checkpoint() and vacuum() on " +
      "repoContext.catalogStore. The rule matches that exact call shape: if " +
      "the command still compacts through the repo context's store under " +
      "another spelling, update this pattern rather than the command.",
  );
});
