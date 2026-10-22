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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  buildSensitiveArgRemediations,
  extractRefusedSensitiveValues,
  extractSensitiveFields,
  extractSensitiveFieldValues,
  findLiteralSensitiveGlobalArgs,
  findLiteralSensitiveValues,
  getNestedValue,
  holdsRuntimeExpression,
  literalSensitiveGlobalArgsMessage,
  maskLiteralSensitiveValues,
  maskRefusedIssues,
  objectKeysOf,
  redactAllValues,
  redactSensitiveValues,
  schemaThrew,
  schemaThrowMessage,
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

Deno.test("extractSensitiveFieldValues: a vault secret sentinel is skipped, because its load registers the value", () => {
  const sentinel = `__SWAMP_VSEC_${"ab".repeat(16)}_0__`;
  const schema = z.object({
    password: z.string().meta({ sensitive: true }),
    header: z.string().meta({ sensitive: true }),
    keys: z.array(z.string()).meta({ sensitive: true }),
  });
  const data = {
    password: sentinel,
    header: `Bearer ${sentinel}`,
    keys: [sentinel, "literal-s3cret"],
  };
  assertEquals(extractSensitiveFieldValues(schema, data), [
    `Bearer ${sentinel}`,
    "literal-s3cret",
  ]);
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

Deno.test("extractSensitiveFieldValues: record field collects each string value", () => {
  const schema = z.object({
    secrets: z.record(z.string(), z.string()).meta({ sensitive: true }),
  });
  const data = { secrets: { KEY_A: "secret-a", KEY_B: "secret-b" } };
  assertEquals(extractSensitiveFieldValues(schema, data).sort(), [
    "secret-a",
    "secret-b",
  ]);
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

Deno.test("redactSensitiveValues: redacts top-level sensitive literal", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    name: z.string(),
  });

  const redacted = redactSensitiveValues(schema, {
    apiKey: "SUPERSECRET123",
    name: "hello",
  });

  assertEquals(redacted, { apiKey: "***", name: "hello" });
});

Deno.test("redactSensitiveValues: leaves non-sensitive fields untouched", () => {
  const schema = z.object({
    region: z.string(),
  });

  const redacted = redactSensitiveValues(schema, { region: "us-east-1" });

  assertEquals(redacted, { region: "us-east-1" });
});

Deno.test("redactSensitiveValues: redacts nested sensitive field", () => {
  const schema = z.object({
    credentials: z.object({
      apiKey: z.string().meta({ sensitive: true }),
    }),
    name: z.string(),
  });

  const redacted = redactSensitiveValues(schema, {
    credentials: { apiKey: "SECRET" },
    name: "hello",
  });

  assertEquals(redacted, {
    credentials: { apiKey: "***" },
    name: "hello",
  });
});

Deno.test("redactSensitiveValues: skips sensitive field absent from data", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }).optional(),
    name: z.string(),
  });

  const redacted = redactSensitiveValues(schema, { name: "hello" });

  assertEquals(redacted, { name: "hello" });
});

Deno.test("redactSensitiveValues: redacts vault.get() expressions too (blanket)", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  const redacted = redactSensitiveValues(schema, {
    apiKey: '${{ vault.get("creds", "apiKey") }}',
  });

  assertEquals(redacted, { apiKey: "***" });
});

Deno.test("redactSensitiveValues: does not mutate the input", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });
  const input = { apiKey: "SUPERSECRET123" };

  redactSensitiveValues(schema, input);

  assertEquals(input.apiKey, "SUPERSECRET123");
});

Deno.test("redactAllValues: replaces all leaf values with ***", () => {
  const data = { region: "us-east-1", apiToken: "secret-token", count: 42 };
  const redacted = redactAllValues(data);
  assertEquals(redacted, { region: "***", apiToken: "***", count: "***" });
});

Deno.test("redactAllValues: returns empty object unchanged", () => {
  assertEquals(redactAllValues({}), {});
});

Deno.test("redactAllValues: does not mutate the input", () => {
  const input = { key: "value" };
  redactAllValues(input);
  assertEquals(input.key, "value");
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a literal string secret", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: "SUPERSECRET123",
      region: "us-east-1",
    }),
    ["apiKey"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: allows a pure vault.get expression", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: "${{ vault.get('creds', 'apiKey') }}",
    }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: allows multiple whitespace-separated expressions", () => {
  const schema = z.object({
    token: z.string().meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      token: "${{ vault.get('a', 'x') }} ${{ vault.get('b', 'y') }}",
    }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: refuses mixed literal + expression (partial leak)", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: "prefix-${{ vault.get('creds', 'apiKey') }}",
    }),
    ["apiKey"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: refuses a non-string literal (number)", () => {
  const schema = z.object({
    secretPort: z.number().meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { secretPort: 5432 }),
    ["secretPort"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: refuses a boolean literal", () => {
  const schema = z.object({
    secretFlag: z.boolean().meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { secretFlag: true }),
    ["secretFlag"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: handles nested dot-paths", () => {
  const schema = z.object({
    credentials: z.object({
      apiKey: z.string().meta({ sensitive: true }),
    }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      credentials: { apiKey: "SECRET" },
    }),
    ["credentials.apiKey"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: ignores non-sensitive literals", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { region: "us-east-1" }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: reports every offending field", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    apiSecret: z.string().meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: "AAA",
      apiSecret: "BBB",
    }),
    ["apiKey", "apiSecret"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: skips empty / whitespace-only strings", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  assertEquals(findLiteralSensitiveGlobalArgs(schema, { apiKey: "" }), []);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { apiKey: "   " }), []);
});

Deno.test("findLiteralSensitiveGlobalArgs: returns [] for undefined schema or args", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  assertEquals(findLiteralSensitiveGlobalArgs(undefined, { apiKey: "x" }), []);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, undefined), []);
});

Deno.test("findLiteralSensitiveGlobalArgs: returns [] for a non-object schema (schema-level residual)", () => {
  // A standalone record schema has no sensitive metadata on its values, so
  // nothing is detected.
  const schema = z.record(z.string(), z.string());

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { apiKey: "SECRET" }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: accepts an all-vault.get() record", () => {
  const schema = z.object({
    secrets: z.record(z.string(), z.string()).meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      secrets: {
        MY_KEY: "${{ vault.get('my-vault', 'my-key') }}",
        OTHER: "${{ vault.get('my-vault', 'other') }}",
      },
    }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: accepts an all-vault.get() array", () => {
  const schema = z.object({
    tokens: z.array(z.string()).meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      tokens: [
        "${{ vault.get('my-vault', 'token-a') }}",
        "${{ vault.get('my-vault', 'token-b') }}",
      ],
    }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: accepts an empty record", () => {
  const schema = z.object({
    secrets: z.record(z.string(), z.string()).meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { secrets: {} }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: rejects a record with one literal string", () => {
  const schema = z.object({
    secrets: z.record(z.string(), z.string()).meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      secrets: {
        SAFE: "${{ vault.get('my-vault', 'safe') }}",
        LEAKED: "cleartext-secret",
      },
    }),
    ["secrets"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: rejects a record with a number value", () => {
  const schema = z.object({
    secrets: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      secrets: { port: 5432 },
    }),
    ["secrets"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: accepts nested containers of vault.get() expressions", () => {
  const schema = z.object({
    secrets: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
  });

  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      secrets: {
        keys: ["${{ vault.get('v', 'a') }}", "${{ vault.get('v', 'b') }}"],
        nested: { deep: "${{ vault.get('v', 'c') }}" },
      },
    }),
    [],
  );
});

Deno.test("literalSensitiveGlobalArgsMessage: names fields and gives vault remediation", () => {
  const single = literalSensitiveGlobalArgsMessage(["apiKey"]);
  assertStringIncludes(single, "'apiKey' is marked sensitive");
  assertStringIncludes(single, "vault.get");

  const multi = literalSensitiveGlobalArgsMessage(["apiKey", "apiSecret"]);
  assertStringIncludes(multi, "'apiKey', 'apiSecret' are");
});

Deno.test("buildSensitiveArgRemediations: derives vault key from leaf path segment", () => {
  const schema = z.object({
    credentials: z.object({
      apiKey: z.string().meta({ sensitive: true }),
    }),
  });

  const remediations = buildSensitiveArgRemediations(
    ["credentials.apiKey"],
    schema,
  );

  assertEquals(remediations.length, 1);
  assertEquals(remediations[0].path, "credentials.apiKey");
  assertEquals(remediations[0].vaultName, "my-vault");
  assertEquals(remediations[0].vaultKey, "apiKey");
  assertEquals(
    remediations[0].expression,
    "${{ vault.get('my-vault', 'apiKey') }}",
  );
});

Deno.test("buildSensitiveArgRemediations: honors vaultName/vaultKey metadata overrides", () => {
  const schema = z.object({
    apiKey: z.string().meta({
      sensitive: true,
      vaultName: "prod-creds",
      vaultKey: "stripe-key",
    }),
  });

  const remediations = buildSensitiveArgRemediations(["apiKey"], schema);

  assertEquals(remediations[0].vaultName, "prod-creds");
  assertEquals(remediations[0].vaultKey, "stripe-key");
  assertEquals(
    remediations[0].expression,
    "${{ vault.get('prod-creds', 'stripe-key') }}",
  );
});

Deno.test("buildSensitiveArgRemediations: never contains the secret value", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
  });

  const remediations = buildSensitiveArgRemediations(["apiKey"], schema);

  // The builder only ever receives field paths, never values — assert the
  // rendered guidance carries no secret material.
  const serialized = JSON.stringify(remediations);
  assertEquals(serialized.includes("SUPERSECRET"), false);
  assertStringIncludes(remediations[0].expression, "vault.get");
});

Deno.test("buildSensitiveArgRemediations: falls back to my-vault without a schema", () => {
  const remediations = buildSensitiveArgRemediations(["apiKey"]);

  assertEquals(remediations[0].vaultName, "my-vault");
  assertEquals(remediations[0].vaultKey, "apiKey");
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a constant expression, which stores its text in cleartext", () => {
  const schema = z.object({ apiKey: z.string().meta({ sensitive: true }) });
  for (
    const apiKey of [
      "${{ literal('hunter2') }}",
      "${{ 'hunter2' }}",
      "${{ 'hun' + 'ter2' }}",
      "${{ inputs.key }} ${{ literal('hunter2') }}",
    ]
  ) {
    assertEquals(
      findLiteralSensitiveGlobalArgs(schema, { apiKey }),
      ["apiKey"],
      apiKey,
    );
  }
});

Deno.test("findLiteralSensitiveGlobalArgs: allows expressions that read something, and blank constants", () => {
  const schema = z.object({ apiKey: z.string().meta({ sensitive: true }) });
  for (
    const apiKey of [
      "${{ vault.get('v', 'k') }}",
      "${{ env.API_KEY }}",
      "${{ inputs.?key.orValue('') }}",
      "${{ '' }}",
      "${{ null }}",
      "${{ literal('') }}",
      // Text that does not parse never evaluates to a value.
      "${{ not cel ( }}",
    ]
  ) {
    assertEquals(
      findLiteralSensitiveGlobalArgs(schema, { apiKey }),
      [],
      apiKey,
    );
  }
});

Deno.test("findLiteralSensitiveGlobalArgs: a }} inside a string does not end the expression", () => {
  const schema = z.object({ apiKey: z.string().meta({ sensitive: true }) });
  // One expression reading env; nothing outside it.
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: "${{ env.A + '}}' }}",
    }),
    [],
  );
  // An unterminated string keeps the first }} boundary, so the text after it
  // is a literal secret.
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: '${{ "abc }} secret',
    }),
    ["apiKey"],
  );
});

Deno.test("literalSensitiveGlobalArgsMessage: names constant expressions and doctor secrets", () => {
  const message = literalSensitiveGlobalArgsMessage(["apiKey"]);
  assertStringIncludes(message, "constant expression");
  assertStringIncludes(message, "swamp doctor secrets");
});

const VAULT_REF = "${{ vault.get('my-vault', 'pw') }}";

const usersSchema = z.object({
  users: z.array(z.object({
    userId: z.string(),
    password: z.string().meta({ sensitive: true }),
  })).default([]),
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a literal in a sensitive field of an array element", () => {
  assertEquals(
    findLiteralSensitiveGlobalArgs(usersSchema, {
      users: [{ userId: "u", password: "literal-pass-1" }],
    }),
    ["users[0].password"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: accepts a vault.get expression in an array element", () => {
  assertEquals(
    findLiteralSensitiveGlobalArgs(usersSchema, {
      users: [{ userId: "u", password: VAULT_REF }],
    }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: reports only the offending array elements", () => {
  assertEquals(
    findLiteralSensitiveGlobalArgs(usersSchema, {
      users: [
        { userId: "a", password: VAULT_REF },
        { userId: "b", password: "literal" },
        { userId: "c", password: "${{ literal('constant') }}" },
        { userId: "d", password: "" },
      ],
    }),
    ["users[1].password", "users[2].password"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a literal in a sensitive field of a record value", () => {
  const schema = z.object({
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ sensitive: true }) }),
    ),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      accounts: { prod: { token: "literal" }, dev: { token: VAULT_REF } },
    }),
    ["accounts.prod.token"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a literal in a sensitive field of a union member", () => {
  const schema = z.object({
    auth: z.union([
      z.object({ password: z.string().meta({ sensitive: true }) }),
      z.object({ keyFile: z.string() }),
    ]),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { auth: { password: "literal" } }),
    ["auth.password"],
  );
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { auth: { keyFile: "/tmp/k" } }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: a union member that also accepts the value does not hide a sensitive one", () => {
  // The loose member parses this value before expressions are resolved; the
  // strict member, which marks the password, does not.
  const schema = z.object({
    auth: z.union([
      z.object({
        port: z.number(),
        password: z.string().meta({ sensitive: true }),
      }),
      z.record(z.string(), z.unknown()),
    ]),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      auth: { port: "${{ inputs.port }}", password: "literal" },
    }),
    ["auth.password"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: never runs a union member's refinements", () => {
  let calls = 0;
  const schema = z.object({
    auth: z.union([
      z.object({ password: z.string().meta({ sensitive: true }) }).refine(
        () => {
          calls++;
          throw new Error("refinement ran");
        },
      ),
      z.string(),
    ]),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { auth: { password: "literal" } }),
    ["auth.password"],
  );
  assertEquals(calls, 0);
});

Deno.test("findLiteralSensitiveGlobalArgs: keeps top-level and object-nested paths unchanged", () => {
  const schema = z.object({
    apiKey: z.string().meta({ sensitive: true }),
    credentials: z.object({
      secret: z.string().meta({ sensitive: true }),
    }),
    tokens: z.record(z.string(), z.string()).meta({ sensitive: true }),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      apiKey: "a",
      credentials: { secret: "b" },
      tokens: { x: "c", y: VAULT_REF },
    }),
    ["apiKey", "credentials.secret", "tokens"],
  );
});

Deno.test("buildSensitiveArgRemediations: gives each array element its own vault key", () => {
  const args = {
    users: [
      { userId: "a", password: "one" },
      { userId: "b", password: "two" },
    ],
  };
  const paths = findLiteralSensitiveGlobalArgs(usersSchema, args);
  const remediations = buildSensitiveArgRemediations(paths, usersSchema, args);

  assertEquals(remediations.map((r) => r.vaultKey), [
    "users-0-password",
    "users-1-password",
  ]);
  assertEquals(
    remediations[0].expression,
    "${{ vault.get('my-vault', 'users-0-password') }}",
  );
  assertEquals(JSON.stringify(remediations).includes("one"), false);
});

Deno.test("buildSensitiveArgRemediations: an element path keeps a declared vaultName but not a shared vaultKey", () => {
  const schema = z.object({
    users: z.array(z.object({
      password: z.string().meta({
        sensitive: true,
        vaultName: "prod-creds",
        vaultKey: "user-password",
      }),
    })),
  });
  const args = { users: [{ password: "one" }] };
  const remediations = buildSensitiveArgRemediations(
    ["users[0].password"],
    schema,
    args,
  );

  assertEquals(remediations[0].vaultName, "prod-creds");
  assertEquals(remediations[0].vaultKey, "users-0-password");
});

Deno.test("buildSensitiveArgRemediations: builds a vault key from a record key holding dots and brackets", () => {
  const schema = z.object({
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ sensitive: true }) }),
    ),
  });
  const args = { accounts: { "eu.west[1] '$x'": { token: "literal" } } };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(remediations.length, 1);
  assertEquals(remediations[0].vaultKey, "accounts-eu-west-1-x-token");
});

Deno.test("findLiteralSensitiveGlobalArgs: a vault reference does not hide a literal under a dotted record key", () => {
  // Written as plain dot paths, both values would read users.a.b.c.
  const schema = z.object({
    users: z.record(
      z.string(),
      z.record(z.string(), z.string().meta({ sensitive: true })),
    ),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      users: { a: { "b.c": VAULT_REF }, "a.b": { c: "hunter2" } },
    }),
    ['users["a.b"].c'],
  );
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      users: { a: { "b.c": "one" }, "a.b": { c: "two" } },
    }),
    ['users.a["b.c"]', 'users["a.b"].c'],
  );
});

Deno.test("buildSensitiveArgRemediations: keeps a declared vaultKey for a field under a union or wrapper", () => {
  const password = () =>
    z.string().meta({ sensitive: true, vaultKey: "db-pass" });
  const schema = z.object({
    auth: z.union([z.object({ password: password() }), z.string()]),
    frozen: z.object({ password: password() }).readonly(),
  });
  const args = { auth: { password: "one" }, frozen: { password: "two" } };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(paths, ["auth.password", "frozen.password"]);
  assertEquals(remediations.map((r) => r.vaultKey), ["db-pass", "db-pass"]);
});

Deno.test("buildSensitiveArgRemediations: element paths that reduce to one vault key get distinct keys", () => {
  const schema = z.object({
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ sensitive: true }) }),
    ),
  });
  const args = {
    accounts: {
      "a b": { token: "one" },
      "a-b": { token: "two" },
      "a.b": { token: "three" },
    },
  };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(remediations.map((r) => r.vaultKey), [
    "accounts-a-b-token",
    "accounts-a-b-token-2",
    "accounts-a-b-token-3",
  ]);
});

Deno.test("literalSensitiveGlobalArgsMessage: says how to set a field inside an array", () => {
  const message = literalSensitiveGlobalArgsMessage(["users[1].password"]);
  assertStringIncludes(message, "'users[1].password'");
  assertStringIncludes(message, "--global-arg 'users:json=[...]'");

  const nested = literalSensitiveGlobalArgsMessage([
    "credentials.apiKey",
    "cluster.nodes[0].token",
  ]);
  assertStringIncludes(nested, "--global-arg 'cluster.nodes:json=[...]'");

  const plain = literalSensitiveGlobalArgsMessage(["credentials.apiKey"]);
  assertEquals(plain.includes(":json="), false);
});

Deno.test("literalSensitiveGlobalArgsMessage: a record key holding a bracket is not taken for an array", () => {
  const schema = z.object({
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ sensitive: true }) }),
    ),
  });
  const paths = findLiteralSensitiveGlobalArgs(schema, {
    accounts: { "eu[1]": { token: "literal" } },
  });
  assertEquals(paths, ['accounts["eu[1]"].token']);
  assertEquals(
    literalSensitiveGlobalArgsMessage(paths).includes(":json="),
    false,
  );
});

Deno.test("literalSensitiveGlobalArgsMessage: an array under a quoted record key gets the hint without a made-up key", () => {
  const message = literalSensitiveGlobalArgsMessage([
    `accounts["it's eu.west"].users[0].password`,
  ]);
  assertStringIncludes(message, "--global-arg '<name>:json=[...]'");
  assertEquals(message.includes('accounts["it\'s eu.west"].users:json'), false);
});

Deno.test("buildSensitiveArgRemediations: derives the vault key from a quoted last key", () => {
  const schema = z.object({
    "$token": z.string().meta({ sensitive: true }),
    creds: z.object({
      "api.key": z.string().meta({ sensitive: true }),
      'say "hi"': z.string().meta({ sensitive: true }),
    }),
  });
  const args = {
    "$token": "one",
    creds: { "api.key": "two", 'say "hi"': "three" },
  };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(paths, [
    '["$token"]',
    'creds["api.key"]',
    'creds["say \\"hi\\""]',
  ]);
  assertEquals(remediations.map((r) => r.vaultKey), [
    "token",
    "api-key",
    "say-hi",
  ]);
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a literal under a sensitive catchall", () => {
  const schema = z.object({
    env: z.object({}).catchall(z.string().meta({ sensitive: true })),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      env: { TOKEN: "hunter2", OTHER: VAULT_REF },
    }),
    ["env.TOKEN"],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: flags an array a coerced sensitive union member would accept", () => {
  const schema = z.object({
    pw: z.union([
      z.coerce.string().meta({ sensitive: true }),
      z.array(z.string()),
    ]),
  });
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { pw: ["hunter2"] }), [
    "pw",
  ]);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { pw: [VAULT_REF] }), []);
});

Deno.test("buildSensitiveArgRemediations: a key written with escapes gives a plain vault key", () => {
  const schema = z.object({
    "rtl\u202ekey": z.string().meta({ sensitive: true }),
  });
  const args = { "rtl\u202ekey": "literal" };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(paths, ['["rtl\\u202ekey"]']);
  assertEquals(remediations[0].vaultKey, "rtl-key");
  assertEquals(
    remediations[0].expression,
    "${{ vault.get('my-vault', 'rtl-key') }}",
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: a non-string scalar is not checked against a sensitive string union member", () => {
  const schema = z.object({
    auth: z.union([z.literal(false), z.string().meta({ sensitive: true })]),
    flag: z.union([z.boolean(), z.string().meta({ sensitive: true })]),
    port: z.union([z.number(), z.string().meta({ sensitive: true })]),
    mode: z.union([z.enum(["a", "b"]), z.number().meta({ sensitive: true })]),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      auth: false,
      flag: true,
      port: 8080,
      mode: "a",
    }),
    // A string fits every scalar member, the sensitive number included.
    ["mode"],
  );
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      auth: "hunter2",
      flag: "hunter2",
      port: "hunter2",
      mode: 7,
    }),
    ["auth", "flag", "port", "mode"],
  );
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      auth: VAULT_REF,
      flag: VAULT_REF,
      port: VAULT_REF,
      mode: VAULT_REF,
    }),
    [],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: a plain union is narrowed by the literal tag the value carries", () => {
  const schema = z.object({
    cred: z.union([
      z.object({ kind: z.literal("env"), value: z.string() }),
      z.object({
        kind: z.literal("secret"),
        value: z.string().meta({ sensitive: true }),
      }),
    ]),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      cred: { kind: "env", value: "API_TOKEN_VAR" },
    }),
    [],
  );
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      cred: { kind: "secret", value: "hunter2" },
    }),
    ["cred.value"],
  );
  // A tag that names no member, or is still an expression, keeps both.
  for (const kind of ["other", "${{ inputs.kind }}", undefined]) {
    assertEquals(
      findLiteralSensitiveGlobalArgs(schema, {
        cred: { kind, value: "hunter2" },
      }),
      ["cred.value"],
    );
  }
});

Deno.test("findLiteralSensitiveGlobalArgs: a tag another member requires does not drop a member that tolerates it", () => {
  // `.catch()` lets the first member accept any kind, so it stays a candidate.
  const schema = z.object({
    cred: z.union([
      z.object({
        kind: z.literal("secret").catch("secret"),
        value: z.string().meta({ sensitive: true }),
      }),
      z.object({ kind: z.literal("env"), value: z.string() }),
    ]),
  });
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, {
      cred: { kind: "env", value: "hunter2" },
    }),
    ["cred.value"],
  );
});

Deno.test("buildSensitiveArgRemediations: an element key differs from a key of a field that occurs once", () => {
  const schema = z.object({
    "users-0-password": z.string().meta({ sensitive: true }),
    users: z.array(z.object({
      password: z.string().meta({ sensitive: true }),
    })),
  });
  const args = {
    users: [{ password: "one" }],
    "users-0-password": "two",
  };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(
    Object.fromEntries(remediations.map((r) => [r.path, r.vaultKey])),
    {
      "users-0-password": "users-0-password",
      "users[0].password": "users-0-password-2",
    },
  );
});

Deno.test("buildSensitiveArgRemediations: derived keys that come out the same get distinct keys", () => {
  const schema = z.object({
    "api key": z.string().meta({ sensitive: true }),
    "api.key": z.string().meta({ sensitive: true }),
    "日本": z.string().meta({ sensitive: true }),
    "中国": z.string().meta({ sensitive: true }),
    a: z.object({ token: z.string().meta({ sensitive: true }) }),
    b: z.object({ token: z.string().meta({ sensitive: true }) }),
  });
  const args = {
    "api key": "1",
    "api.key": "2",
    "日本": "3",
    "中国": "4",
    a: { token: "5" },
    b: { token: "6" },
  };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(remediations.map((r) => r.vaultKey), [
    "api-key",
    "api-key-2",
    "secret",
    "secret-2",
    "token",
    "token-2",
  ]);
});

Deno.test("buildSensitiveArgRemediations: a derived key steps aside for a declared one", () => {
  const schema = z.object({
    token: z.string().meta({ sensitive: true }),
    other: z.string().meta({ sensitive: true, vaultKey: "token" }),
    twin: z.string().meta({ sensitive: true, vaultKey: "token" }),
  });
  const args = { token: "1", other: "2", twin: "3" };
  const paths = findLiteralSensitiveGlobalArgs(schema, args);
  const remediations = buildSensitiveArgRemediations(paths, schema, args);

  assertEquals(remediations.map((r) => r.vaultKey), [
    "token-2",
    "token",
    "token",
  ]);
});

Deno.test("findLiteralSensitiveGlobalArgs: a null union member does not let a number through", () => {
  const schema = z.object({
    pin: z.union([z.string().meta({ sensitive: true }), z.null()]),
  });
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { pin: 123456 }), [
    "pin",
  ]);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { pin: null }), []);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { pin: VAULT_REF }), []);
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a scalar given for an array of sensitive elements", () => {
  const schema = z.object({
    tokens: z.array(z.string().meta({ sensitive: true })),
  });
  // `--global-arg tokens=hunter2`, without `:json`.
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { tokens: "hunter2" }), [
    "tokens",
  ]);
  // One expression that resolves to the whole array stores no cleartext.
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, { tokens: VAULT_REF }),
    [],
  );
  assertEquals(
    buildSensitiveArgRemediations(["tokens"], schema, { tokens: "hunter2" }),
    [{
      path: "tokens",
      vaultName: "my-vault",
      vaultKey: "tokens",
      expression: "${{ vault.get('my-vault', 'tokens') }}",
    }],
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: flags a literal for a field marked on the output side of a pipe", () => {
  const schema = z.object({
    key: z.string().pipe(z.string().meta({ sensitive: true })),
  });
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { key: "hunter2" }), [
    "key",
  ]);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { key: VAULT_REF }), []);
});

const nestedSecretsSchema = z.object({
  region: z.string(),
  apiKey: z.string().meta({ sensitive: true }).nullable().optional(),
  users: z.array(z.object({
    userId: z.string(),
    password: z.string().meta({ sensitive: true }),
  })),
  accounts: z.record(
    z.string(),
    z.object({ token: z.string().meta({ sensitive: true }) }),
  ),
  auth: z.union([
    z.object({
      kind: z.literal("token"),
      token: z.string().meta({ sensitive: true }),
    }),
    z.object({ kind: z.literal("none") }),
  ]),
});

const nestedSecrets = () => ({
  region: "us-east-1",
  apiKey: "top-secret",
  users: [
    { userId: "a", password: "pw-a" },
    { userId: "b", password: "pw-b" },
  ],
  accounts: { "eu.west": { token: "tok-eu" } },
  auth: { kind: "token", token: "tok-auth" },
});

Deno.test("extractSensitiveFieldValues: collects values inside array elements, record values and union members", () => {
  assertEquals(
    extractSensitiveFieldValues(nestedSecretsSchema, nestedSecrets()).sort(),
    ["pw-a", "pw-b", "tok-auth", "tok-eu", "top-secret"],
  );
});

Deno.test("redactSensitiveValues: masks values inside array elements, record values and union members", () => {
  const data = nestedSecrets();
  assertEquals(redactSensitiveValues(nestedSecretsSchema, data), {
    region: "us-east-1",
    apiKey: "***",
    users: [
      { userId: "a", password: "***" },
      { userId: "b", password: "***" },
    ],
    accounts: { "eu.west": { token: "***" } },
    auth: { kind: "token", token: "***" },
  });
  // The input is left as it was.
  assertEquals(data, nestedSecrets());
});

Deno.test("redactSensitiveValues: still masks a null field and returns the input when nothing is sensitive", () => {
  const data = { ...nestedSecrets(), apiKey: null };
  assertEquals(
    redactSensitiveValues(nestedSecretsSchema, data).apiKey,
    "***",
  );
  const plain = { users: [], accounts: {}, region: "x" };
  assertEquals(
    redactSensitiveValues(z.object({ region: z.string() }), plain),
    plain,
  );
});

Deno.test("redactSensitiveValues: masks a value of the wrong shape whole", () => {
  const schema = z.object({
    tokens: z.array(z.string().meta({ sensitive: true })),
  });
  assertEquals(redactSensitiveValues(schema, { tokens: "hunter2" }), {
    tokens: "***",
  });
  assertEquals(extractSensitiveFieldValues(schema, { tokens: "hunter2" }), [
    "hunter2",
  ]);
});

Deno.test("redactSensitiveValues: does not add a key for an absent field named like a prototype member", () => {
  const schema = z.object({
    toString: z.string().meta({ sensitive: true }).optional(),
    region: z.string(),
  });
  const redacted = redactSensitiveValues(schema, { region: "x" });
  assertEquals(Object.keys(redacted), ["region"]);
  assertEquals(findLiteralSensitiveGlobalArgs(schema, { region: "x" }), []);
});

Deno.test("redactSensitiveValues and extractSensitiveFieldValues: a schema that marks nothing is answered without reading the value", () => {
  const schema = z.object({ region: z.string(), list: z.array(z.string()) });
  // Reading any property of this value throws.
  const data = new Proxy({}, {
    get: () => {
      throw new Error("value was read");
    },
    ownKeys: () => {
      throw new Error("value was read");
    },
  }) as Record<string, unknown>;
  assertEquals(redactSensitiveValues(schema, data) === data, true);
  assertEquals(extractSensitiveFieldValues(schema, data), []);
});

Deno.test("maskLiteralSensitiveValues: masks a literal and keeps a vault reference", () => {
  const schema = z.object({
    token: z.string().meta({ sensitive: true }),
    key: z.string().meta({ sensitive: true }),
    region: z.string(),
  });
  const vaultRef = "${{ vault.get('v', 'k') }}";
  const data = { token: "hunter2", key: vaultRef, region: "us-east-1" };
  assertEquals(maskLiteralSensitiveValues(schema, data), {
    token: "***",
    key: vaultRef,
    region: "us-east-1",
  });
  assertEquals(data.token, "hunter2");
});

Deno.test("maskLiteralSensitiveValues: masks nested, array and record values", () => {
  const schema = z.object({
    credentials: z.object({ apiKey: z.string().meta({ sensitive: true }) }),
    users: z.array(
      z.object({ password: z.string().meta({ sensitive: true }) }),
    ),
    accounts: z.record(
      z.string(),
      z.object({ token: z.string().meta({ sensitive: true }) }),
    ),
  });
  const masked = maskLiteralSensitiveValues(schema, {
    credentials: { apiKey: "secret-a" },
    users: [{ password: "secret-b" }],
    accounts: { prod: { token: "secret-c" } },
  });
  assertEquals(masked, {
    credentials: { apiKey: "***" },
    users: [{ password: "***" }],
    accounts: { prod: { token: "***" } },
  });
});

Deno.test("maskLiteralSensitiveValues: masks a mixed string, a constant expression and a number", () => {
  const schema = z.object({
    a: z.string().meta({ sensitive: true }),
    b: z.string().meta({ sensitive: true }),
    c: z.number().meta({ sensitive: true }),
  });
  assertEquals(
    maskLiteralSensitiveValues(schema, {
      a: "prefix-${{ vault.get('v', 'k') }}",
      b: "${{ literal('hunter2') }}",
      c: 1234,
    }),
    { a: "***", b: "***", c: "***" },
  );
});

Deno.test("maskLiteralSensitiveValues: masks a container holding any literal whole", () => {
  const schema = z.object({
    tokens: z.record(z.string(), z.string()).meta({ sensitive: true }),
  });
  assertEquals(
    maskLiteralSensitiveValues(schema, {
      tokens: { a: "${{ vault.get('v', 'a') }}", b: "plain" },
    }),
    { tokens: "***" },
  );
});

Deno.test("maskLiteralSensitiveValues: returns the input when nothing is masked", () => {
  const schema = z.object({
    token: z.string().meta({ sensitive: true }).optional(),
    region: z.string(),
  });
  const data = { token: "${{ vault.get('v', 'k') }}", region: "x" };
  assertEquals(maskLiteralSensitiveValues(schema, data) === data, true);
  const empty = { token: "", region: "x" };
  assertEquals(maskLiteralSensitiveValues(schema, empty) === empty, true);
});

Deno.test("maskLiteralSensitiveValues: a schema that marks nothing is answered without reading the value", () => {
  const schema = z.object({ region: z.string() });
  const data = new Proxy({}, {
    get: () => {
      throw new Error("value was read");
    },
    ownKeys: () => {
      throw new Error("value was read");
    },
  }) as Record<string, unknown>;
  assertEquals(maskLiteralSensitiveValues(schema, data) === data, true);
});

Deno.test("findLiteralSensitiveValues: reports each literal sensitive value with its keys and spelled path (swamp-club#3681)", () => {
  const schema = z.object({
    token: z.string().meta({ sensitive: true }),
    credentials: z.object({ apiKey: z.string().meta({ sensitive: true }) }),
    users: z.array(z.object({ pw: z.string().meta({ sensitive: true }) })),
    region: z.string(),
  });
  const data = {
    token: "Bearer ${{ vault.get('v', 'k') }}",
    credentials: { apiKey: "hunter2" },
    users: [{ pw: "${{ vault.get('v', 'pw') }}" }, { pw: "plain" }],
    region: "us-east-1",
  };
  const found = findLiteralSensitiveValues(schema, data)
    .map(({ path, keys, value }) => [path, keys, value])
    .sort();
  assertEquals(found, [
    ["credentials.apiKey", ["credentials", "apiKey"], "hunter2"],
    ["token", ["token"], "Bearer ${{ vault.get('v', 'k') }}"],
    ["users[1].pw", ["users", 1, "pw"], "plain"],
  ]);
  assertEquals(
    findLiteralSensitiveGlobalArgs(schema, data),
    findLiteralSensitiveValues(schema, data).map(({ path }) => path),
  );
  assertEquals(findLiteralSensitiveValues(undefined, data), []);
  assertEquals(findLiteralSensitiveValues(schema, undefined), []);
});

Deno.test("holdsRuntimeExpression: true while an expression that reads a root, or one that does not parse, is still in the text (swamp-club#3681)", () => {
  assertEquals(
    holdsRuntimeExpression("Bearer ${{ vault.get('v', 'k') }}"),
    true,
  );
  assertEquals(holdsRuntimeExpression("token=${{ env.TOKEN }}"), true);
  assertEquals(
    holdsRuntimeExpression("s-${{ data.latest('a', 'b').attributes.id }}"),
    true,
  );
  assertEquals(holdsRuntimeExpression("${{ inputs.key }}"), true);
  assertEquals(holdsRuntimeExpression("${{ not valid ( }}"), true);
  // Resolved text, a constant expression, and no expression at all.
  assertEquals(holdsRuntimeExpression("Bearer hunter2"), false);
  assertEquals(holdsRuntimeExpression("${{ literal('hunter2') }}"), false);
  assertEquals(holdsRuntimeExpression("${{ 'hunter2' }}"), false);
  assertEquals(holdsRuntimeExpression(""), false);
});

Deno.test("objectKeysOf: every own key of every plain object at any depth, and nothing of scalars or arrays (swamp-club#3681)", () => {
  assertEquals(
    [...objectKeysOf({ a: 1, b: { c: [{ d: null }] } })].sort(),
    ["a", "b", "c", "d"],
  );
  assertEquals([...objectKeysOf(["x", 1, null])], []);
  assertEquals([...objectKeysOf("x")], []);
  assertEquals([...objectKeysOf(undefined)], []);
});

Deno.test("extractRefusedSensitiveValues: the input of an issue at, under or above a sensitive position, as the failing check received it; every issue when the schema transforms values; a key the parse introduced; nothing when the schema marks nothing (swamp-club#3681)", () => {
  const secret = z.string().meta({ sensitive: true });
  const plain = z.object({
    token: secret,
    count: z.number(),
    creds: z.object({ key: secret }).optional(),
  });
  const input = {
    token: "raw-token",
    count: "not-a-number",
    creds: "not-an-object",
  };
  assertEquals(
    extractRefusedSensitiveValues(plain, input, [
      { path: ["token"], input: "TRANSFORMED-TOKEN" },
      { path: ["count"], input: "not-a-number" },
      { path: ["creds"], input: "not-an-object" },
      { path: ["creds", "key"], input: "nested-key-value" },
      { path: [], input: { token: "whole-input" } },
    ]).sort(),
    ["TRANSFORMED-TOKEN", "nested-key-value", "not-an-object", "whole-input"],
  );
  const piped = z.object({ raw: z.string() }).transform((x) => ({
    token: x.raw,
  })).pipe(z.object({ token: secret }));
  assertEquals(
    extractRefusedSensitiveValues(piped, { raw: "r" }, [
      { path: ["token"], input: "MADE" },
      { path: ["other"], input: "ALSO" },
    ]).sort(),
    ["ALSO", "MADE"],
  );
  const keyed = z.object({ raw: z.string() }).transform((x) => ({
    tokens: { [x.raw]: null } as Record<string, unknown>,
  })).pipe(
    z.object({
      tokens: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
    }),
  );
  assertEquals(
    extractRefusedSensitiveValues(keyed, { raw: "r" }, [
      { path: ["tokens"], input: { MADE: null, raw: null } },
    ]),
    ["MADE"],
  );
  assertEquals(
    extractRefusedSensitiveValues(z.object({ count: z.number() }), {
      count: "x",
    }, [{ path: ["count"], input: "x" }]),
    [],
  );
});

Deno.test("maskRefusedIssues: an issue at, under or above a sensitive position is described in Zod's words from its fields, every issue when the schema transforms values or its own code encloses a sensitive position, a described issue is only 'Invalid input' when that code may set an issue's fields, a path segment neither spelled nor declared is masked in any issue, an issue beside a sensitive position keeps its message, only code, path and message survive, and a schema that marks nothing keeps every message (swamp-club#3681)", () => {
  const secret = z.string().meta({ sensitive: true });
  const issue = (
    path: PropertyKey[],
    message: string,
    fields: Record<string, unknown> = {},
  ): z.ZodIssue =>
    ({
      code: "custom",
      path,
      message,
      input: undefined,
      ...fields,
    }) as z.ZodIssue;
  const plain = z.object({
    token: secret,
    count: z.number(),
    creds: z.object({ key: secret }).optional(),
    items: z.array(z.string()),
  });
  const input = {
    token: "raw-token",
    count: 0,
    creds: { key: "k" },
    items: ["a", "b"],
  };
  const masked = maskRefusedIssues(plain, input, [
    issue(["token"], "derived RAW-TOKEN"),
    issue(["token"], "secret too short: RAW", {
      code: "too_small",
      minimum: 8,
      inclusive: true,
      origin: "string",
    }),
    issue(["token", "RAW-TOKEN"], "bad credential"),
    issue(["creds", "key"], "nested RAW"),
    issue(["count"], "count must be positive", {
      code: "too_small",
      minimum: 1,
      inclusive: true,
      origin: "number",
    }),
    issue([], "exactly one of token or count"),
    issue(["RAW-TOKEN"], "root path made"),
    issue(["creds", 0, "key"], "indexed"),
    issue(["items", 1], "second item"),
    issue(["items", 7, Symbol("made")], "made index"),
    issue(["creds"], "extra keys", {
      code: "unrecognized_keys",
      keys: ["count", "RAW-TOKEN"],
    }),
    issue(["creds"], "an instance", {
      code: "invalid_type",
      expected: "object",
      input: new Map([["RAW", "TOKEN"]]),
    }),
  ]);
  assertEquals(masked.map((found) => [found.path, found.message]), [
    [["token"], "Invalid input"],
    [["token"], "Too small: expected string to have >=8 characters"],
    [["token", "***"], "Invalid input"],
    [["creds", "key"], "Invalid input"],
    [["count"], "count must be positive"],
    [[], "Invalid input"],
    [["***"], "root path made"],
    [["creds", 0, "key"], "indexed"],
    [["items", 1], "second item"],
    [["items", "***", "***"], "made index"],
    [["creds"], 'Unrecognized keys: "count", "***"'],
    [["creds"], "Invalid input: expected object, received object"],
  ]);
  // What the failing check received, and whatever the schema's code set,
  // travel no further.
  for (const found of masked) {
    assertEquals(Object.keys(found), ["code", "path", "message"]);
  }

  // A refinement on an enclosing node receives the value and may write it
  // into any issue, at any path: every issue is described. Its fields stay
  // Zod's own, so a built-in check beside the position keeps its wording.
  const refined = z.object({ token: secret, count: z.number() }).refine(
    () => false,
    "exactly one of token or count",
  );
  assertEquals(
    maskRefusedIssues(refined, { token: "raw-token", count: 0 }, [
      issue([], "exactly one of token or count"),
      issue(["count"], "count must be positive", {
        code: "too_small",
        minimum: 1,
        inclusive: true,
        origin: "number",
      }),
    ]).map((found) => [found.path, found.message]),
    [
      [[], "Invalid input"],
      [["count"], "Too small: expected number to be >=1"],
    ],
  );
  // A superRefine on an enclosing node may set an issue's fields too, so a
  // described issue says nothing a field could spell.
  const superRefined = z.object({ token: secret, count: z.number() })
    .superRefine(() => {});
  assertEquals(
    maskRefusedIssues(superRefined, { token: "raw-token", count: 0 }, [
      issue(["count"], "count must equal raw-token"),
      issue(["count"], "forged bound", {
        code: "too_small",
        minimum: 1234,
        inclusive: true,
        origin: "number",
      }),
    ]).map((found) => [found.path, found.message]),
    [[["count"], "Invalid input"], [["count"], "Invalid input"]],
  );
  // A schema marked at its root holds the value whole.
  const whole = z.object({ a: z.string() }).meta({ sensitive: true });
  assertEquals(
    maskRefusedIssues(whole, { a: "x" }, [issue(["a"], "a is x")]).map((
      found,
    ) => [found.path, found.message]),
    [[["a"], "Invalid input"]],
  );

  const piped = z.object({ raw: z.string() }).transform((x) => ({
    token: x.raw,
  })).pipe(z.object({ token: secret }));
  assertEquals(
    maskRefusedIssues(piped, { raw: "r" }, [
      issue(["token"], "made MADE"),
      issue([], "whole"),
      issue(["other"], "x"),
    ]).map((found) => [found.path, found.message]),
    [
      [["token"], "Invalid input"],
      [[], "Invalid input"],
      [["***"], "Invalid input"],
    ],
  );

  assertEquals(
    maskRefusedIssues(z.object({ count: z.number() }), { count: "x" }, [
      issue(["count"], "kept RAW"),
      issue([Symbol("made")], "symbol"),
    ]),
    [
      { code: "custom", path: ["count"], message: "kept RAW" },
      { code: "custom", path: ["***"], message: "symbol" },
    ],
  );
});

Deno.test("extractRefusedSensitiveValues: every issue counts when the schema's own code encloses a sensitive position, and a schema marked at its root holds every issue (swamp-club#3681)", () => {
  const secret = z.string().meta({ sensitive: true });
  const refined = z.object({ token: secret, count: z.number() }).superRefine(
    () => {},
  );
  assertEquals(
    extractRefusedSensitiveValues(refined, { token: "raw", count: 0 }, [
      { path: ["count"], input: { token: "raw-token", count: 0 } },
    ]),
    ["raw-token"],
  );
  const whole = z.object({ a: z.string() }).meta({ sensitive: true });
  assertEquals(
    extractRefusedSensitiveValues(whole, { a: "x" }, [
      { path: ["a"], input: "x-value" },
    ]),
    ["x-value"],
  );
});

Deno.test("extractRefusedSensitiveValues: text the input holds only at positions the schema leaves plain, and a key the schema declares, are left out of what a refusal registers, while a value a sensitive position holds is registered even where a plain position holds it too (swamp-club#3753)", () => {
  const secret = z.string().meta({ sensitive: true });
  const refused = (schema: z.ZodTypeAny, input: Record<string, unknown>) => {
    const result = schema.safeParse(input, { reportInput: true });
    assertEquals(result.success, false);
    return result.success
      ? []
      : extractRefusedSensitiveValues(schema, input, result.error.issues)
        .sort();
  };
  // A refinement above the position receives the whole object.
  assertEquals(
    refused(
      z.object({ token: secret, env: z.string(), region: z.string() }).refine(
        (v) => v.env !== "prod" || v.region !== "eu-west-1",
        "region not allowed in prod",
      ),
      { token: "hunter2-long", env: "prod", region: "eu-west-1" },
    ),
    ["hunter2-long"],
  );
  // A strict object's unrecognized key is refused at the root, with the
  // whole object as its input.
  assertEquals(
    refused(z.strictObject({ token: secret, env: z.string() }), {
      token: "hunter2-long",
      env: "prod",
      stray: "stray-value",
    }),
    ["hunter2-long"],
  );
  // Under a transform, what the transform made of the value is registered
  // and the plain value it passed through is not.
  assertEquals(
    refused(
      z.object({
        token: secret.transform((text) => text.toUpperCase()),
        env: z.string(),
      }).refine(() => false, "refused"),
      { token: "hunter2-long", env: "prod" },
    ),
    ["HUNTER2-LONG"],
  );
  // A field name the schema declares is not a secret, though a transform
  // made the object that holds it.
  assertEquals(
    refused(
      z.object({ raw: z.string() }).transform((x) => ({
        token: x.raw.toUpperCase(),
      })).pipe(z.object({ token: secret }).refine(() => false, "refused")),
      { raw: "hunter2-long" },
    ),
    ["HUNTER2-LONG"],
  );
  // The same text at a sensitive and a plain position is sensitive.
  assertEquals(
    refused(
      z.object({ password: secret, user: z.string() }).refine(
        () => false,
        "refused",
      ),
      { password: "admin-pass", user: "admin-pass" },
    ),
    ["admin-pass"],
  );
});

Deno.test("schemaThrew: Zod's own error for an async check, which names no input, is returned as it is; any other throw from a schema marking a field sensitive is withheld, naming only a standard error (swamp-club#3753)", async () => {
  const secret = z.string().meta({ sensitive: true });
  const asyncChecked = z.object({
    token: secret.refine(() => Promise.resolve(true)),
  });
  const thrown = (() => {
    try {
      asyncChecked.safeParse({ token: "hunter2-long" });
    } catch (error) {
      return error;
    }
    return undefined;
  })();
  assertEquals(thrown instanceof z.core.$ZodAsyncError, true);
  assertEquals(schemaThrew(thrown, asyncChecked, "Method arguments"), thrown);
  assertEquals(
    (await asyncChecked.safeParseAsync({ token: "hunter2-long" })).success,
    true,
  );

  const plain = z.object({ token: secret });
  const named = new Error("hunter2-long");
  named.name = "CredentialError:hunter2-long";
  for (
    const [error, name] of [
      [new TypeError("hunter2-long"), "TypeError"],
      [named, "an error"],
      ["hunter2-long", "a string"],
    ] as const
  ) {
    const message = schemaThrowMessage(error, plain, "Method arguments");
    assertStringIncludes(
      message,
      `Method arguments validation failed: the schema threw ${name} while parsing them`,
    );
    assertEquals(message.includes("hunter2-long"), false);
  }
  const unmarked = new TypeError("plain message");
  assertEquals(
    schemaThrew(unmarked, z.object({ token: z.string() }), "Method arguments"),
    unmarked,
  );
});
