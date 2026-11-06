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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { ResourceAttributeBudget } from "./resource_attribute_budget.ts";

const arbCap = fc.integer({ min: 0, max: 1_000_000 });
const arbSizes = fc.array(fc.integer({ min: 0, max: 200_000 }), {
  maxLength: 60,
});

Deno.test("ResourceAttributeBudget: admitted bytes never pass the cap", () => {
  fc.assert(fc.property(arbCap, arbSizes, (cap, sizes) => {
    const budget = new ResourceAttributeBudget(cap);
    for (const size of sizes) {
      budget.admit(size);
      assert(budget.admittedBytes <= cap);
    }
  }));
});

Deno.test("ResourceAttributeBudget: admitted resources are a prefix of the run", () => {
  fc.assert(fc.property(arbCap, arbSizes, (cap, sizes) => {
    const budget = new ResourceAttributeBudget(cap);
    const decisions = sizes.map((size) => budget.admit(size));
    const firstRefused = decisions.indexOf(false);
    if (firstRefused === -1) return;
    assert(decisions.slice(firstRefused).every((admitted) => !admitted));
  }));
});

Deno.test("ResourceAttributeBudget: a run that fits admits everything", () => {
  fc.assert(fc.property(arbSizes, (sizes) => {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const budget = new ResourceAttributeBudget(total);
    assert(sizes.every((size) => budget.admit(size)));
    assertEquals(budget.admittedBytes, total);
  }));
});
