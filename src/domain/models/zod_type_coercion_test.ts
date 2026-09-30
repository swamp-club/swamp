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
import {
  coerceMethodArgs,
  getObjectShape,
  isRecordSchema,
  parseGlobalArgumentsLeniently,
} from "./zod_type_coercion.ts";

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

Deno.test("coerces JSON array string to array", () => {
  const schema = z.object({ keywords: z.array(z.string()) });
  const result = coerceMethodArgs({ keywords: '["a","b"]' }, schema);
  assertEquals(result, { keywords: ["a", "b"] });
});

Deno.test("coerces JSON object string to object", () => {
  const schema = z.object({ config: z.object({ port: z.number() }) });
  const result = coerceMethodArgs({ config: '{"port":8080}' }, schema);
  assertEquals(result, { config: { port: 8080 } });
});

Deno.test("invalid JSON for array stays as string", () => {
  const schema = z.object({ keywords: z.array(z.string()) });
  const result = coerceMethodArgs({ keywords: "not-json" }, schema);
  assertEquals(result, { keywords: "not-json" });
});

Deno.test("invalid JSON for object stays as string", () => {
  const schema = z.object({ config: z.object({ port: z.number() }) });
  const result = coerceMethodArgs({ config: "{bad}" }, schema);
  assertEquals(result, { config: "{bad}" });
});

Deno.test("JSON null does not coerce to object", () => {
  const schema = z.object({ config: z.object({ port: z.number() }) });
  const result = coerceMethodArgs({ config: "null" }, schema);
  assertEquals(result, { config: "null" });
});

Deno.test("JSON number does not coerce to array", () => {
  const schema = z.object({ items: z.array(z.string()) });
  const result = coerceMethodArgs({ items: "42" }, schema);
  assertEquals(result, { items: "42" });
});

Deno.test("handles optional array wrapper", () => {
  const schema = z.object({ tags: z.array(z.string()).optional() });
  const result = coerceMethodArgs({ tags: '["a","b"]' }, schema);
  assertEquals(result, { tags: ["a", "b"] });
});

Deno.test("handles optional object wrapper", () => {
  const schema = z.object({ meta: z.object({ k: z.string() }).optional() });
  const result = coerceMethodArgs({ meta: '{"k":"v"}' }, schema);
  assertEquals(result, { meta: { k: "v" } });
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

// ---------- isRecordSchema ----------

Deno.test("isRecordSchema: returns true for plain z.record()", () => {
  const schema = z.record(z.string(), z.string());
  assertEquals(isRecordSchema(schema), true);
});

Deno.test("isRecordSchema: returns true for z.record() wrapped in .optional()", () => {
  const schema = z.record(z.string(), z.string()).optional();
  assertEquals(isRecordSchema(schema), true);
});

Deno.test("isRecordSchema: returns true for z.record() wrapped in .nullable()", () => {
  const schema = z.record(z.string(), z.string()).nullable();
  assertEquals(isRecordSchema(schema), true);
});

Deno.test("isRecordSchema: returns true for z.record() wrapped in .default()", () => {
  const schema = z.record(z.string(), z.string()).default({});
  assertEquals(isRecordSchema(schema), true);
});

Deno.test("isRecordSchema: returns true for z.record() wrapped in .refine()", () => {
  const schema = z.record(z.string(), z.string()).refine(
    (v) => Object.keys(v).length > 0,
  );
  assertEquals(isRecordSchema(schema), true);
});

Deno.test("isRecordSchema: returns false for z.object()", () => {
  const schema = z.object({ name: z.string() });
  assertEquals(isRecordSchema(schema), false);
});

Deno.test("isRecordSchema: returns false for z.string()", () => {
  assertEquals(isRecordSchema(z.string()), false);
});

Deno.test("isRecordSchema: returns false for z.array()", () => {
  assertEquals(isRecordSchema(z.array(z.string())), false);
});

Deno.test("parseGlobalArgumentsLeniently: applies top-level and nested defaults without requiring missing fields", () => {
  const schema = z.object({
    top: z.number().default(6),
    name: z.string(),
    nested: z.object({
      list: z.array(z.string()).default([]),
      n: z.number().default(6),
    }),
  });
  const result = parseGlobalArgumentsLeniently(schema, { nested: {} });
  assertEquals(result, {
    success: true,
    data: { top: 6, nested: { list: [], n: 6 } },
  });
});

Deno.test("parseGlobalArgumentsLeniently: reports a wrongly typed field", () => {
  const schema = z.object({ top: z.number().default(6) });
  const result = parseGlobalArgumentsLeniently(schema, { top: "many" });
  assertEquals(result.success, false);
  if (!result.success) assertEquals(result.issues[0].path, ["top"]);
});

Deno.test("parseGlobalArgumentsLeniently: skipped keys are neither checked nor defaulted", () => {
  const schema = z.object({
    top: z.number().default(6),
    tok: z.string().default("fallback"),
  });
  const result = parseGlobalArgumentsLeniently(
    schema,
    { tok: "${{ data.latest('x', 'y').attributes.token }}" },
    new Set(["tok"]),
  );
  assertEquals(result, { success: true, data: { top: 6 } });
});

Deno.test("parseGlobalArgumentsLeniently: parses a refined object field by field instead of throwing", () => {
  const schema = z.object({
    top: z.number().default(6),
    name: z.string(),
    nested: z.object({ list: z.array(z.string()).default([]) }),
  }).refine((v) => v.top > 0);
  const result = parseGlobalArgumentsLeniently(schema, { nested: {} });
  assertEquals(result, {
    success: true,
    data: { top: 6, nested: { list: [] } },
  });
});

Deno.test("parseGlobalArgumentsLeniently: reports refined-object field issues under the field's path", () => {
  const schema = z.object({
    nested: z.object({ n: z.number() }),
  }).refine(() => true);
  const result = parseGlobalArgumentsLeniently(schema, {
    nested: { n: "x" },
  });
  assertEquals(result.success, false);
  if (!result.success) assertEquals(result.issues[0].path, ["nested", "n"]);
});

Deno.test("parseGlobalArgumentsLeniently: skips a refined object's skipped keys", () => {
  const schema = z.object({
    top: z.number().default(6),
    tok: z.string().default("fallback"),
  }).refine(() => true);
  const result = parseGlobalArgumentsLeniently(
    schema,
    { tok: "${{ inputs.tok }}" },
    new Set(["tok"]),
  );
  assertEquals(result, { success: true, data: { top: 6 } });
});

Deno.test("parseGlobalArgumentsLeniently: parses a schema without partial() in full", () => {
  const schema = z.object({ name: z.string() }).transform((v) => ({
    name: v.name.toUpperCase(),
  }));
  assertEquals(parseGlobalArgumentsLeniently(schema, { name: "a" }), {
    success: true,
    data: { name: "A" },
  });
  assertEquals(parseGlobalArgumentsLeniently(schema, {}).success, false);
});

Deno.test("parseGlobalArgumentsLeniently: passes a subset of a schema without partial() through unchecked", () => {
  const schema = z.object({ name: z.string(), tok: z.string() }).transform((
    v,
  ) => v);
  const result = parseGlobalArgumentsLeniently(
    schema,
    { name: "a", tok: "${{ inputs.tok }}" },
    new Set(["tok"]),
  );
  assertEquals(result, { success: true, data: { name: "a" } });
});

Deno.test("parseGlobalArgumentsLeniently: treats an own __proto__ key as data, not a prototype", () => {
  const schema = z.object({ top: z.number().default(6) });
  const args = JSON.parse('{"__proto__": {"top": "polluted"}}');
  const result = parseGlobalArgumentsLeniently(schema, args);
  assertEquals(result, { success: true, data: { top: 6 } });
});

const credentials = z.object({
  apiKey: z.string().optional(),
  token: z.string().optional(),
}).superRefine((v, ctx) => {
  if (!v.apiKey && !v.token) {
    ctx.addIssue({ code: "custom", message: "apiKey or token required" });
  }
});

Deno.test("parseGlobalArgumentsLeniently: enforces an object-level refinement when the object is complete (swamp-club#2783)", () => {
  const result = parseGlobalArgumentsLeniently(credentials, {});
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(
      result.issues.map((i) => [i.path, i.message]),
      [[[], "apiKey or token required"]],
    );
  }
});

Deno.test("parseGlobalArgumentsLeniently: passes a satisfied object-level refinement (swamp-club#2783)", () => {
  assertEquals(parseGlobalArgumentsLeniently(credentials, { token: "t" }), {
    success: true,
    data: { token: "t" },
  });
});

Deno.test("parseGlobalArgumentsLeniently: reports a refinement issue at an absent field's path (swamp-club#2783)", () => {
  const schema = z.object({ apiKey: z.string().optional() }).superRefine(
    (v, ctx) => {
      if (!v.apiKey) {
        ctx.addIssue({
          code: "custom",
          message: "apiKey required",
          path: ["apiKey"],
        });
      }
    },
  );
  const result = parseGlobalArgumentsLeniently(schema, {});
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(
      result.issues.map((i) => [i.path, i.message]),
      [[["apiKey"], "apiKey required"]],
    );
  }
});

Deno.test("parseGlobalArgumentsLeniently: does not require missing string, enum, literal or union fields of a refined object (swamp-club#2783)", () => {
  const schema = z.object({
    name: z.string(),
    kind: z.enum(["a", "b"]),
    mode: z.literal("x"),
    size: z.union([z.string(), z.number()]),
    nested: z.object({ n: z.number() }),
    region: z.string().optional(),
  }).refine(() => false, "never satisfied");
  assertEquals(parseGlobalArgumentsLeniently(schema, { region: "eu" }), {
    success: true,
    data: { region: "eu" },
  });
});

Deno.test("parseGlobalArgumentsLeniently: does not run object-level refinements when a key is skipped (swamp-club#2783)", () => {
  const result = parseGlobalArgumentsLeniently(
    credentials,
    { token: "${{ inputs.token }}" },
    new Set(["token"]),
  );
  assertEquals(result, { success: true, data: {} });
});

Deno.test("parseGlobalArgumentsLeniently: object-level refinements see field defaults (swamp-club#2783)", () => {
  const schema = z.object({
    min: z.number().default(1),
    max: z.number(),
  }).refine((v) => v.min <= v.max, "min must not exceed max");
  const result = parseGlobalArgumentsLeniently(schema, { max: 0 });
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.issues.map((i) => i.message), [
      "min must not exceed max",
    ]);
  }
  assertEquals(parseGlobalArgumentsLeniently(schema, { max: 2 }), {
    success: true,
    data: { min: 1, max: 2 },
  });
});

Deno.test("parseGlobalArgumentsLeniently: reports a field issue once, without running refinements (swamp-club#2783)", () => {
  const schema = z.object({ top: z.number() }).refine(
    () => false,
    "never satisfied",
  );
  const result = parseGlobalArgumentsLeniently(schema, { top: "many" });
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.issues.map((i) => i.path), [["top"]]);
  }
});

Deno.test("parseGlobalArgumentsLeniently: runs a refinement declared with when on an incomplete object (swamp-club#2783)", () => {
  const schema = z.object({
    name: z.string(),
    token: z.string().optional(),
  }).refine((v) => !!v.token, {
    message: "token required",
    when: () => true,
  });
  const result = parseGlobalArgumentsLeniently(schema, {});
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.issues.map((i) => i.message), ["token required"]);
  }
});

Deno.test("parseGlobalArgumentsLeniently: refines the raw input, so transformed fields pass (swamp-club#2783)", () => {
  const schema = z.object({
    port: z.string().transform(Number),
    tags: z.string().transform((v) => v.split(",")),
  }).refine((v) => v.port > 0, "port must be positive");
  assertEquals(
    parseGlobalArgumentsLeniently(schema, { port: "8080", tags: "a,b" }),
    { success: true, data: { port: 8080, tags: ["a", "b"] } },
  );
  const result = parseGlobalArgumentsLeniently(schema, {
    port: "0",
    tags: "a",
  });
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.issues.map((i) => i.message), [
      "port must be positive",
    ]);
  }
});

Deno.test("parseGlobalArgumentsLeniently: leaves an async object-level refinement unchecked (swamp-club#2783)", () => {
  const schema = z.object({ n: z.number() }).refine(
    () => Promise.resolve(false),
    "never satisfied",
  );
  assertEquals(parseGlobalArgumentsLeniently(schema, { n: 1 }), {
    success: true,
    data: { n: 1 },
  });
});

Deno.test("parseGlobalArgumentsLeniently: does not require a missing field whose own refinement rejects undefined (swamp-club#2783)", () => {
  const schema = z.object({
    region: z.string().optional(),
    cert: z.custom<string>((v) => typeof v === "string"),
    anything: z.any().refine((v) => v !== undefined, "required"),
  }).refine(() => true);
  assertEquals(parseGlobalArgumentsLeniently(schema, { region: "eu" }), {
    success: true,
    data: { region: "eu" },
  });
});

Deno.test("parseGlobalArgumentsLeniently: keeps a non-custom refinement issue at an absent optional field (swamp-club#2783)", () => {
  const schema = z.object({ apiKey: z.string().optional() }).superRefine(
    (v, ctx) => {
      if (!v.apiKey) {
        ctx.addIssue({
          code: "invalid_type",
          expected: "string",
          path: ["apiKey"],
          message: "apiKey required",
        });
      }
    },
  );
  const result = parseGlobalArgumentsLeniently(schema, {});
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.issues.map((i) => i.message), ["apiKey required"]);
  }
});
