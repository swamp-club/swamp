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
import fc from "fast-check";
import {
  formatSpdxExpression,
  parseSpdxExpression,
  type SpdxExpression,
  type SpdxLicenseNode,
} from "./spdx_expression.ts";

const id = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,11}$/).filter(
  (s) => !["AND", "OR", "WITH"].includes(s.toUpperCase()),
);

const licenseNode: fc.Arbitrary<SpdxLicenseNode> = fc.record({
  kind: fc.constant("license" as const),
  id,
  orLater: fc.boolean(),
});

const tree: fc.Arbitrary<SpdxExpression> = fc.letrec<
  { expr: SpdxExpression }
>((tie) => ({
  expr: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    licenseNode,
    fc.record({
      kind: fc.constant("with" as const),
      license: licenseNode,
      exception: id,
    }),
    fc.record({
      kind: fc.constantFrom("and" as const, "or" as const),
      left: tie("expr"),
      right: tie("expr"),
    }),
  ),
})).expr;

Deno.test("parseSpdxExpression: formatting then parsing returns the same tree", () => {
  fc.assert(
    fc.property(tree, (expr) => {
      const text = formatSpdxExpression(expr);
      fc.pre(text.length <= 512);
      assertEquals(parseSpdxExpression(text), expr);
    }),
  );
});

Deno.test("parseSpdxExpression: arbitrary text either parses or throws SpdxSyntaxError", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (text) => {
      try {
        parseSpdxExpression(text);
      } catch (error) {
        assertEquals((error as Error).name, "SpdxSyntaxError");
      }
    }),
  );
});
