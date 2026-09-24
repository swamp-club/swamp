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
  extractFieldsWithMetadata,
  type FieldMetadata,
  findFieldMetadata,
} from "./zod_field_metadata.ts";

const isMarked = (meta: FieldMetadata) => meta.marked === true;

Deno.test("findFieldMetadata: returns metadata set directly on the field", () => {
  const meta = findFieldMetadata(
    z.string().meta({ marked: true, note: "x" }),
    isMarked,
  );
  assertEquals(meta, { marked: true, note: "x" });
});

Deno.test("findFieldMetadata: finds metadata under optional, nullable and default wrappers", () => {
  for (
    const schema of [
      z.string().meta({ marked: true }).optional(),
      z.string().meta({ marked: true }).nullable(),
      z.string().meta({ marked: true }).default("a"),
      z.string().meta({ marked: true }).optional().nullable(),
    ]
  ) {
    assertEquals(findFieldMetadata(schema, isMarked)?.marked, true);
  }
});

Deno.test("findFieldMetadata: finds metadata set on the wrapper", () => {
  const meta = findFieldMetadata(
    z.string().optional().meta({ marked: true }),
    isMarked,
  );
  assertEquals(meta?.marked, true);
});

Deno.test("findFieldMetadata: keeps metadata across describe and min in either order", () => {
  for (
    const schema of [
      z.string().meta({ marked: true }).describe("body"),
      z.string().describe("body").meta({ marked: true }),
      z.string().meta({ marked: true }).min(1),
      z.string().min(1).meta({ marked: true }),
    ]
  ) {
    assertEquals(findFieldMetadata(schema, isMarked)?.marked, true);
  }
});

Deno.test("findFieldMetadata: returns undefined when no metadata matches", () => {
  assertEquals(findFieldMetadata(z.string(), isMarked), undefined);
  assertEquals(
    findFieldMetadata(z.string().meta({ other: true }), isMarked),
    undefined,
  );
});

Deno.test("findFieldMetadata: does not see metadata placed before a transform", () => {
  const schema = z.string().meta({ marked: true }).transform((s) => s.trim());
  assertEquals(findFieldMetadata(schema, isMarked), undefined);
});

Deno.test("extractFieldsWithMetadata: returns matching top-level fields with their metadata", () => {
  const schema = z.object({
    a: z.string().meta({ marked: true }),
    b: z.string(),
    c: z.number().meta({ marked: true, extra: 1 }).optional(),
  });
  assertEquals(extractFieldsWithMetadata(schema, isMarked), [
    { path: "a", meta: { marked: true } },
    { path: "c", meta: { marked: true, extra: 1 } },
  ]);
});

Deno.test("extractFieldsWithMetadata: walks nested objects with dot paths", () => {
  const schema = z.object({
    outer: z.object({
      inner: z.string().meta({ marked: true }),
      deeper: z.object({ leaf: z.string().meta({ marked: true }) }).optional(),
    }),
  });
  const paths = extractFieldsWithMetadata(schema, isMarked).map((f) => f.path);
  assertEquals(paths, ["outer.inner", "outer.deeper.leaf"]);
});

Deno.test("extractFieldsWithMetadata: reports a marked object field and its marked children", () => {
  const schema = z.object({
    block: z.object({ leaf: z.string().meta({ marked: true }) }).meta({
      marked: true,
    }),
  });
  const paths = extractFieldsWithMetadata(schema, isMarked).map((f) => f.path);
  assertEquals(paths, ["block", "block.leaf"]);
});

Deno.test("extractFieldsWithMetadata: applies the prefix to every path", () => {
  const schema = z.object({ a: z.string().meta({ marked: true }) });
  const paths = extractFieldsWithMetadata(schema, isMarked, "root").map((f) =>
    f.path
  );
  assertEquals(paths, ["root.a"]);
});

Deno.test("extractFieldsWithMetadata: returns nothing for non-object schemas", () => {
  assertEquals(
    extractFieldsWithMetadata(z.string().meta({ marked: true }), isMarked),
    [],
  );
  assertEquals(
    extractFieldsWithMetadata(
      z.record(z.string(), z.string().meta({ marked: true })),
      isMarked,
    ),
    [],
  );
});

Deno.test("extractFieldsWithMetadata: does not visit fields inside arrays", () => {
  const schema = z.object({
    items: z.array(z.object({ leaf: z.string().meta({ marked: true }) })),
  });
  assertEquals(extractFieldsWithMetadata(schema, isMarked), []);
});
