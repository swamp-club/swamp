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
  parsePrincipal,
  parsePrincipalOfKinds,
  principalLabel,
  principalToString,
} from "./principal.ts";

Deno.test("principalLabel: names a user by the recorded username", () => {
  assertEquals(principalLabel("user:0f3a-sub", "alice"), "user:alice");
});

Deno.test("principalLabel: falls back to the recorded principal without a username", () => {
  assertEquals(principalLabel("user:0f3a-sub", undefined), "user:0f3a-sub");
  assertEquals(principalLabel("user:0f3a-sub", ""), "user:0f3a-sub");
});

Deno.test("principalLabel: a token principal whose id is the username reads the same", () => {
  assertEquals(principalLabel("user:stack72", "stack72"), "user:stack72");
  assertEquals(principalLabel("user:stack72", undefined), "user:stack72");
});

Deno.test("principalLabel: ignores a username on a principal that is not a user", () => {
  assertEquals(principalLabel("worker:w1", "alice"), "worker:w1");
  assertEquals(principalLabel("alice-laptop", "alice"), "alice-laptop");
});

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
    'expected "user", "worker" or "service"',
  );
});

Deno.test("principalToString: roundtrips with parsePrincipal", () => {
  const original = "worker:my-worker";
  const parsed = parsePrincipal(original);
  assertEquals(principalToString(parsed), original);
});

Deno.test("parsePrincipal: parses service principal", () => {
  const p = parsePrincipal("service:scheduler");
  assertEquals(p, { kind: "service", id: "scheduler" });
});

Deno.test("parsePrincipal: rejects a service id that is not built in", () => {
  assertThrows(
    () => parsePrincipal("service:webhooks"),
    Error,
    'expected "service:scheduler" or "service:webhook"',
  );
});

Deno.test("parsePrincipalOfKinds: names only the accepted kinds", () => {
  assertThrows(
    () => parsePrincipalOfKinds("adam", ["user", "worker"]),
    Error,
    'expected "user:<id>" or "worker:<id>"',
  );
  assertThrows(
    () => parsePrincipalOfKinds("service:scheduler", ["user", "worker"]),
    Error,
    'expected "user" or "worker"',
  );
});
