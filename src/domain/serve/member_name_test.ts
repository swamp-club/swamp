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

import { assertEquals, assertThrows } from "@std/assert";
import {
  MAX_MEMBER_NAME_LENGTH,
  MemberName,
  MemberNameError,
} from "./member_name.ts";

Deno.test("MemberName.create: accepts letters, digits, dash and underscore", () => {
  for (const value of ["hub", "edge-1", "EU_west", "a".repeat(64)]) {
    assertEquals(MemberName.create(value).value, value);
  }
});

Deno.test("MemberName.create: refuses empty, long, punctuated and non-string names", () => {
  for (
    const value of [
      "",
      "a".repeat(MAX_MEMBER_NAME_LENGTH + 1),
      "a.b",
      "a/b",
      "../x",
      "a b",
      "é",
      3,
      null,
    ]
  ) {
    assertThrows(() => MemberName.create(value), MemberNameError);
  }
});

Deno.test("MemberName.problem: never echoes the refused value", () => {
  const reason = MemberName.problem("secret.value");
  assertEquals(reason?.includes("secret"), false);
  assertEquals(MemberName.problem("fine"), undefined);
});

Deno.test("MemberName.equals: compares by value", () => {
  assertEquals(MemberName.create("a").equals(MemberName.create("a")), true);
  assertEquals(MemberName.create("a").equals(MemberName.create("A")), false);
  assertEquals(JSON.stringify(MemberName.create("a")), '"a"');
});
