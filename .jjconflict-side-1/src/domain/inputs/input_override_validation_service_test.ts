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
import { z } from "zod";
import { InputOverrideValidationService } from "./input_override_validation_service.ts";

Deno.test("InputOverrideValidationService validates valid input with correct type", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string(),
    count: z.number(),
    enabled: z.boolean(),
  });

  const result = service.validate(
    { message: "hello", count: 42, enabled: true },
    schema,
  );

  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("InputOverrideValidationService fails on unknown key", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string(),
  });

  const result = service.validate({ unknownKey: "value" }, schema);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].key, "unknownKey");
  assertEquals(result.errors[0].message, 'Unknown input key "unknownKey"');
  assertEquals(result.errors[0].availableKeys, ["message"]);
});

Deno.test("InputOverrideValidationService suggests typo corrections", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string(),
    content: z.string(),
  });

  const result = service.validate({ mesage: "value" }, schema);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].key, "mesage");
  assertEquals(
    result.errors[0].suggestion,
    'Did you mean "message" instead of "mesage"?',
  );
});

Deno.test("InputOverrideValidationService fails on type mismatch - string expected", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string(),
  });

  const result = service.validate({ message: 123 }, schema);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].key, "message");
  assertEquals(
    result.errors[0].message.includes("message"),
    true,
  );
});

Deno.test("InputOverrideValidationService fails on type mismatch - number expected", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    count: z.number(),
  });

  const result = service.validate({ count: "not a number" }, schema);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].key, "count");
});

Deno.test("InputOverrideValidationService fails on type mismatch - boolean expected", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    enabled: z.boolean(),
  });

  const result = service.validate({ enabled: "true" }, schema);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].key, "enabled");
});

Deno.test("InputOverrideValidationService passes empty inputs", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string(),
  });

  const result = service.validate({}, schema);

  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("InputOverrideValidationService handles optional fields", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string(),
    optional: z.string().optional(),
  });

  // Valid with optional field
  const result1 = service.validate(
    { message: "hello", optional: "world" },
    schema,
  );
  assertEquals(result1.valid, true);

  // Valid without optional field
  const result2 = service.validate({ message: "hello" }, schema);
  assertEquals(result2.valid, true);

  // Optional field with wrong type still fails
  const result3 = service.validate(
    { message: "hello", optional: 123 },
    schema,
  );
  assertEquals(result3.valid, false);
  assertEquals(result3.errors[0].key, "optional");
});

Deno.test("InputOverrideValidationService handles arrays", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    items: z.array(z.string()),
  });

  // Valid array
  const result1 = service.validate({ items: ["a", "b", "c"] }, schema);
  assertEquals(result1.valid, true);

  // Invalid: not an array
  const result2 = service.validate({ items: "not an array" }, schema);
  assertEquals(result2.valid, false);
  assertEquals(result2.errors[0].key, "items");

  // Invalid: wrong element type
  const result3 = service.validate({ items: [1, 2, 3] }, schema);
  assertEquals(result3.valid, false);
  assertEquals(result3.errors[0].key, "items");
});

Deno.test("InputOverrideValidationService handles nested objects", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    config: z.object({
      host: z.string(),
      port: z.number(),
    }),
  });

  // Valid nested object
  const result1 = service.validate(
    { config: { host: "localhost", port: 8080 } },
    schema,
  );
  assertEquals(result1.valid, true);

  // Invalid nested object
  const result2 = service.validate(
    { config: { host: 123, port: "not a number" } },
    schema,
  );
  assertEquals(result2.valid, false);
  assertEquals(result2.errors[0].key, "config");
});

Deno.test("InputOverrideValidationService handles multiple errors", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    name: z.string(),
    count: z.number(),
  });

  const result = service.validate(
    { unknownKey: "value", name: 123, count: "not a number" },
    schema,
  );

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 3);

  const keys = result.errors.map((e) => e.key).sort();
  assertEquals(keys, ["count", "name", "unknownKey"]);
});

Deno.test("InputOverrideValidationService handles schema with defaults", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string().default("hello"),
    count: z.number().default(0),
  });

  // Valid override of defaulted field
  const result = service.validate({ message: "override" }, schema);
  assertEquals(result.valid, true);
});

Deno.test("InputOverrideValidationService handles record schemas", () => {
  const service = new InputOverrideValidationService();
  const schema = z.record(z.string(), z.number());

  // Valid: any string key with number value
  const result1 = service.validate({ foo: 1, bar: 2 }, schema);
  assertEquals(result1.valid, true);

  // Invalid: wrong value type
  const result2 = service.validate({ foo: "not a number" }, schema);
  assertEquals(result2.valid, false);
});

Deno.test("InputOverrideValidationService handles union schemas", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    value: z.union([z.string(), z.number()]),
  });

  // Valid: string
  const result1 = service.validate({ value: "hello" }, schema);
  assertEquals(result1.valid, true);

  // Valid: number
  const result2 = service.validate({ value: 42 }, schema);
  assertEquals(result2.valid, true);

  // Invalid: boolean
  const result3 = service.validate({ value: true }, schema);
  assertEquals(result3.valid, false);
});

Deno.test("InputOverrideValidationService handles nullable fields", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    message: z.string().nullable(),
  });

  // Valid: string
  const result1 = service.validate({ message: "hello" }, schema);
  assertEquals(result1.valid, true);

  // Valid: null
  const result2 = service.validate({ message: null }, schema);
  assertEquals(result2.valid, true);

  // Invalid: number
  const result3 = service.validate({ message: 123 }, schema);
  assertEquals(result3.valid, false);
});

Deno.test("InputOverrideValidationService handles enum validation", () => {
  const service = new InputOverrideValidationService();
  const schema = z.object({
    level: z.enum(["low", "medium", "high"]),
  });

  // Valid enum value
  const result1 = service.validate({ level: "medium" }, schema);
  assertEquals(result1.valid, true);

  // Invalid enum value
  const result2 = service.validate({ level: "invalid" }, schema);
  assertEquals(result2.valid, false);
  assertEquals(result2.errors[0].key, "level");
});
