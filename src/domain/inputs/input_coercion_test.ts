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

import { assertEquals } from "@std/assert";
import { coerceInputTypes } from "./input_coercion.ts";
import type { InputsSchema } from "../definitions/definition.ts";

Deno.test("coerceInputTypes: coerces string to number", () => {
  const schema: InputsSchema = {
    properties: {
      replicas: { type: "number" },
    },
  };
  const result = coerceInputTypes({ replicas: "3.5" }, schema);
  assertEquals(result, { replicas: 3.5 });
});

Deno.test("coerceInputTypes: coerces string to integer (truncates)", () => {
  const schema: InputsSchema = {
    properties: {
      count: { type: "integer" },
    },
  };
  const result = coerceInputTypes({ count: "7" }, schema);
  assertEquals(result, { count: 7 });
});

Deno.test("coerceInputTypes: coerces string to boolean", () => {
  const schema: InputsSchema = {
    properties: {
      enabled: { type: "boolean" },
      verbose: { type: "boolean" },
    },
  };
  const result = coerceInputTypes(
    { enabled: "true", verbose: "false" },
    schema,
  );
  assertEquals(result, { enabled: true, verbose: false });
});

Deno.test("coerceInputTypes: non-boolean string stays as string", () => {
  const schema: InputsSchema = {
    properties: {
      flag: { type: "boolean" },
    },
  };
  const result = coerceInputTypes({ flag: "yes" }, schema);
  assertEquals(result, { flag: "yes" });
});

Deno.test("coerceInputTypes: NaN stays as string", () => {
  const schema: InputsSchema = {
    properties: {
      count: { type: "number" },
    },
  };
  const result = coerceInputTypes({ count: "not-a-number" }, schema);
  assertEquals(result, { count: "not-a-number" });
});

Deno.test("coerceInputTypes: no schema returns inputs unchanged", () => {
  const result = coerceInputTypes({ replicas: "3" });
  assertEquals(result, { replicas: "3" });
});

Deno.test("coerceInputTypes: non-string values are untouched", () => {
  const schema: InputsSchema = {
    properties: {
      count: { type: "number" },
    },
  };
  const result = coerceInputTypes({ count: 42 }, schema);
  assertEquals(result, { count: 42 });
});

Deno.test("coerceInputTypes: flat schema without properties wrapper", () => {
  const schema: InputsSchema = {
    memory: { type: "number" },
    enabled: { type: "boolean" },
    name: { type: "string" },
  };
  const result = coerceInputTypes(
    { memory: "2048", enabled: "true", name: "test" },
    schema,
  );
  assertEquals(result, { memory: 2048, enabled: true, name: "test" });
});

Deno.test("coerceInputTypes: keys not in schema stay as strings", () => {
  const schema: InputsSchema = {
    properties: {
      known: { type: "number" },
    },
  };
  const result = coerceInputTypes({ known: "5", unknown: "hello" }, schema);
  assertEquals(result, { known: 5, unknown: "hello" });
});
