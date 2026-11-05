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
import { clientToString, parseClient } from "./client.ts";

Deno.test("parseClient: accepts each direct id", () => {
  for (const id of ["cli", "dashboard", "token"]) {
    assertEquals(parseClient(`direct:${id}`), { kind: "direct", id });
  }
});

Deno.test("parseClient: accepts an integration id", () => {
  assertEquals(parseClient("integration:ops-slack"), {
    kind: "integration",
    id: "ops-slack",
  });
});

Deno.test("parseClient: an integration may share a direct id without colliding", () => {
  assertEquals(
    clientToString(parseClient("integration:cli")) === "direct:cli",
    false,
  );
});

Deno.test("parseClient: refuses a direct id outside the fixed list", () => {
  assertThrows(() => parseClient("direct:ops-slack"), Error, "direct id");
});

Deno.test("parseClient: refuses an unknown kind", () => {
  assertThrows(() => parseClient("agent:cli"), Error, "client kind");
});

Deno.test("parseClient: refuses a value with no kind", () => {
  assertThrows(() => parseClient("cli"), Error, "<kind>:<id>");
});

Deno.test("parseClient: refuses a malformed integration id", () => {
  for (const id of ["", "Ops", "-x", "a:b", "a b", "a".repeat(64)]) {
    assertThrows(() => parseClient(`integration:${id}`), Error, "integration");
  }
});
