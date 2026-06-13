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
  buildDataOutputSpecs,
  toMethodDescribeData,
  zodToJsonSchema,
} from "./schema_helpers.ts";
import type { ResourceOutputSpec } from "../../domain/models/model.ts";

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

Deno.test("zodToJsonSchema: field with .default() is not required", () => {
  const schema = z.object({
    limit: z.number().default(15),
  });
  const result = zodToJsonSchema(schema) as Record<string, unknown>;
  assertEquals(result.type, "object");
  const required = result.required as string[] | undefined;
  assertEquals(required, undefined);
});

Deno.test("zodToJsonSchema: field without .default() is still required", () => {
  const schema = z.object({
    name: z.string(),
  });
  const result = zodToJsonSchema(schema) as Record<string, unknown>;
  const required = result.required as string[];
  assertEquals(required.includes("name"), true);
});

Deno.test("zodToJsonSchema: mixed defaulted and required fields", () => {
  const schema = z.object({
    name: z.string(),
    limit: z.number().int().min(1).max(100).default(15),
    verbose: z.boolean().default(false),
  });
  const result = zodToJsonSchema(schema) as Record<string, unknown>;
  const required = result.required as string[];
  assertEquals(required, ["name"]);
  const props = result.properties as Record<string, Record<string, unknown>>;
  assertEquals(props.limit.default, 15);
  assertEquals(props.verbose.default, false);
});

Deno.test("zodToJsonSchema: optional field is not required", () => {
  const schema = z.object({
    name: z.string(),
    tag: z.string().optional(),
  });
  const result = zodToJsonSchema(schema) as Record<string, unknown>;
  const required = result.required as string[];
  assertEquals(required.includes("name"), true);
  assertEquals(required.includes("tag"), false);
});

Deno.test("toMethodDescribeData: returns name, description, and arguments only", () => {
  const method = {
    description: "Start the resource",
    arguments: z.object({ name: z.string() }),
    execute: () => Promise.resolve({}),
  };
  const result = toMethodDescribeData("start", method);
  assertEquals(result.name, "start");
  assertEquals(result.description, "Start the resource");
  assertEquals(typeof result.arguments, "object");
  assertEquals(Object.keys(result).sort(), [
    "arguments",
    "description",
    "name",
  ]);
});

Deno.test("buildDataOutputSpecs: builds specs from resources and files", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    state: {
      description: "Current state",
      schema: z.object({ phase: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  };
  const result = buildDataOutputSpecs(resources, undefined);
  assertEquals(result.length, 1);
  assertEquals(result[0].specName, "state");
  assertEquals(result[0].kind, "resource");
  assertEquals(result[0].description, "Current state");
  assertEquals(result[0].lifetime, "infinite");
});

Deno.test("buildDataOutputSpecs: returns empty array when no specs", () => {
  const result = buildDataOutputSpecs(undefined, undefined);
  assertEquals(result.length, 0);
});
