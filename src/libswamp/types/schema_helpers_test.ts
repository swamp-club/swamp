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
import { zodToJsonSchema } from "./schema_helpers.ts";

Deno.test("zodToJsonSchema: handles z.record(z.unknown())", () => {
  const schema = z.record(z.string(), z.unknown());
  const result = zodToJsonSchema(schema);
  const json = result as Record<string, unknown>;
  assertEquals(json.type, "object");
  assertEquals(typeof json.additionalProperties, "object");
});

Deno.test("zodToJsonSchema: handles z.uuid()", () => {
  const schema = z.uuid();
  const result = zodToJsonSchema(schema);
  const json = result as Record<string, unknown>;
  assertEquals(json.type, "string");
});

Deno.test("zodToJsonSchema: handles z.iso.datetime()", () => {
  const schema = z.iso.datetime();
  const result = zodToJsonSchema(schema);
  const json = result as Record<string, unknown>;
  assertEquals(json.type, "string");
});

Deno.test("zodToJsonSchema: handles nested combination with problematic types", () => {
  const schema = z.object({
    data: z.record(z.string(), z.unknown()),
    id: z.uuid().optional(),
  });
  const result = zodToJsonSchema(schema);
  const json = result as Record<string, unknown>;
  assertEquals(json.type, "object");
  const properties = json.properties as Record<string, Record<string, unknown>>;
  assertEquals(properties.data.type, "object");
});

Deno.test("zodToJsonSchema: handles standard z.string()", () => {
  const result = zodToJsonSchema(z.string()) as Record<string, unknown>;
  assertEquals(result.type, "string");
});

Deno.test("zodToJsonSchema: handles standard z.number()", () => {
  const result = zodToJsonSchema(z.number()) as Record<string, unknown>;
  assertEquals(result.type, "number");
});

Deno.test("zodToJsonSchema: handles standard z.object()", () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  const result = zodToJsonSchema(schema) as Record<string, unknown>;
  assertEquals(result.type, "object");
  const properties = result.properties as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(properties.name.type, "string");
  assertEquals(properties.age.type, "number");
});

Deno.test("zodToJsonSchema: handles z.enum()", () => {
  const schema = z.enum(["a", "b", "c"]);
  const result = zodToJsonSchema(schema) as Record<string, unknown>;
  // Zod's toJSONSchema may succeed for enum, but verify it works either way
  assertEquals(Array.isArray(result.enum), true);
});
