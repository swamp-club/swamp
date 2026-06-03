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
import { canonicalizePath, canonicalizePathFor } from "./canonicalize_path.ts";

// --- POSIX branch (isWindows = false) -----------------------------------

Deno.test("canonicalizePathFor: POSIX returns input unchanged", () => {
  assertEquals(
    canonicalizePathFor("/foo/Bar/Baz.ts", false),
    "/foo/Bar/Baz.ts",
  );
});

Deno.test("canonicalizePathFor: POSIX preserves case", () => {
  assertEquals(
    canonicalizePathFor("/Repo/EXTENSIONS/Models/A.ts", false),
    "/Repo/EXTENSIONS/Models/A.ts",
  );
});

Deno.test("canonicalizePathFor: POSIX preserves backslashes (unusual but legal in POSIX file names)", () => {
  // Backslash is a legal character in POSIX file names. Per the issue's
  // "raw on POSIX" rule, the canonicalizer must not rewrite it.
  assertEquals(
    canonicalizePathFor("/foo\\bar.ts", false),
    "/foo\\bar.ts",
  );
});

Deno.test("canonicalizePathFor: POSIX empty string is unchanged", () => {
  assertEquals(canonicalizePathFor("", false), "");
});

// --- Windows branch (isWindows = true) ----------------------------------

Deno.test("canonicalizePathFor: Windows lowercases and uses forward slashes", () => {
  assertEquals(
    canonicalizePathFor("C:\\Users\\Foo\\Bar.ts", true),
    "c:/users/foo/bar.ts",
  );
});

Deno.test("canonicalizePathFor: Windows handles mixed slashes", () => {
  assertEquals(
    canonicalizePathFor("C:/Users\\Foo/Bar.ts", true),
    "c:/users/foo/bar.ts",
  );
});

Deno.test("canonicalizePathFor: Windows already-canonical input is idempotent", () => {
  assertEquals(
    canonicalizePathFor("c:/users/foo/bar.ts", true),
    "c:/users/foo/bar.ts",
  );
});

Deno.test("canonicalizePathFor: Windows two surface forms collapse to one canonical form", () => {
  // The whole point of the function — `C:\\Users\\Foo\\Bar.ts` and
  // `c:/users/foo/bar.ts` refer to the same file on NTFS and must produce
  // the same primary key.
  assertEquals(
    canonicalizePathFor("C:\\Users\\Foo\\Bar.ts", true),
    canonicalizePathFor("c:/users/foo/bar.ts", true),
  );
});

Deno.test("canonicalizePathFor: Windows EXTENSIONS/Models/A.ts collapses with extensions/models/a.ts", () => {
  // The fixture pair the W1 plan calls out explicitly for the SourceLocation
  // equality test in W1b — pinning it here as well so the contract is
  // documented at the helper's level.
  assertEquals(
    canonicalizePathFor("EXTENSIONS/Models/A.ts", true),
    canonicalizePathFor("extensions/models/a.ts", true),
  );
});

Deno.test("canonicalizePathFor: Windows empty string is unchanged", () => {
  assertEquals(canonicalizePathFor("", true), "");
});

// --- Default-OS dispatcher ---------------------------------------------

Deno.test("canonicalizePath: dispatches based on Deno.build.os", () => {
  // The default canonicalizePath() reads Deno.build.os. On the test
  // runner's host OS it must match canonicalizePathFor(input, isHostWindows).
  const input = "/foo/Bar.ts";
  const isHostWindows = Deno.build.os === "windows";
  assertEquals(
    canonicalizePath(input),
    canonicalizePathFor(input, isHostWindows),
  );
});
