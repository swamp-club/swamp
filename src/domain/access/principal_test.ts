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
import { parsePrincipal, principalToString } from "./principal.ts";

Deno.test("parsePrincipal: parses user principal", () => {
  const p = parsePrincipal("user:adam");
  assertEquals(p, { kind: "user", id: "adam" });
});

Deno.test("parsePrincipal: parses worker principal", () => {
  const p = parsePrincipal("worker:build-runner-1");
  assertEquals(p, { kind: "worker", id: "build-runner-1" });
});

Deno.test("parsePrincipal: handles id containing colons", () => {
  const p = parsePrincipal("user:some:complex:id");
  assertEquals(p, { kind: "user", id: "some:complex:id" });
});

Deno.test("parsePrincipal: rejects missing colon", () => {
  assertThrows(
    () => parsePrincipal("useradam"),
    Error,
    "expected",
  );
});

Deno.test("parsePrincipal: rejects empty id", () => {
  assertThrows(
    () => parsePrincipal("user:"),
    Error,
    "id cannot be empty",
  );
});

Deno.test("parsePrincipal: rejects invalid kind", () => {
  assertThrows(
    () => parsePrincipal("group:admins"),
    Error,
    'expected "user" or "worker"',
  );
});

Deno.test("principalToString: roundtrips with parsePrincipal", () => {
  const original = "worker:my-worker";
  const parsed = parsePrincipal(original);
  assertEquals(principalToString(parsed), original);
});
