// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import { RepoPath } from "./repo_path.ts";

Deno.test("RepoPath.create accepts absolute path", () => {
  const path = RepoPath.create("/home/user/repo");
  assertEquals(path.value, "/home/user/repo");
  assertEquals(path.toString(), "/home/user/repo");
});

Deno.test("RepoPath.create converts relative path to absolute", () => {
  const path = RepoPath.create("./my-repo");
  // Should be absolute (starts with /)
  assertEquals(path.value.startsWith("/"), true);
  // Should contain the relative path component
  assertEquals(path.value.includes("my-repo"), true);
});

Deno.test("RepoPath.create converts bare relative path to absolute", () => {
  const path = RepoPath.create("my-repo");
  assertEquals(path.value.startsWith("/"), true);
  assertEquals(path.value.endsWith("my-repo"), true);
});

Deno.test("RepoPath.create trims whitespace", () => {
  const path = RepoPath.create("  /home/user/repo  ");
  assertEquals(path.value, "/home/user/repo");
});

Deno.test("RepoPath.create throws on empty string", () => {
  assertThrows(
    () => RepoPath.create(""),
    Error,
    "Repository path cannot be empty",
  );
});

Deno.test("RepoPath.create throws on whitespace-only string", () => {
  assertThrows(
    () => RepoPath.create("   "),
    Error,
    "Repository path cannot be empty",
  );
});

Deno.test("RepoPath.equals returns true for same paths", () => {
  const p1 = RepoPath.create("/home/user/repo");
  const p2 = RepoPath.create("/home/user/repo");
  assertEquals(p1.equals(p2), true);
});

Deno.test("RepoPath.equals returns false for different paths", () => {
  const p1 = RepoPath.create("/home/user/repo1");
  const p2 = RepoPath.create("/home/user/repo2");
  assertEquals(p1.equals(p2), false);
});
