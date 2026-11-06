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

Deno.test("ResourceAttributeBudget: rejects a negative or fractional cap", () => {
  assertThrows(() => new ResourceAttributeBudget(-1), RangeError);
  assertThrows(() => new ResourceAttributeBudget(1.5), RangeError);
});
