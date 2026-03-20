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
import { composeDataName } from "./composite_name.ts";

Deno.test("composeDataName: returns base name when vary array is empty", () => {
  assertEquals(composeDataName("result", []), "result");
});

Deno.test("composeDataName: appends single vary value", () => {
  assertEquals(composeDataName("result", ["prod"]), "result-prod");
});

Deno.test("composeDataName: appends multiple vary values", () => {
  assertEquals(
    composeDataName("result", ["prod", "us-east-1"]),
    "result-prod-us-east-1",
  );
});

Deno.test("composeDataName: throws on empty base name", () => {
  assertThrows(
    () => composeDataName("", ["prod"]),
    Error,
    "Base name must be a non-empty string",
  );
});

Deno.test("composeDataName: throws on whitespace-only base name", () => {
  assertThrows(
    () => composeDataName("   ", ["prod"]),
    Error,
    "Base name must be a non-empty string",
  );
});

Deno.test("composeDataName: throws on empty vary value", () => {
  assertThrows(
    () => composeDataName("result", [""]),
    Error,
    "Vary value at index 0 must be a non-empty string",
  );
});

Deno.test("composeDataName: throws on whitespace-only vary value", () => {
  assertThrows(
    () => composeDataName("result", ["prod", "  "]),
    Error,
    "Vary value at index 1 must be a non-empty string",
  );
});

Deno.test("composeDataName: handles numeric-like vary values", () => {
  assertEquals(composeDataName("result", ["42"]), "result-42");
});

Deno.test("composeDataName: throws on vary value with forward slash", () => {
  assertThrows(
    () => composeDataName("result", ["../../etc"]),
    Error,
    "Vary value at index 0 contains path separator characters",
  );
});

Deno.test("composeDataName: throws on vary value with backslash", () => {
  assertThrows(
    () => composeDataName("result", ["foo\\bar"]),
    Error,
    "Vary value at index 0 contains path separator characters",
  );
});

Deno.test("composeDataName: throws on dot-dot vary value", () => {
  assertThrows(
    () => composeDataName("result", [".."]),
    Error,
    "Vary value at index 0 must not be a relative path component",
  );
});

Deno.test("composeDataName: throws on single-dot vary value", () => {
  assertThrows(
    () => composeDataName("result", ["."]),
    Error,
    "Vary value at index 0 must not be a relative path component",
  );
});
