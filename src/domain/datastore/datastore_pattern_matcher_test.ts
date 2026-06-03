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
import { globToRegExp, isExcluded } from "./datastore_pattern_matcher.ts";

Deno.test("globToRegExp - matches simple wildcard", () => {
  const regex = globToRegExp("*.json");
  assertEquals(regex.test("foo.json"), true);
  assertEquals(regex.test("bar.json"), true);
  assertEquals(regex.test("foo.yaml"), false);
  // * should not match path separators
  assertEquals(regex.test("dir/foo.json"), false);
});

Deno.test("globToRegExp - matches double-star glob", () => {
  const regex = globToRegExp("telemetry/**");
  assertEquals(regex.test("telemetry/foo.json"), true);
  assertEquals(regex.test("telemetry/sub/bar.json"), true);
  assertEquals(regex.test("telemetry/"), true);
  assertEquals(regex.test("audit/foo.json"), false);
});

Deno.test("globToRegExp - matches question mark", () => {
  const regex = globToRegExp("file?.txt");
  assertEquals(regex.test("file1.txt"), true);
  assertEquals(regex.test("fileA.txt"), true);
  assertEquals(regex.test("file.txt"), false);
  assertEquals(regex.test("file12.txt"), false);
});

Deno.test("globToRegExp - matches character class", () => {
  const regex = globToRegExp("file[0-9].txt");
  assertEquals(regex.test("file5.txt"), true);
  assertEquals(regex.test("filea.txt"), false);
});

Deno.test("globToRegExp - matches **/ prefix for any directory depth", () => {
  const regex = globToRegExp("**/temp-*");
  assertEquals(regex.test("temp-foo"), true);
  assertEquals(regex.test("data/temp-bar"), true);
  assertEquals(regex.test("data/sub/temp-baz"), true);
  assertEquals(regex.test("data/sub/normal"), false);
});

Deno.test("isExcluded - empty patterns means nothing excluded", () => {
  assertEquals(isExcluded("telemetry/foo.json", []), false);
});

Deno.test("isExcluded - simple exclusion", () => {
  assertEquals(isExcluded("telemetry/foo.json", ["telemetry/**"]), true);
  assertEquals(isExcluded("audit/foo.json", ["telemetry/**"]), false);
});

Deno.test("isExcluded - negation re-includes", () => {
  const patterns = [
    "data/**/temp-*",
    "!data/**/temp-important",
  ];
  assertEquals(isExcluded("data/foo/temp-scratch", patterns), true);
  // ! pattern re-includes temp-important
  assertEquals(isExcluded("data/foo/temp-important", patterns), false);
  assertEquals(isExcluded("data/bar/temp-important", patterns), false);
});

Deno.test("isExcluded - later patterns override earlier ones", () => {
  const patterns = [
    "telemetry/**",
    "!telemetry/important.json",
  ];
  assertEquals(isExcluded("telemetry/foo.json", patterns), true);
  assertEquals(isExcluded("telemetry/important.json", patterns), false);
});

Deno.test("isExcluded - comments and blank lines are ignored", () => {
  const patterns = [
    "# This is a comment",
    "",
    "telemetry/**",
  ];
  assertEquals(isExcluded("telemetry/foo.json", patterns), true);
});

Deno.test("isExcluded - leading slash is normalized", () => {
  assertEquals(isExcluded("/telemetry/foo.json", ["telemetry/**"]), true);
});
