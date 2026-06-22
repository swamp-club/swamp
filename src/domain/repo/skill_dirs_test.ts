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
import { assertPathStringIncludes } from "../../infrastructure/persistence/path_test_helpers.ts";
import { SEPARATOR } from "@std/path";
import {
  GLOBAL_SKILL_DIRS,
  resolveGlobalSkillsDir,
  resolveUniqueGlobalSkillsDirs,
} from "./skill_dirs.ts";

Deno.test("GLOBAL_SKILL_DIRS: claude uses vendor-specific path", () => {
  assertEquals(GLOBAL_SKILL_DIRS["claude"], ".claude/skills");
});

Deno.test("GLOBAL_SKILL_DIRS: kiro uses vendor-specific path", () => {
  assertEquals(GLOBAL_SKILL_DIRS["kiro"], ".kiro/skills");
});

Deno.test("GLOBAL_SKILL_DIRS: codex/cursor/opencode/copilot share .agents/skills", () => {
  assertEquals(GLOBAL_SKILL_DIRS["codex"], ".agents/skills");
  assertEquals(GLOBAL_SKILL_DIRS["cursor"], ".agents/skills");
  assertEquals(GLOBAL_SKILL_DIRS["opencode"], ".agents/skills");
  assertEquals(GLOBAL_SKILL_DIRS["copilot"], ".agents/skills");
});

Deno.test("resolveGlobalSkillsDir: returns absolute path under home", () => {
  const dir = resolveGlobalSkillsDir("claude");
  assertEquals(dir !== null, true);
  assertPathStringIncludes(dir!, `.claude${SEPARATOR}skills`);
});

Deno.test("resolveGlobalSkillsDir: returns null for none", () => {
  assertEquals(resolveGlobalSkillsDir("none"), null);
});

Deno.test("resolveGlobalSkillsDir: returns null for unknown tool", () => {
  assertEquals(resolveGlobalSkillsDir("unknown-tool"), null);
});

Deno.test("resolveUniqueGlobalSkillsDirs: deduplicates shared paths", () => {
  const dirs = resolveUniqueGlobalSkillsDirs([
    "claude",
    "codex",
    "cursor",
    "opencode",
    "copilot",
    "kiro",
  ]);
  assertEquals(dirs.length, 3);
  assertPathStringIncludes(dirs[0], `.claude${SEPARATOR}skills`);
  assertPathStringIncludes(dirs[1], `.agents${SEPARATOR}skills`);
  assertPathStringIncludes(dirs[2], `.kiro${SEPARATOR}skills`);
});

Deno.test("resolveUniqueGlobalSkillsDirs: skips none tool", () => {
  const dirs = resolveUniqueGlobalSkillsDirs(["claude", "none"]);
  assertEquals(dirs.length, 1);
});

Deno.test("resolveUniqueGlobalSkillsDirs: empty tools returns empty", () => {
  const dirs = resolveUniqueGlobalSkillsDirs([]);
  assertEquals(dirs.length, 0);
});
