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

import { assert, assertEquals, assertFalse } from "@std/assert";
import { makeBundleLocation } from "./bundle_location.ts";
import {
  isVisibleToResolver,
  ROW_STATE_TAGS,
  type RowState,
} from "./row_state.ts";

const FP = "abc123";
const BUNDLE = makeBundleLocation("/repo/.swamp/bundles/foo.js", FP);

Deno.test("ROW_STATE_TAGS: enumerates all 7 tags exactly once", () => {
  assertEquals(ROW_STATE_TAGS.length, 7);
  assertEquals(new Set(ROW_STATE_TAGS).size, 7);
  assertEquals(
    [...ROW_STATE_TAGS].sort(),
    [
      "BundleBuildFailed",
      "Bundled",
      "EntryPointUnreadable",
      "Indexed",
      "OrphanedBundleOnly",
      "Tombstoned",
      "ValidationFailed",
    ],
  );
});

Deno.test("isVisibleToResolver: only Indexed is visible", () => {
  // Build one fixture per tag to prove the predicate's exhaustiveness.
  const fixtures: RowState[] = [
    { tag: "Indexed", type: "@scope/foo/instance", bundle: BUNDLE },
    {
      tag: "Bundled",
      type: "@scope/foo/instance",
      bundle: BUNDLE,
      loadedInProcess: false,
    },
    { tag: "BundleBuildFailed", lastError: "deno bundle exit 1" },
    { tag: "ValidationFailed", bundle: BUNDLE, lastError: "schema mismatch" },
    { tag: "EntryPointUnreadable", lastError: "EACCES" },
    { tag: "OrphanedBundleOnly", bundle: BUNDLE },
    { tag: "Tombstoned", reason: "source-deleted" },
  ];
  assertEquals(fixtures.length, ROW_STATE_TAGS.length);

  for (const state of fixtures) {
    if (state.tag === "Indexed") {
      assert(isVisibleToResolver(state));
    } else {
      assertFalse(isVisibleToResolver(state));
    }
  }
});

Deno.test("RowState: switch over tag is exhaustive (compile-time check)", () => {
  // This test exists to assert a compile-time guarantee: a switch over
  // RowState.tag with no default branch must cover all 7 tags. If a new
  // tag is added without updating consumers, this test will stop compiling.
  function describe(state: RowState): string {
    switch (state.tag) {
      case "Indexed":
        return "indexed";
      case "Bundled":
        return "bundled";
      case "BundleBuildFailed":
        return "build-failed";
      case "ValidationFailed":
        return "validation-failed";
      case "EntryPointUnreadable":
        return "entry-unreadable";
      case "OrphanedBundleOnly":
        return "orphan";
      case "Tombstoned":
        return "tombstone";
    }
  }
  assertEquals(
    describe({ tag: "Indexed", type: "x", bundle: BUNDLE }),
    "indexed",
  );
});
