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
  analyzeExpression,
  MODEL_SCOPED_DATA_ACCESSORS,
} from "./expression_references.ts";

const modelName = fc.stringMatching(/^[a-z][a-z0-9]{0,6}(-[a-z0-9]{1,4})?$/);
const accessor = fc.constantFrom(...MODEL_SCOPED_DATA_ACCESSORS);

/** Expressions that compute a string from something other than a literal. */
const computed = fc.oneof(
  fc.constantFrom(
    "inputs.target",
    "self.globalArguments.target",
    'env.TARGET + ""',
  ),
  modelName.map((n) => `"${n}" + inputs.suffix`),
  modelName.map((n) => `inputs.flag ? "${n}" : "other"`),
);

Deno.test("analyzeExpression: a literal model argument is a data target, never data-wide", () => {
  fc.assert(
    fc.property(modelName, accessor, (name, fn) => {
      const r = analyzeExpression(`data.${fn}("${name}", "spec")`);
      assertEquals([...r.dataTargets], [name]);
      assertEquals(r.dataWide, false);
    }),
  );
});

Deno.test("analyzeExpression: any computed model argument is data-wide", () => {
  fc.assert(
    fc.property(computed, accessor, (arg, fn) => {
      assertEquals(
        analyzeExpression(`data.${fn}(${arg}, "spec")`).dataWide,
        true,
      );
    }),
  );
});

Deno.test("analyzeExpression: whitespace does not change the analysis", () => {
  const space = fc.stringMatching(/^[ \t\n]{0,3}$/);
  fc.assert(
    fc.property(modelName, accessor, space, space, (name, fn, a, b) => {
      const plain = analyzeExpression(`data.${fn}("${name}", "spec")`);
      const spaced = analyzeExpression(
        `${a}data${b}.${fn}(${a}"${name}"${b},"spec"${a})${b}`,
      );
      assertEquals([...spaced.dataTargets], [...plain.dataTargets]);
      assertEquals(spaced.dataWide, plain.dataWide);
    }),
  );
});

Deno.test("analyzeExpression: hyphenated dot access and bracket access agree", () => {
  fc.assert(
    fc.property(modelName, (name) => {
      const dot = analyzeExpression(`model.${name}.resource.spec.x`);
      const bracket = analyzeExpression(`model["${name}"].resource.spec.x`);
      assertEquals([...dot.dataTargets], [name]);
      assertEquals([...bracket.dataTargets], [name]);
    }),
  );
});
