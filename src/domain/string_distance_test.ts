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

import { assertEquals } from "@std/assert";
import { findClosestMatch, levenshteinDistance } from "./string_distance.ts";

Deno.test("levenshteinDistance - identical strings", () => {
  assertEquals(levenshteinDistance("hello", "hello"), 0);
});

Deno.test("levenshteinDistance - single character difference", () => {
  assertEquals(levenshteinDistance("create", "creat"), 1);
});

Deno.test("levenshteinDistance - transposition", () => {
  assertEquals(levenshteinDistance("modle", "model"), 2);
});

Deno.test("levenshteinDistance - completely different strings", () => {
  const distance = levenshteinDistance("abc", "xyz");
  assertEquals(distance, 3);
});

Deno.test("levenshteinDistance - empty strings", () => {
  assertEquals(levenshteinDistance("", ""), 0);
  assertEquals(levenshteinDistance("abc", ""), 3);
  assertEquals(levenshteinDistance("", "abc"), 3);
});

Deno.test("findClosestMatch - finds close typo", () => {
  const match = findClosestMatch("creat", ["create", "delete", "get"]);
  assertEquals(match, "create");
});

Deno.test("findClosestMatch - finds case-insensitive match", () => {
  const match = findClosestMatch("Create", ["create", "delete", "get"]);
  assertEquals(match, "create");
});

Deno.test("findClosestMatch - returns undefined for distant strings", () => {
  const match = findClosestMatch("hetzner-server", [
    "create",
    "delete",
    "get",
    "search",
  ]);
  assertEquals(match, undefined);
});

Deno.test("findClosestMatch - returns undefined for empty candidates", () => {
  const match = findClosestMatch("create", []);
  assertEquals(match, undefined);
});

Deno.test("findClosestMatch - picks closest of multiple options", () => {
  const match = findClosestMatch("serch", ["search", "source", "schema"]);
  assertEquals(match, "search");
});
