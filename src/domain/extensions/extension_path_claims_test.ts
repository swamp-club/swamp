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
import {
  canonicalClaimPath,
  claimsPath,
  findClaimants,
  pathCovers,
} from "./extension_path_claims.ts";

Deno.test("canonicalClaimPath: normalises separators, case and trailing slash", () => {
  assertEquals(
    canonicalClaimPath(".claude\\Skills\\Foo\\"),
    ".claude/skills/foo",
  );
});

Deno.test("canonicalClaimPath: NFC-normalises decomposed characters", () => {
  // "é" as e + combining acute (NFD) vs the precomposed code point (NFC).
  assertEquals(
    canonicalClaimPath(".claude/skills/café"),
    canonicalClaimPath(".claude/skills/café"),
  );
});

Deno.test("pathCovers: equal paths and paths under the dir", () => {
  assertEquals(pathCovers(".claude/skills/foo", ".claude/skills/foo"), true);
  assertEquals(
    pathCovers(".claude/skills/foo", ".claude/skills/foo/SKILL.md"),
    true,
  );
});

Deno.test("pathCovers: a sibling sharing a prefix is not covered", () => {
  assertEquals(
    pathCovers(".claude/skills/foo", ".claude/skills/foobar/SKILL.md"),
    false,
  );
});

Deno.test("pathCovers: a parent is not covered by its child", () => {
  assertEquals(
    pathCovers(".claude/skills/foo/SKILL.md", ".claude/skills/foo"),
    false,
  );
});

Deno.test("claimsPath: a root entry or a file under it claims the root", () => {
  assertEquals(claimsPath([".claude/skills/foo"], ".claude/skills/foo"), true);
  assertEquals(
    claimsPath([".claude\\skills\\FOO\\SKILL.md"], ".claude/skills/foo"),
    true,
  );
  assertEquals(claimsPath([".claude/skills/bar"], ".claude/skills/foo"), false);
});

Deno.test("findClaimants: returns other entries that claim the path, sorted", () => {
  const entries = {
    "@t/self": { files: [".claude/skills/foo"] },
    "@t/zeta": { files: [".claude/skills/Foo/extra.md"] },
    "@t/alpha": { files: [".claude\\skills\\foo"] },
    "@t/other": { files: [".claude/skills/bar"] },
    "@t/empty": {},
  };
  assertEquals(
    findClaimants(".claude/skills/foo", "@t/self", entries),
    ["@t/alpha", "@t/zeta"],
  );
});

Deno.test("findClaimants: an ancestor dir in another entry does not claim a file", () => {
  const entries = {
    "@t/owner": { files: [".claude/skills/foo"] },
  };
  assertEquals(
    findClaimants(".claude/skills/foo/SKILL.md", "@t/merger", entries),
    [],
  );
});
