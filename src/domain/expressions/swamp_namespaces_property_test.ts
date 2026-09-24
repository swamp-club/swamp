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

import { assert } from "@std/assert";
import fc from "fast-check";
import {
  isForeignExpression,
  isSwampExpression,
  type SwampScope,
  WIDEST_SWAMP_SCOPE,
} from "./swamp_namespaces.ts";

const SWAMP_ROOTS = [
  "model",
  "self",
  "inputs",
  "workflow",
  "vault",
  "env",
  "data",
  "workers",
  "file",
  "run",
  "steps",
  "webhook",
];
const FOREIGN_ROOTS = ["github", "secrets", "matrix", "host", "value"];
const MEMBERS = ["sha", "version", "region", "name", "outputs"];

/** A member-access chain rooted at a swamp or foreign identifier. */
const arbReference = fc
  .tuple(
    fc.constantFrom(...SWAMP_ROOTS, ...FOREIGN_ROOTS),
    fc.array(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 3 }),
  )
  .map(([root, members]) => [root, ...members].join("."));

/** `inputs` read whole or with a computed key, which names no single input. */
const arbOpaqueInputs = fc.constantFrom(
  "inputs",
  "size(inputs)",
  "inputs[env.STAGE]",
  "inputs['a' + self.name]",
);

/** One to three references joined with operators, plus literals. */
const arbExpression = fc
  .array(
    fc.oneof(
      arbReference,
      arbOpaqueInputs,
      fc.constantFrom("'x'", "1", "true"),
    ),
    {
      minLength: 1,
      maxLength: 3,
    },
  )
  .chain((terms) =>
    fc.constantFrom(" + ", " == ", " && ").map((op) => terms.join(op))
  );

/** Any scope an evaluation could present. */
const arbScope: fc.Arbitrary<SwampScope> = fc
  .tuple(
    fc.subarray(SWAMP_ROOTS),
    fc.subarray(MEMBERS),
  )
  .map(([bound, inputs]) => ({
    isBound: (root: string) => bound.includes(root),
    declaredInputs: new Set(inputs),
  }));

Deno.test("isSwampExpression: whatever a scope claims, the widest scope claims", () => {
  fc.assert(
    fc.property(arbExpression, arbScope, (cel, scope) => {
      if (isSwampExpression(cel, scope)) {
        assert(isSwampExpression(cel, WIDEST_SWAMP_SCOPE), cel);
      }
    }),
  );
});

Deno.test("isForeignExpression: never true for what an evaluation claims", () => {
  fc.assert(
    fc.property(arbExpression, arbScope, (cel, scope) => {
      if (isSwampExpression(cel, scope)) assert(!isForeignExpression(cel), cel);
    }),
  );
});

Deno.test("isForeignExpression: never true for inputs read whole or with a computed key", () => {
  fc.assert(
    fc.property(arbOpaqueInputs, (cel) => {
      assert(!isForeignExpression(cel), cel);
    }),
  );
});

Deno.test("isForeignExpression: never true for text cut short inside a string", () => {
  fc.assert(
    fc.property(
      arbExpression,
      fc.string({ maxLength: 8 }).filter((h) => !/["\\]/.test(h)),
      (cel, head) => {
        // extractExpressions ends an expression at the first }}, so a swamp
        // expression with }} inside a string literal arrives as an unterminated
        // string.
        assert(!isForeignExpression(`${cel} + "${head}`));
      },
    ),
  );
});
