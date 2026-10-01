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

// Every mark crosses buildMarkDirtyHook, and the datastore refactor keeps it
// in the legacy adapter (swamp-club#2862). These properties pin its path
// mapping over generated paths under the cache root and the repo's .swamp.

import { assert, assertEquals } from "@std/assert";
import { isAbsolute, join, resolve } from "@std/path";
import fc from "fast-check";
import { createRecordingSyncService } from "@swamp-club/swamp-testing";
import { assertPathEquals } from "../infrastructure/persistence/path_test_helpers.ts";
import { buildMarkDirtyHook } from "./repo_context.ts";

const BASE = resolve("mark-dirty-hook-property");
const CACHE_ROOT = join(BASE, "cache");
const REPO_DIR = join(BASE, "repo");
const REPO_SWAMP = join(REPO_DIR, ".swamp");

/**
 * One path segment: letters, digits, spaces, dots, unicode and `-_`, never
 * exactly `.` or `..`. Names that start with two dots (`..x`) are included:
 * they sit inside the root.
 */
const arbSegment = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.stringOf(
      fc.constantFrom(..."abcXYZ019 .-_é日".split("")),
      { minLength: 1, maxLength: 12 },
    ).filter((s) => s !== "." && s !== ".." && s.trim() === s),
  },
  // Random strings rarely start with two dots; make sure these come up.
  { weight: 1, arbitrary: fc.constantFrom("..hidden", "...", "..a b", "..é") },
);

const arbSegments = fc.array(arbSegment, { minLength: 1, maxLength: 5 });

const arbRoot = fc.constantFrom(CACHE_ROOT, REPO_SWAMP);

async function marksFor(absPath: string | undefined) {
  const { service, marks } = createRecordingSyncService();
  const hook = buildMarkDirtyHook(service, CACHE_ROOT, REPO_DIR);
  await hook(absPath);
  return marks;
}

Deno.test("buildMarkDirtyHook property: a path under either root marks a relative forward-slash path", async () => {
  await fc.assert(
    fc.asyncProperty(arbRoot, arbSegments, async (root, segments) => {
      const marks = await marksFor(join(root, ...segments));
      assertEquals(marks.length, 1);
      const mark = marks[0];
      assert(mark !== undefined, "expected a per-path mark, not a bare one");
      assert(!isAbsolute(mark), `mark must be relative: ${mark}`);
      assert(!mark.includes("\\"), `mark must use forward slashes: ${mark}`);
      assert(
        mark.split("/")[0] !== "..",
        `mark must not escape the root: ${mark}`,
      );
      assertEquals(mark, segments.join("/"));
    }),
    { numRuns: 200 },
  );
});

Deno.test("buildMarkDirtyHook property: the same input always gives the same mark", async () => {
  await fc.assert(
    fc.asyncProperty(arbRoot, arbSegments, async (root, segments) => {
      const path = join(root, ...segments);
      assertEquals(await marksFor(path), await marksFor(path));
    }),
    { numRuns: 100 },
  );
});

Deno.test("buildMarkDirtyHook property: a path outside both roots sends no mark", async () => {
  // Siblings whose names extend a root's name (`cache-other`, `cache..x`)
  // are outside it.
  const arbOutsideDir = fc.oneof(
    fc.constantFrom(
      join(BASE, "cache-other"),
      join(BASE, "cacheother"),
      join(BASE, "cache..x"),
      join(REPO_DIR, ".swamp-other"),
      join(REPO_DIR, "models"),
      join(BASE, "elsewhere"),
    ),
    arbSegment.map((s) => join(BASE, `x${s}`)),
  );
  await fc.assert(
    fc.asyncProperty(arbOutsideDir, arbSegments, async (dir, segments) => {
      assertEquals(await marksFor(join(dir, ...segments)), []);
    }),
    { numRuns: 200 },
  );
});

Deno.test("buildMarkDirtyHook property: an absent path gives exactly one bare mark", async () => {
  assertEquals(await marksFor(undefined), [undefined]);
});

Deno.test("buildMarkDirtyHook property: a cache mark joined back onto the cache root is the original path", async () => {
  await fc.assert(
    fc.asyncProperty(arbSegments, async (segments) => {
      const path = join(CACHE_ROOT, ...segments);
      const [mark] = await marksFor(path);
      assert(mark !== undefined);
      assertPathEquals(join(CACHE_ROOT, ...mark.split("/")), path);
    }),
    { numRuns: 200 },
  );
});
