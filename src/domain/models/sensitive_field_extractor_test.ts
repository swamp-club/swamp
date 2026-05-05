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
import {
  extractSensitiveFields,
  extractSensitiveFieldValues,
  getNestedValue,
  setNestedValue,
} from "./sensitive_field_extractor.ts";

Deno.test("extractSensitiveFields: simple sensitive field", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    name: z.string(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "apiKey");
  assertEquals(fields[0].vaultName, undefined);
  assertEquals(fields[0].vaultKey, undefined);
});

Deno.test("extractSensitiveFields: meta then optional ordering", () => {
  const schema = z.object({
    secret: z.string().meta({ sensitive: true }).optional(),
    normal: z.string(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "secret");
});

Deno.test("extractSensitiveFields: optional then meta ordering", () => {
  const schema = z.object({
    secret: z.string().optional().meta({ sensitive: true }),
    normal: z.string(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "secret");
});

Deno.test("extractSensitiveFields: nested objects", () => {
  const schema = z.object({
    credentials: z.object({
      apiKey: z.string().meta({ sensitive: true }),
      token: z.string().meta({ sensitive: true }),
    }),
    name: z.string(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 2);
  assertEquals(fields[0].path, "credentials.apiKey");
  assertEquals(fields[1].path, "credentials.token");
});

Deno.test("extractSensitiveFields: custom vaultName and vaultKey", () => {
  const schema = z.object({
    apiKey: z.string().meta({
      sensitive: true,
      vaultName: "prod-vault",
      vaultKey: "my-api-key",
    }),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "apiKey");
  assertEquals(fields[0].vaultName, "prod-vault");
  assertEquals(fields[0].vaultKey, "my-api-key");
});

Deno.test("extractSensitiveFields: mixed sensitive and non-sensitive fields", () => {
  const schema = z.object({
    name: z.string(),
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
    password: z.string().meta({ sensitive: true }),
    port: z.number(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 2);
  assertEquals(fields[0].path, "apiKey");
  assertEquals(fields[1].path, "password");
});

Deno.test("extractSensitiveFields: non-object schema returns empty", () => {
  const schema = z.string();
  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 0);
});

Deno.test("extractSensitiveFields: no sensitive fields returns empty", () => {
  const schema = z.object({
    name: z.string(),
    port: z.number(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 0);
});

Deno.test("extractSensitiveFields: nullable wrapping", () => {
  const schema = z.object({
    secret: z.string().meta({ sensitive: true }).nullable(),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "secret");
});

Deno.test("extractSensitiveFields: deeply nested", () => {
  const schema = z.object({
    level1: z.object({
      level2: z.object({
        secret: z.string().meta({ sensitive: true }),
      }),
    }),
  });

  const fields = extractSensitiveFields(schema);
  assertEquals(fields.length, 1);
  assertEquals(fields[0].path, "level1.level2.secret");
});

Deno.test("extractSensitiveFieldValues: string field", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    name: z.string(),
  });
  const data = { apiKey: "s3cr3t", name: "test" };
  assertEquals(extractSensitiveFieldValues(schema, data), ["s3cr3t"]);
});

Deno.test("extractSensitiveFieldValues: array field collects each element", () => {
  const schema = z.object({
    command: z.array(z.string()).meta({ sensitive: true }),
    name: z.string(),
  });
  const data = { command: ["sh", "-c", "echo TOKEN_HERE"], name: "test" };
  assertEquals(extractSensitiveFieldValues(schema, data), [
    "sh",
    "-c",
    "echo TOKEN_HERE",
  ]);
});

Deno.test("extractSensitiveFieldValues: undefined field is skipped", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }).optional(),
  });
  const data: Record<string, unknown> = {};
  assertEquals(extractSensitiveFieldValues(schema, data), []);
});

Deno.test("extractSensitiveFieldValues: null field is skipped", () => {
  const schema = z.object({
    apiKey: z.string().nullable().meta({ sensitive: true }),
  });
  const data = { apiKey: null };
  assertEquals(extractSensitiveFieldValues(schema, data), []);
});

Deno.test("extractSensitiveFieldValues: non-sensitive fields ignored", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
  });
  const data = { apiKey: "s3cr3t", region: "us-east-1" };
  assertEquals(extractSensitiveFieldValues(schema, data), ["s3cr3t"]);
});

Deno.test("extractSensitiveFieldValues: nested sensitive field", () => {
  const schema = z.object({
    credentials: z.object({
      token: z.string().meta({ sensitive: true }),
    }),
  });
  const data = { credentials: { token: "tok_abc" } };
  assertEquals(extractSensitiveFieldValues(schema, data), ["tok_abc"]);
});

Deno.test("extractSensitiveFieldValues: multiple sensitive fields", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    secret: z.string().meta({ sensitive: true }),
    name: z.string(),
  });
  const data = { apiKey: "key123", secret: "sec456", name: "test" };
  const values = extractSensitiveFieldValues(schema, data);
  assertEquals(values.sort(), ["key123", "sec456"]);
});

Deno.test("extractSensitiveFieldValues: array with non-string elements skips them", () => {
  const schema = z.object({
    items: z.array(z.unknown()).meta({ sensitive: true }),
  });
  const data = { items: ["str", 42, null, "other"] };
  assertEquals(extractSensitiveFieldValues(schema, data), ["str", "other"]);
});

Deno.test("extractSensitiveFieldValues: empty schema returns empty", () => {
  const schema = z.object({});
  const data = {};
  assertEquals(extractSensitiveFieldValues(schema, data), []);
});

Deno.test("getNestedValue: simple path", () => {
  const obj = { apiKey: "secret-value" };
  assertEquals(getNestedValue(obj, "apiKey"), "secret-value");
});

Deno.test("getNestedValue: nested path", () => {
  const obj = { credentials: { apiKey: "secret-value" } };
  assertEquals(getNestedValue(obj, "credentials.apiKey"), "secret-value");
});

Deno.test("getNestedValue: missing path returns undefined", () => {
  const obj = { name: "test" };
  assertEquals(getNestedValue(obj, "missing"), undefined);
});

Deno.test("setNestedValue: simple path", () => {
  const obj: Record<string, unknown> = { apiKey: "original" };
  setNestedValue(obj, "apiKey", "replaced");
  assertEquals(obj.apiKey, "replaced");
});

Deno.test("setNestedValue: nested path", () => {
  const obj: Record<string, unknown> = {
    credentials: { apiKey: "original" },
  };
  setNestedValue(obj, "credentials.apiKey", "replaced");
  assertEquals(
    (obj.credentials as Record<string, unknown>).apiKey,
    "replaced",
  );
});

Deno.test("setNestedValue: creates intermediate objects", () => {
  const obj: Record<string, unknown> = {};
  setNestedValue(obj, "a.b.c", "value");
  assertEquals(
    ((obj.a as Record<string, unknown>).b as Record<string, unknown>).c,
    "value",
  );
});
