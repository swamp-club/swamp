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

import { assert, assertEquals } from "@std/assert";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";

Deno.test("fuzzyMatch: empty query matches everything", () => {
  assertEquals(fuzzyMatch("", "deploy-api"), { score: 0, indices: [] });
  assertEquals(fuzzyMatch("   ", "deploy-api"), { score: 0, indices: [] });
});

Deno.test("fuzzyMatch: subsequence, case-insensitive", () => {
  const m = fuzzyMatch("DPA", "deploy-api");
  assert(m);
  assertEquals(m.indices, [0, 2, 7]);
});

Deno.test("fuzzyMatch: every term must match", () => {
  assert(fuzzyMatch("dep api", "deploy-api"));
  assertEquals(fuzzyMatch("dep xyz", "deploy-api"), null);
  assertEquals(fuzzyMatch("zz", "deploy-api"), null);
});

Deno.test("fuzzyMatch: a word-start match outranks one mid-word", () => {
  const tight = fuzzyMatch("api", "deploy-api")!;
  const loose = fuzzyMatch("api", "capitalize")!;
  assert(tight.score > loose.score);
});

Deno.test("fuzzyMatch: finds the best start, not just the first", () => {
  // The first "a" is inside "data"; the word-start "api" should win.
  const m = fuzzyMatch("api", "data-api")!;
  assertEquals(m.indices, [5, 6, 7]);
});

Deno.test("fuzzyFilter: ranks by score and drops non-matches", () => {
  const names = ["sync-crm", "deploy-api", "deploy-web", "backup-api-keys"];
  assertEquals(fuzzyFilter(names, "dep api", (n) => [n]), ["deploy-api"]);
  const ranked = fuzzyFilter(names, "api", (n) => [n]);
  assertEquals(ranked, ["deploy-api", "backup-api-keys"]);
});

Deno.test("fuzzyFilter: empty query keeps order", () => {
  const names = ["b", "a", "c"];
  assertEquals(fuzzyFilter(names, "", (n) => [n]), ["b", "a", "c"]);
});

Deno.test("fuzzyFilter: matches any key", () => {
  const items = [{ name: "x", route: "/hooks/github" }, {
    name: "y",
    route: "/z",
  }];
  assertEquals(
    fuzzyFilter(items, "github", (i) => [i.name, i.route]).map((i) => i.name),
    ["x"],
  );
});
