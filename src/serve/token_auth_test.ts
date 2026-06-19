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
import { splitServerToken } from "./token_auth.ts";

// ── splitServerToken ────────────────────────────────────────────────────

Deno.test("splitServerToken: splits valid name.secret", () => {
  const result = splitServerToken("adam-token.abc123def456");
  assertEquals(result, { name: "adam-token", secret: "abc123def456" });
});

Deno.test("splitServerToken: returns null for no dot", () => {
  assertEquals(splitServerToken("no-dot-here"), null);
});

Deno.test("splitServerToken: returns null for leading dot", () => {
  assertEquals(splitServerToken(".leading-dot"), null);
});

Deno.test("splitServerToken: returns null for trailing dot", () => {
  assertEquals(splitServerToken("trailing-dot."), null);
});

Deno.test("splitServerToken: handles dots in secret", () => {
  const result = splitServerToken("my-token.secret.with.dots");
  assertEquals(result, { name: "my-token", secret: "secret.with.dots" });
});

Deno.test("splitServerToken: single-char name and secret", () => {
  const result = splitServerToken("a.b");
  assertEquals(result, { name: "a", secret: "b" });
});
