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

// anyMethod lets a methods-scoped allow match a request that names no method;
// only commits whose method cannot be known may set it, so a new setter is a
// widened grant and must be reviewed; comment lines are skipped

import { assertEquals } from "@std/assert";
import { relative } from "@std/path";
import {
  isCommentLine,
  productionSourceFiles,
  ROOT,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";

const PINNED_ANY_METHOD_SETTERS = [
  "src/domain/datastore_v3/commit_authorization.ts",
];

const SETS_ANY_METHOD = /\banyMethod\s*:/;

Deno.test("anyMethod: only datastore commit authorization marks a resource as any method", async () => {
  const setters: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    const sets = source.split("\n").some((line) =>
      !isCommentLine(line) && SETS_ANY_METHOD.test(line)
    );
    if (sets) setters.push(toPosixPath(relative(ROOT, path)));
  }

  assertEquals(
    setters.sort(),
    [...PINNED_ANY_METHOD_SETTERS].sort(),
    "a production file sets anyMethod on an access resource, which lets a " +
      "methods-scoped allow admit a request that names no method. Carry the " +
      "request's method instead; mark anyMethod only where the method cannot " +
      "be known and any method in the grant's scope could have made the " +
      "request, and pin the file here.",
  );
});
