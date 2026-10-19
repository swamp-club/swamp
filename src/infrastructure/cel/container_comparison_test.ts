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

import { assertEquals } from "@std/assert";
import { createExtensionCelEnvironment } from "./cel_evaluator.ts";
import { hasContainerComparison } from "./container_comparison.ts";

const env = createExtensionCelEnvironment();

function scan(expression: string): boolean {
  return hasContainerComparison(env.parse(expression).ast);
}

Deno.test("hasContainerComparison: any in is a container comparison", () => {
  for (
    const expression of [
      "x in ['a']",
      "'k' in m",
      "1 in [1]",
      "x in y",
    ]
  ) {
    assertEquals(scan(expression), true, expression);
  }
});

Deno.test("hasContainerComparison: == and != with a scalar literal or null operand are not", () => {
  for (
    const expression of [
      "x == 'a'",
      "'a' == x",
      "x != 'a'",
      "x == 1",
      "x == -1",
      "-1 == x",
      "x == -(-1)",
      "x == 1u",
      "x == 1.5",
      "x == b'a'",
      "x == true",
      "x == null",
      "null != x",
      "x.y == 'a' && z != null",
    ]
  ) {
    assertEquals(scan(expression), false, expression);
  }
});

Deno.test("hasContainerComparison: == and != with no scalar literal operand are", () => {
  for (
    const expression of [
      "x == y",
      "x != y",
      "a.b == c",
      "x == [1]",
      "[1] == x",
      "x == {'a': 1}",
      "x == -y",
      "x == uint(1)",
      "x == dyn('a')",
    ]
  ) {
    assertEquals(scan(expression), true, expression);
  }
});

Deno.test("hasContainerComparison: finds a comparison under every node shape", () => {
  const nested: Array<[string, boolean]> = [
    // A unary operator holds one node, not a list.
    ["!(x in ['', 'changeme'])", true],
    ["!(x == y)", true],
    ["-(x == y ? 1 : 2) > 0", true],
    // Map literal values and keys are pairs.
    ["{'k': x in y}", true],
    ["{x == y: 1}", true],
    // Ternary branches and conditions.
    ["c ? x in y : 1", true],
    ["(x == y) ? 1 : 2", true],
    // Calls and receiver calls nest their arguments.
    ["size([x == y])", true],
    ["f(1, [2, x in y])", true],
    ["cel.bind(v, s, v == [1])", true],
    // Macro bodies and ranges.
    ["[1].exists(x, x in y)", true],
    ["[1].map(x, x == [2])", true],
    ["[x in y].all(z, z)", true],
    ["has(a.b) && a.?b.orValue(1) == 1", false],
    ["[1, 2].exists(x, x == 2)", false],
    ["c ? 1 : 2", false],
  ];
  for (const [expression, expected] of nested) {
    assertEquals(scan(expression), expected, expression);
  }
});
