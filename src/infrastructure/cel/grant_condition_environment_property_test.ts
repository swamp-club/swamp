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
import { Environment } from "cel-js";
import fc from "fast-check";
import { CONDITION_FIELDS } from "../../domain/access/condition_fields.ts";
import { registerArithmeticOverloads } from "./cel_evaluator.ts";
import { validateGrantCondition } from "./grant_condition_environment.ts";

const operand = fc.constantFrom(
  "name",
  "tags.env",
  'tags["team"]',
  "principal.sub",
  "principal.email",
  "principal.groups",
  '"prod"',
  "1",
  "true",
);
const comparison = fc.tuple(
  operand,
  fc.constantFrom("==", "!=", ">", "in"),
  operand,
).map(([left, op, right]) => `${left} ${op} ${right}`);
const clause = fc.oneof(
  comparison,
  operand,
  operand.map((value) => `!${value}`),
  operand.map((value) => `${value} ? true : false`),
);
const condition = fc.array(clause, { minLength: 1, maxLength: 3 }).chain((
  clauses,
) => fc.constantFrom(" && ", " || ").map((joiner) => clauses.join(joiner)));

const plain = new Environment({ unlistedVariablesAreDyn: false });
registerArithmeticOverloads(plain);
for (const field of CONDITION_FIELDS.workflow) {
  plain.registerVariable(field.name, field.type);
}
plain.registerVariable("principal", "map");

Deno.test("property: a condition naming neither run nor client is never newly invalid", () => {
  fc.assert(
    fc.property(condition, (text) => {
      const verdict = validateGrantCondition(text, "workflow", {
        actions: ["read"],
        effect: "deny",
      }).valid;
      assertEquals(verdict, plain.check(text).valid, text);
    }),
  );
});
