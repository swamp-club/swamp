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

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_WORKSPACE_NAME,
  parseWorkspaceName,
  suggestWorkspaceName,
} from "./workspace_name.ts";
import { UserError } from "../errors.ts";

Deno.test("parseWorkspaceName: accepts the default and simple names", () => {
  assertEquals(parseWorkspaceName(DEFAULT_WORKSPACE_NAME), "first-workspace");
  for (const name of ["a", "0", "team-2", "a".repeat(63)]) {
    assertEquals(parseWorkspaceName(name), name);
  }
});

Deno.test("parseWorkspaceName: refuses anything that is not one lowercase segment", () => {
  for (
    const name of [
      "",
      "-lead",
      "Upper",
      "has space",
      "a/b",
      "a\\b",
      "..",
      ".hidden",
      "under_score",
      "a".repeat(64),
      "a\n",
    ]
  ) {
    assertThrows(
      () => parseWorkspaceName(name),
      UserError,
      "Invalid workspace name",
    );
  }
});

const SUGGESTION_PATTERN = /^[a-z]+-[a-z]+(?:-[a-z]+)?(?:-\d+)?$/;

/** A random source that returns `values` in turn, repeating the last. */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

Deno.test("suggestWorkspaceName: is an adjective-creature name that parses", () => {
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    const name = suggestWorkspaceName(new Set(), () => r);
    assert(SUGGESTION_PATTERN.test(name), name);
    assertEquals(parseWorkspaceName(name), name);
  }
  assertEquals(suggestWorkspaceName(new Set(), () => 0), "amber-alligator");
});

Deno.test("suggestWorkspaceName: draws again when the first name is taken", () => {
  // Draws 1-2 give amber-alligator (taken), draws 3-4 give a free name.
  const name = suggestWorkspaceName(
    new Set(["amber-alligator"]),
    sequence(0, 0, 0.999999, 0.999999),
  );
  assertEquals(name, "wily-willow");
});

Deno.test("suggestWorkspaceName: adds a numeric suffix when the random source keeps clashing", () => {
  assertEquals(
    suggestWorkspaceName(new Set(["amber-alligator"]), () => 0),
    "amber-alligator-2",
  );
  const taken = new Set([
    "amber-alligator",
    "amber-alligator-2",
    "amber-alligator-3",
  ]);
  const name = suggestWorkspaceName(taken, () => 0);
  assertEquals(name, "amber-alligator-4");
  assertEquals(parseWorkspaceName(name), name);
});

Deno.test("suggestWorkspaceName: tolerates a random source that returns 1", () => {
  const name = suggestWorkspaceName(new Set(), () => 1);
  assertEquals(parseWorkspaceName(name), name);
});
