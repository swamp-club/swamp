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
import { z } from "zod";
import { isZodSchemaLike } from "./zod_compat.ts";

Deno.test("isZodSchemaLike: accepts schemas from swamp's zod", () => {
  assertEquals(isZodSchemaLike(z.string()), true);
  assertEquals(isZodSchemaLike(z.object({ name: z.string() })), true);
  assertEquals(isZodSchemaLike(z.array(z.number())), true);
  assertEquals(isZodSchemaLike(z.union([z.string(), z.number()])), true);
  assertEquals(isZodSchemaLike(z.unknown()), true);
});

Deno.test("isZodSchemaLike: accepts foreign schemas that match the shape", () => {
  // Simulates a schema coming from a user's bundled zod instance. The
  // `_def` marker, `parse`, and `safeParse` exist but the prototype is
  // different from swamp's zod.
  const foreignSchema = {
    _def: { typeName: "ZodObject" },
    parse: (v: unknown) => v,
    safeParse: (v: unknown) => ({ success: true, data: v }),
  };
  assertEquals(isZodSchemaLike(foreignSchema), true);
});

Deno.test("isZodSchemaLike: rejects null, undefined, primitives", () => {
  assertEquals(isZodSchemaLike(null), false);
  assertEquals(isZodSchemaLike(undefined), false);
  assertEquals(isZodSchemaLike(42), false);
  assertEquals(isZodSchemaLike("string"), false);
  assertEquals(isZodSchemaLike(true), false);
});

Deno.test("isZodSchemaLike: rejects plain objects without zod shape", () => {
  assertEquals(isZodSchemaLike({}), false);
  assertEquals(isZodSchemaLike({ type: "string" }), false);
  assertEquals(isZodSchemaLike({ parse: () => {} }), false); // missing _def
  assertEquals(isZodSchemaLike({ _def: {} }), false); // missing parse/safeParse
});

Deno.test("isZodSchemaLike: rejects when parse/safeParse are not functions", () => {
  assertEquals(
    isZodSchemaLike({ _def: {}, parse: "not a function", safeParse: () => {} }),
    false,
  );
  assertEquals(
    isZodSchemaLike({ _def: {}, parse: () => {}, safeParse: 42 }),
    false,
  );
});

Deno.test("isZodSchemaLike: rejects arrays", () => {
  assertEquals(isZodSchemaLike([]), false);
  assertEquals(isZodSchemaLike([1, 2, 3]), false);
});

Deno.test("isZodSchemaLike: rejects zod errors", () => {
  // ZodError has _def-ish internals but no parse/safeParse — it's the
  // error class, not a schema. The duck-type check correctly rejects it.
  const err = new z.ZodError([]);
  assertEquals(isZodSchemaLike(err), false);
});
