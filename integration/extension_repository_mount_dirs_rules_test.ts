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

// every production ExtensionRepository must be built with mountedSourceDirs, or
// saveAll prunes the catalog rows of sources mounted from outside the repo root

import { assert, assertEquals } from "@std/assert";
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const CONSTRUCTION = "new ExtensionRepository(";

function constructorArguments(source: string, start: number): string {
  let depth = 0;
  for (let i = start + CONSTRUCTION.length - 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

Deno.test("extension repository: production constructions pass mountedSourceDirs (swamp-club#2563)", async () => {
  const missing: string[] = [];
  let constructions = 0;
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel.includes("/test_helpers/")) continue;
    const source = await Deno.readTextFile(filePath);
    let at = source.indexOf(CONSTRUCTION);
    while (at >= 0) {
      constructions++;
      if (!/\bmountedSourceDirs\b/.test(constructorArguments(source, at))) {
        const line = source.slice(0, at).split("\n").length;
        missing.push(`${rel}:${line}`);
      }
      at = source.indexOf(CONSTRUCTION, at + CONSTRUCTION.length);
    }
  }
  // Guards the scan itself: a change to how files are found must not make
  // the rule pass by matching nothing.
  assert(
    constructions >= 19,
    `found only ${constructions} ExtensionRepository constructions`,
  );
  assertEquals(
    missing,
    [],
    "These ExtensionRepository constructions omit mountedSourceDirs, so " +
      "their saves delete the catalog rows of sources mounted from outside " +
      "the repo. Pass resolveMountedSourceDirs(repoDir) (or " +
      "flattenSourceKindDirs of sources already resolved).",
  );
});
