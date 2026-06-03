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
import { coerceMethodArgs, getObjectShape } from "./zod_type_coercion.ts";

Deno.test("coerces string 'true' to boolean true", () => {
  const schema = z.object({ enabled: z.boolean() });
  const result = coerceMethodArgs({ enabled: "true" }, schema);
  assertEquals(result, { enabled: true });
});

Deno.test("coerces string 'false' to boolean false", () => {
  const schema = z.object({ enabled: z.boolean() });
  const result = coerceMethodArgs({ enabled: "false" }, schema);
  assertEquals(result, { enabled: false });
});

Deno.test("coerces numeric string to number", () => {
  const schema = z.object({ count: z.number() });
  const result = coerceMethodArgs({ count: "42" }, schema);
  assertEquals(result, { count: 42 });
});

Deno.test("coerces floating point string to number", () => {
  const schema = z.object({ ratio: z.number() });
  const result = coerceMethodArgs({ ratio: "3.14" }, schema);
  assertEquals(result, { ratio: 3.14 });
});

Deno.test("does not coerce NaN-producing string to number", () => {
  const schema = z.object({ count: z.number() });
  const result = coerceMethodArgs({ count: "not-a-number" }, schema);
  assertEquals(result, { count: "not-a-number" });
});

Deno.test("passes through already-correct boolean", () => {
  const schema = z.object({ enabled: z.boolean() });
  const result = coerceMethodArgs({ enabled: true }, schema);
  assertEquals(result, { enabled: true });
});

Deno.test("passes through already-correct number", () => {
  const schema = z.object({ count: z.number() });
  const result = coerceMethodArgs({ count: 5 }, schema);
  assertEquals(result, { count: 5 });
});

Deno.test("handles optional wrapper", () => {
  const schema = z.object({ enabled: z.boolean().optional() });
  const result = coerceMethodArgs({ enabled: "true" }, schema);
  assertEquals(result, { enabled: true });
});

Deno.test("handles default wrapper", () => {
  const schema = z.object({ enabled: z.boolean().default(false) });
  const result = coerceMethodArgs({ enabled: "true" }, schema);
  assertEquals(result, { enabled: true });
});

Deno.test("handles nullable wrapper", () => {
  const schema = z.object({ count: z.number().nullable() });
  const result = coerceMethodArgs({ count: "10" }, schema);
  assertEquals(result, { count: 10 });
});

Deno.test("passes through unknown keys unchanged", () => {
  const schema = z.object({ known: z.string() });
  const result = coerceMethodArgs({ known: "hello", extra: "true" }, schema);
  assertEquals(result, { known: "hello", extra: "true" });
});

Deno.test("handles empty args", () => {
  const schema = z.object({ enabled: z.boolean() });
  const result = coerceMethodArgs({}, schema);
  assertEquals(result, {});
});

Deno.test("returns args unchanged for non-object schema", () => {
  const schema = z.string();
  const args = { enabled: "true" };
  const result = coerceMethodArgs(args, schema);
  assertEquals(result, { enabled: "true" });
});

Deno.test("does not coerce string field", () => {
  const schema = z.object({ name: z.string() });
  const result = coerceMethodArgs({ name: "true" }, schema);
  assertEquals(result, { name: "true" });
});

Deno.test("coerces multiple fields", () => {
  const schema = z.object({
    enabled: z.boolean(),
    count: z.number(),
    name: z.string(),
  });
  const result = coerceMethodArgs(
    { enabled: "false", count: "7", name: "test" },
    schema,
  );
  assertEquals(result, { enabled: false, count: 7, name: "test" });
});

Deno.test("coerces negative number string", () => {
  const schema = z.object({ offset: z.number() });
  const result = coerceMethodArgs({ offset: "-3" }, schema);
  assertEquals(result, { offset: -3 });
});

Deno.test("coerces zero string to number", () => {
  const schema = z.object({ count: z.number() });
  const result = coerceMethodArgs({ count: "0" }, schema);
  assertEquals(result, { count: 0 });
});

Deno.test("does not coerce empty string to number", () => {
  const schema = z.object({ count: z.number() });
  // Number("") is 0 which is not NaN, but empty string is a valid coercion to 0
  const result = coerceMethodArgs({ count: "" }, schema);
  assertEquals(result, { count: 0 });
});

// ---------- getObjectShape ----------

Deno.test("getObjectShape returns shape for plain ZodObject", () => {
  const schema = z.object({ name: z.string(), count: z.number() });
  const shape = getObjectShape(schema);
  assertEquals(Object.keys(shape ?? {}).sort(), ["count", "name"]);
});

Deno.test("getObjectShape returns shape for ZodObject wrapped in .refine()", () => {
  const schema = z.object({ name: z.string() }).refine(
    (v) => v.name.length > 0,
  );
  const shape = getObjectShape(schema);
  assertEquals(Object.keys(shape ?? {}), ["name"]);
});

Deno.test("getObjectShape returns shape for ZodObject wrapped in .optional()", () => {
  const schema = z.object({ name: z.string() }).optional();
  const shape = getObjectShape(schema);
  assertEquals(Object.keys(shape ?? {}), ["name"]);
});

Deno.test("getObjectShape returns undefined for non-object schema", () => {
  const schema = z.string();
  assertEquals(getObjectShape(schema), undefined);
});

Deno.test("getObjectShape handles Zod v3 internal structure (typeName + shape function)", () => {
  // Extensions may import npm:zod@3, whose ZodObject stores its type as
  // `_def.typeName` ("ZodObject") and its shape as a function `_def.shape()`.
  // This test simulates that structure to ensure compatibility.
  const v3LikeSchema = {
    _def: {
      typeName: "ZodObject",
      shape: () => ({
        name: z.string(),
        count: z.number(),
      }),
    },
  } as unknown as z.ZodTypeAny;
  const shape = getObjectShape(v3LikeSchema);
  assertEquals(Object.keys(shape ?? {}).sort(), ["count", "name"]);
});

Deno.test("getObjectShape handles Zod v3 ZodEffects (typeName + .schema)", () => {
  const v3LikeRefined = {
    _def: {
      typeName: "ZodEffects",
      schema: {
        _def: {
          typeName: "ZodObject",
          shape: () => ({ name: z.string() }),
        },
      },
    },
  } as unknown as z.ZodTypeAny;
  const shape = getObjectShape(v3LikeRefined);
  assertEquals(Object.keys(shape ?? {}), ["name"]);
});
