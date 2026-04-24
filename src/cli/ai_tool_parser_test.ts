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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import { parseAiToolOrThrow, VALID_AI_TOOLS } from "./ai_tool_parser.ts";

Deno.test("parseAiToolOrThrow: accepts every valid tool name", () => {
  for (const tool of VALID_AI_TOOLS) {
    assertEquals(parseAiToolOrThrow(tool), tool);
  }
});

Deno.test("parseAiToolOrThrow: rejects unknown tool names with a list of valid values", () => {
  const err = assertThrows(
    () => parseAiToolOrThrow("foo"),
    UserError,
  );
  assertStringIncludes(err.message, "`foo`");
  assertStringIncludes(err.message, "claude");
  assertStringIncludes(err.message, "kiro");
});

Deno.test("parseAiToolOrThrow: rejects an empty string", () => {
  assertThrows(() => parseAiToolOrThrow(""), UserError);
});

Deno.test("parseAiToolOrThrow: is case-sensitive", () => {
  assertThrows(() => parseAiToolOrThrow("Claude"), UserError);
  assertThrows(() => parseAiToolOrThrow("CURSOR"), UserError);
});
