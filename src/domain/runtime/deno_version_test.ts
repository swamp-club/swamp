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
import { DenoVersion } from "./deno_version.ts";

Deno.test("DenoVersion.create creates version from string", () => {
  const v = DenoVersion.create("2.6.5");
  assertEquals(v.value, "2.6.5");
});

Deno.test("DenoVersion.create trims whitespace", () => {
  const v = DenoVersion.create("  2.6.5  ");
  assertEquals(v.value, "2.6.5");
});

Deno.test("DenoVersion.create throws on empty string", () => {
  assertThrows(() => DenoVersion.create(""), Error, "cannot be empty");
});

Deno.test("DenoVersion.create throws on whitespace-only string", () => {
  assertThrows(() => DenoVersion.create("   "), Error, "cannot be empty");
});

Deno.test("DenoVersion.equals returns true for same version", () => {
  const a = DenoVersion.create("2.6.5");
  const b = DenoVersion.create("2.6.5");
  assertEquals(a.equals(b), true);
});

Deno.test("DenoVersion.equals returns false for different versions", () => {
  const a = DenoVersion.create("2.6.5");
  const b = DenoVersion.create("2.7.0");
  assertEquals(a.equals(b), false);
});

Deno.test("DenoVersion.fromVersionOutput parses deno --version output", () => {
  const output =
    "deno 2.6.5 (stable, release, x86_64-unknown-linux-gnu)\nv8 13.7.152.6\ntypescript 5.7.3";
  const v = DenoVersion.fromVersionOutput(output);
  assertEquals(v.value, "2.6.5");
});

Deno.test("DenoVersion.fromVersionOutput throws on invalid output", () => {
  assertThrows(
    () => DenoVersion.fromVersionOutput("not a version"),
    Error,
    "Cannot parse",
  );
});

Deno.test("DenoVersion.toString returns version string", () => {
  const v = DenoVersion.create("2.6.5");
  assertEquals(v.toString(), "2.6.5");
});
