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

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  assertNoDataGlobalArguments,
  dataArgumentPaths,
} from "./data_field_extractor.ts";
import { ModelType } from "./model_type.ts";

Deno.test("dataArgumentPaths: reports a marked top-level argument and leaves others out", () => {
  const schema = z.object({
    name: z.string(),
    payload: z.string().meta({ data: true }),
  });
  assertEquals(
    dataArgumentPaths(schema, {
      name: "x",
      payload: "${{ vault.get('v','k') }}",
    }),
    ["payload"],
  );
});

Deno.test("dataArgumentPaths: reports nested, optional, array and record fields as concrete paths", () => {
  const schema = z.object({
    body: z.object({ text: z.string().meta({ data: true }), n: z.number() }),
    notes: z.array(z.string().meta({ data: true })).optional(),
    byName: z.record(z.string(), z.string().meta({ data: true })),
    whole: z.object({ a: z.string() }).meta({ data: true }),
    "dotted.key": z.string().meta({ data: true }),
  });
  const paths = dataArgumentPaths(schema, {
    body: { text: "t", n: 1 },
    notes: ["a", "b"],
    byName: { k: "v" },
    whole: { a: "x" },
    "dotted.key": "y",
  });
  assertEquals(
    paths.sort(),
    [
      "byName.k",
      "body.text",
      "notes[0]",
      "notes[1]",
      "whole",
      '["dotted.key"]',
    ].sort(),
  );
});

Deno.test("dataArgumentPaths: a marker on the arguments object makes every argument data", () => {
  const schema = z.object({ a: z.string() }).meta({ data: true });
  assertEquals(dataArgumentPaths(schema, { a: "x" }), [""]);
});

Deno.test("dataArgumentPaths: reports nothing for absent values or data: false", () => {
  const schema = z.object({
    payload: z.string().meta({ data: true }).optional(),
    other: z.string().meta({ data: false }),
  });
  assertEquals(dataArgumentPaths(schema, { other: "x" }), []);
});

Deno.test("assertNoDataGlobalArguments: refuses a data marker in global arguments", () => {
  const type = ModelType.create("@test/data-globals");
  assertThrows(
    () =>
      assertNoDataGlobalArguments({
        type,
        globalArguments: z.object({ a: z.string().meta({ data: true }) }),
      }),
    Error,
    "field 'a' is marked data: true",
  );
  assertThrows(
    () =>
      assertNoDataGlobalArguments({
        type,
        globalArguments: z.object({ a: z.string() }).meta({ data: true }),
      }),
    Error,
    "the schema is marked data: true",
  );
  assertNoDataGlobalArguments({
    type,
    globalArguments: z.object({ a: z.string() }),
  });
});
