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
import { parseSubject, subjectToString } from "./subject.ts";

Deno.test("parseSubject: parses user subject", () => {
  const s = parseSubject("user:adam");
  assertEquals(s, { kind: "user", name: "adam" });
});

Deno.test("parseSubject: parses group subject", () => {
  const s = parseSubject("group:release-managers");
  assertEquals(s, { kind: "group", name: "release-managers" });
});

Deno.test("parseSubject: parses idp-group subject", () => {
  const s = parseSubject("idp-group:platform-eng");
  assertEquals(s, { kind: "idp-group", name: "platform-eng" });
});

Deno.test("parseSubject: handles name containing colons", () => {
  const s = parseSubject("group:team:alpha");
  assertEquals(s, { kind: "group", name: "team:alpha" });
});

Deno.test("parseSubject: rejects missing colon", () => {
  assertThrows(
    () => parseSubject("useradam"),
    Error,
    "expected",
  );
});

Deno.test("parseSubject: rejects empty name", () => {
  assertThrows(
    () => parseSubject("user:"),
    Error,
    "name cannot be empty",
  );
});

Deno.test("parseSubject: rejects invalid kind", () => {
  assertThrows(
    () => parseSubject("worker:build-1"),
    Error,
    'expected "user", "group", or "idp-group"',
  );
});

Deno.test("subjectToString: roundtrips with parseSubject", () => {
  const original = "idp-group:platform-eng";
  const parsed = parseSubject(original);
  assertEquals(subjectToString(parsed), original);
});
