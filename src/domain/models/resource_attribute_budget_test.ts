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
  jsonByteLengthWithin,
  RESOURCE_ATTRIBUTE_CAP_BYTES,
  ResourceAttributeBudget,
} from "./resource_attribute_budget.ts";

Deno.test("ResourceAttributeBudget: defaults to the shared cap", () => {
  assertEquals(
    new ResourceAttributeBudget().capBytes,
    RESOURCE_ATTRIBUTE_CAP_BYTES,
  );
});

Deno.test("ResourceAttributeBudget: admits resources up to the cap exactly", () => {
  const budget = new ResourceAttributeBudget(10);
  assertEquals(budget.admit(4), true);
  assertEquals(budget.admit(6), true);
  assertEquals(budget.admittedBytes, 10);
  assertEquals(budget.exhausted, false);
});

Deno.test("ResourceAttributeBudget: refuses every resource after the first refusal", () => {
  const budget = new ResourceAttributeBudget(10);
  assertEquals(budget.admit(8), true);
  assertEquals(budget.admit(5), false);
  assertEquals(budget.admit(1), false);
  assertEquals(budget.admittedBytes, 8);
  assertEquals(budget.exhausted, true);
});

Deno.test("ResourceAttributeBudget: a zero cap admits only empty content", () => {
  const budget = new ResourceAttributeBudget(0);
  assertEquals(budget.admit(0), true);
  assertEquals(budget.admit(1), false);
});

Deno.test("ResourceAttributeBudget: refuses a size that is not a byte count, and everything after it", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const budget = new ResourceAttributeBudget(10);
    assertEquals(budget.admit(bad), false);
    assertEquals(budget.admit(1), false);
    assertEquals(budget.admittedBytes, 0);
  }
});

Deno.test("ResourceAttributeBudget: rejects a negative or fractional cap", () => {
  assertThrows(() => new ResourceAttributeBudget(-1), RangeError);
  assertThrows(() => new ResourceAttributeBudget(1.5), RangeError);
});

Deno.test("jsonByteLengthWithin: counts the UTF-8 bytes JSON.stringify would produce", () => {
  const value = { a: [1, null, "é\n", { b: undefined }], c: true, d: "💧" };
  assertEquals(
    jsonByteLengthWithin(value, 1000),
    new TextEncoder().encode(JSON.stringify(value)).length,
  );
});

Deno.test("jsonByteLengthWithin: a value too large for one string is refused without throwing", () => {
  const mebibyte = "x".repeat(1024 * 1024);
  const huge = Array.from({ length: 1024 }, () => mebibyte);
  assertEquals(jsonByteLengthWithin(huge, 16 * 1024 * 1024), undefined);
});

function nestedArrays(depth: number): unknown {
  let value: unknown = [0, 1, 2];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

Deno.test("jsonByteLengthWithin: a value nested past the native stringify depth is measured without throwing", () => {
  const depth = 100_000;
  const value = { i: 0, tree: nestedArrays(depth) };
  const expected = '{"i":0,"tree":}'.length + 2 * depth + "[0,1,2]".length;
  assertEquals(jsonByteLengthWithin(value, 16 * 1024 * 1024), expected);
  assertEquals(jsonByteLengthWithin(value, expected - 1), undefined);
});
