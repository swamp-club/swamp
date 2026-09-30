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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { RunSensitiveValues } from "../secrets/mod.ts";
import {
  attachSensitiveValues,
  sensitiveValuesOf,
} from "./sensitive_context.ts";

Deno.test("sensitiveValuesOf: returns the record a context carries, or undefined", () => {
  const values = new RunSensitiveValues();
  const context = attachSensitiveValues({ env: {} }, values);
  assertStrictEquals(sensitiveValuesOf(context), values);
  assertEquals(sensitiveValuesOf({ env: {} }), undefined);
  assertEquals(sensitiveValuesOf(undefined), undefined);
});

Deno.test("attachSensitiveValues: derived contexts share the record and CEL cannot see it", () => {
  const values = new RunSensitiveValues();
  const context = attachSensitiveValues({ env: {}, inputs: { a: 1 } }, values);
  const derived = { ...context, self: { name: "x" } };
  assertStrictEquals(sensitiveValuesOf(derived), values);
  assertEquals(Object.keys(context), ["env", "inputs"]);
  assertEquals(JSON.parse(JSON.stringify(context)), {
    env: {},
    inputs: { a: 1 },
  });
});
