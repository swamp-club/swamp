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
// Architectural fitness test: every production ExtensionLoader that has a
// catalog is built with a module graph reader.
//
// The loader records the module graph each bundle is built from, and the
// freshness fingerprint hashes every module in it, so editing any local
// module a bundle includes rebuilds it (swamp-club#3385). A loader built
// without a reader records only the relative imports within the kind's
// directory, which brings the bug back for every source it bundles. The
// constructor argument is optional so tests need not pass it, so this rule
// is what keeps a new production construction from omitting it. A loader
// with no repository (fewer than five arguments) has no catalog to record
// into.

import { assert, assertEquals } from "@std/assert";
import {
  constructorCalls,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/** The position of the module graph reader in the constructor's arguments. */
const READER_ARGUMENT = 6;

Deno.test("extension loader: production constructions with a repository pass a module graph reader (swamp-club#3385)", async () => {
  const missing: string[] = [];
  let constructions = 0;
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    for (const call of constructorCalls(source, "ExtensionLoader")) {
      if (call.args.length < 5) continue;
      constructions++;
      if (call.args[READER_ARGUMENT] !== "createDenoInfoModuleGraphReader") {
        missing.push(`${repoRelative(filePath)}:${call.line + 1}`);
      }
    }
  }
  // Guards the scan itself: a change to how files are found must not make
  // the rule pass by matching nothing.
  assert(
    constructions >= 20,
    `found only ${constructions} ExtensionLoader constructions`,
  );
  assertEquals(
    missing,
    [],
    "These ExtensionLoader constructions pass a repository but no module " +
      "graph reader, so the bundles they build are only fingerprinted over " +
      "the relative imports within the kind's directory. Pass " +
      "createDenoInfoModuleGraphReader as the seventh argument.",
  );
});
