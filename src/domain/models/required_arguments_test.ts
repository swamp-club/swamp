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
import { requiredArgumentNames } from "./required_arguments.ts";

async function required(schema: z.ZodTypeAny): Promise<string[]> {
  return (await requiredArgumentNames(schema)).sort();
}

const throwsOnMissing = z.preprocess(
  (v) => (v as string).toLowerCase(),
  z.string(),
);

Deno.test("requiredArgumentNames: a plain field is required", async () => {
  assertEquals(await required(z.object({ name: z.string() })), ["name"]);
});

Deno.test("requiredArgumentNames: optional, defaulted and nested-defaulted fields are not required", async () => {
  const schema = z.object({
    opt: z.string().optional(),
    dflt: z.string().default("x"),
    nested: z.object({ x: z.string().default("y") }).default({ x: "y" }),
  });
  assertEquals(await required(schema), []);
});

Deno.test("requiredArgumentNames: a nullable field without optional is required", async () => {
  assertEquals(await required(z.object({ n: z.string().nullable() })), ["n"]);
});

Deno.test("requiredArgumentNames: a preprocess that turns a missing value into a valid one is not required (swamp-club#3873)", async () => {
  const schema = z.object({
    name: z.string(),
    flag: z.preprocess((v) => v === true || v === "true", z.boolean()),
  });
  assertEquals(await required(schema), ["name"]);
});

Deno.test("requiredArgumentNames: a field that throws on a missing value is required, and its siblings are judged on their own", async () => {
  const schema = z.object({
    name: z.string(),
    lower: throwsOnMissing,
    flag: z.preprocess((v) => v === true, z.boolean()),
    opt: z.string().optional(),
  });
  assertEquals(await required(schema), ["lower", "name"]);
});

Deno.test("requiredArgumentNames: .catch() around a transform is not required (swamp-club#3873)", async () => {
  const schema = z.object({
    name: z.string(),
    length: z.string().transform((s) => s.length).catch(0),
  });
  assertEquals(await required(schema), ["name"]);
});

Deno.test("requiredArgumentNames: a z.custom field with a check is required", async () => {
  const schema = z.object({
    c: z.custom<string>((v) => typeof v === "string"),
    d: z.instanceof(Date),
  });
  assertEquals(await required(schema), ["c", "d"]);
});

Deno.test("requiredArgumentNames: both sides of an intersection report their required fields", async () => {
  const schema = z.object({ a: z.string() }).and(
    z.object({ b: z.number(), o: z.string().optional() }),
  );
  assertEquals(await required(schema), ["a", "b"]);
});

Deno.test("requiredArgumentNames: a transform-then-pipe reports the keys it accepts, not the keys it produces (swamp-club#3681)", async () => {
  const schema = z.object({ raw: z.string() })
    .transform((x) => ({ token: x.raw }))
    .pipe(z.object({ token: z.string() }));
  assertEquals(await required(schema), ["raw"]);
});

Deno.test("requiredArgumentNames: a transform-then-pipe whose input keys are optional reports none of the keys it produces (swamp-club#3681)", async () => {
  const derived = z.object({
    raw: z.string().optional(),
    token: z.string().optional(),
  }).transform((o) => ({ token: o.token ?? o.raw }))
    .pipe(z.object({ token: z.string() }));
  const renamed = z.object({ name: z.string().optional() })
    .transform((o) => ({ id: o.name }))
    .pipe(z.object({ id: z.string() }));
  assertEquals(await required(derived), []);
  assertEquals(await required(renamed), []);
});

Deno.test("requiredArgumentNames: a preprocess around an object reports the object's keys", async () => {
  const schema = z.preprocess(
    (v) => v,
    z.object({ a: z.string(), b: z.string().optional() }),
  );
  assertEquals(await required(schema), ["a"]);
});

Deno.test("requiredArgumentNames: a throwing field is isolated inside a refined object, an intersection and a pipe", async () => {
  const fields = {
    name: z.string(),
    lower: throwsOnMissing,
    flag: z.preprocess((v) => v === true, z.boolean()),
  };
  const refined = z.object(fields).refine(() => true);
  const intersected = z.object({ name: z.string() }).and(
    z.object({ lower: throwsOnMissing, flag: fields.flag }),
  );
  const piped = z.object(fields).transform((o) => o);
  const preprocessed = z.preprocess((v) => v, z.object(fields));
  for (const schema of [refined, intersected, piped, preprocessed]) {
    assertEquals(await required(schema), ["lower", "name"]);
  }
});

Deno.test("requiredArgumentNames: a cross-field refine over optional fields reports nothing", async () => {
  const schema = z.object({
    a: z.string().optional(),
    b: z.string().optional(),
  }).refine((o) => o.a !== undefined || o.b !== undefined, {
    path: ["a"],
    message: "a or b",
  });
  assertEquals(await required(schema), []);
});

Deno.test("requiredArgumentNames: a cross-field superRefine reports nothing, whatever issue code it raises", async () => {
  const schema = z.object({
    a: z.string().optional(),
    b: z.string().optional(),
  }).superRefine((o, ctx) => {
    if (o.a === undefined && o.b === undefined) {
      ctx.addIssue({
        code: "invalid_type",
        expected: "string",
        path: ["a"],
        input: o,
        message: "a or b",
      });
    }
  });
  assertEquals(await required(schema), []);
});

Deno.test("requiredArgumentNames: an async refinement is parsed, not taken for a throw", async () => {
  const schema = z.object({
    name: z.string(),
    opt: z.string().optional().refine(() => Promise.resolve(true)),
  });
  assertEquals(await required(schema), ["name"]);
});

Deno.test("requiredArgumentNames: a union reports nothing, even when a member throws", async () => {
  const plain = z.union([
    z.object({ a: z.string() }),
    z.object({ b: z.string() }),
  ]);
  const throwing = z.union([
    z.object({ lower: throwsOnMissing }),
    z.object({ b: z.string() }),
  ]);
  assertEquals(await required(plain), []);
  assertEquals(await required(throwing), []);
});

Deno.test("requiredArgumentNames: a discriminated union reports nothing, since its issue is over the whole input", async () => {
  const schema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("x"), a: z.string() }),
    z.object({ kind: z.literal("y") }),
  ]);
  assertEquals(await required(schema), []);
});

Deno.test("requiredArgumentNames: a record reports nothing", async () => {
  assertEquals(await required(z.record(z.string(), z.string())), []);
});

Deno.test("requiredArgumentNames: a value that is not a Zod v4 schema reports nothing", async () => {
  const v3Shaped = {
    _def: { typeName: "ZodObject" },
  } as unknown as z.ZodTypeAny;
  assertEquals(await required(v3Shaped), []);
});
