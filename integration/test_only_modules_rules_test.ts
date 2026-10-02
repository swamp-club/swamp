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

// Test-only modules stay out of the shipped CLI. `src/infrastructure/testing/`
// (test datastore types, the unit of work contract suite, subprocess
// harnesses) and `@swamp-club/swamp-testing` (fakes such as the in-memory
// remote) are for tests. Production source under src/ must never import
// them; the testing modules may import each other, and benchmarks may use
// them.

import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const TESTING_DIR = "src/infrastructure/testing/";

// Static (`from "x"`), side-effect (`import "x"`) and dynamic (`import("x")`)
// imports. The shared extractImports helper only sees the first form.
const IMPORT_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

function isTestOnlyImport(specifier: string): boolean {
  return specifier.startsWith("@swamp-club/swamp-testing") ||
    specifier.includes("infrastructure/testing/");
}

/** Files under src/ that are not shipped production code. */
function isTestSupport(rel: string): boolean {
  return rel.startsWith(TESTING_DIR) || /_bench\.tsx?$/.test(rel);
}

async function testOnlyImports(): Promise<string[]> {
  const edges = new Set<string>();
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(path);
    if (isTestSupport(rel)) continue;
    const source = await Deno.readTextFile(path);
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      if (isTestOnlyImport(match[1])) edges.add(`${rel} -> ${match[1]}`);
    }
  }
  return [...edges].sort();
}

// Pinned ratchet: production imports of test-only modules. Empty, and it must
// stay empty.
const PINNED_TEST_ONLY_IMPORTS: readonly string[] = [];

Deno.test("test-only modules: production source never imports src/infrastructure/testing or @swamp-club/swamp-testing (swamp-club#2970)", async () => {
  assertPinnedSet(
    await testOnlyImports(),
    PINNED_TEST_ONLY_IMPORTS,
    "Production imports of test-only modules",
    "Production code must not import test doubles or harnesses. Move the\n" +
      "shared code out of src/infrastructure/testing/ or keep the import in a\n" +
      "_test.ts or _bench.ts file.",
  );
});
