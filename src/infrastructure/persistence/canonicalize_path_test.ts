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
  // backslash is a legal character in POSIX file names, so the canonicalizer
  // must leave it raw
  assertEquals(
    canonicalizePathFor("/foo\\bar.ts", false),
    "/foo\\bar.ts",
  );
});

Deno.test("canonicalizePathFor: POSIX empty string is unchanged", () => {
  assertEquals(canonicalizePathFor("", false), "");
});

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
  // C:\Users\Foo\Bar.ts and c:/users/foo/bar.ts are the same file on NTFS and
  // must give the same primary key
  assertEquals(
    canonicalizePathFor("C:\\Users\\Foo\\Bar.ts", true),
    canonicalizePathFor("c:/users/foo/bar.ts", true),
  );
});

Deno.test("canonicalizePathFor: Windows EXTENSIONS/Models/A.ts collapses with extensions/models/a.ts", () => {
  assertEquals(
    canonicalizePathFor("EXTENSIONS/Models/A.ts", true),
    canonicalizePathFor("extensions/models/a.ts", true),
  );
});

Deno.test("canonicalizePathFor: Windows empty string is unchanged", () => {
  assertEquals(canonicalizePathFor("", true), "");
});

Deno.test("canonicalizePath: dispatches based on Deno.build.os", () => {
  const input = "/foo/Bar.ts";
  const isHostWindows = Deno.build.os === "windows";
  assertEquals(
    canonicalizePath(input),
    canonicalizePathFor(input, isHostWindows),
  );
});
