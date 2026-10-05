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
  describeVaultConfigFields,
  exampleConfigFor,
  explainVaultConfigIssues,
  findMissingRequiredFields,
  isSecretLikeFieldName,
  sanitizeFieldText,
  shellSingleQuote,
  vaultConfigField,
} from "./vault_config_fields.ts";

const ONE_PASSWORD = z.object({
  op_vault: z.string().min(1).describe("The 1Password vault to use"),
  op_account: z.string().optional().describe("Account shorthand or UUID"),
}).strict();

const migrateHint = (example: string) =>
  `Re-run with: swamp vault migrate my-vault --to-type '@swamp/1password' --config '${example}'`;

Deno.test("describeVaultConfigFields: reads name, type, description and required from an object schema", () => {
  assertEquals(describeVaultConfigFields(ONE_PASSWORD), [
    {
      name: "op_vault",
      type: "string",
      description: "The 1Password vault to use",
      required: true,
    },
    {
      name: "op_account",
      type: "string",
      description: "Account shorthand or UUID",
      required: false,
    },
  ]);
});

Deno.test("describeVaultConfigFields: a defaulted or caught field is optional, a nullable one is not, and each keeps its base type", () => {
  const fields = describeVaultConfigFields(z.object({
    region: z.string().default("us-east-1"),
    retries: z.number().catch(3),
    label: z.string().nullable(),
    port: z.number(),
  }));
  assertEquals(fields.map((f) => [f.name, f.type, f.required]), [
    ["region", "string", false],
    ["retries", "number", false],
    ["label", "string", true],
    ["port", "number", true],
  ]);
  assertEquals(fields[0].description, undefined);
});

Deno.test("describeVaultConfigFields: a schema without a shape yields no fields", () => {
  assertEquals(describeVaultConfigFields(z.string()), []);
  assertEquals(describeVaultConfigFields(z.record(z.string(), z.string())), []);
});

Deno.test("describeVaultConfigFields: sanitizes author-written descriptions", () => {
  const fields = describeVaultConfigFields(z.object({
    token: z.string().describe("\x1b[31mred\x1b[0m\n\ttoken\x07"),
  }));
  assertEquals(fields[0].description, "red token");
});

Deno.test("sanitizeFieldText: strips escapes and control characters, collapses whitespace and caps length", () => {
  assertEquals(
    sanitizeFieldText("  a \x1b]0;title\x07b\x1b[2Jc  d ", 100),
    "a bc d",
  );
  assertEquals(sanitizeFieldText("x".repeat(20), 8), "xxxxxxx…");
  assertEquals(sanitizeFieldText("short", 8), "short");
  assertEquals(sanitizeFieldText("\x00\x7f\x9f", 8), "");
});

Deno.test("vaultConfigField: sanitizes every part and drops an empty description", () => {
  assertEquals(
    vaultConfigField({
      name: "op\x1b[1m_vault",
      type: "str\ning",
      description: "   ",
      required: true,
    }),
    { name: "op_vault", type: "str ing", required: true },
  );
  assertEquals(
    vaultConfigField({ name: "n", type: "\x00", required: false }).type,
    "unknown",
  );
});

Deno.test("findMissingRequiredFields: returns the required fields the config leaves out, in schema order", () => {
  const fields = describeVaultConfigFields(ONE_PASSWORD);
  assertEquals(findMissingRequiredFields(fields, {}).map((f) => f.name), [
    "op_vault",
  ]);
  assertEquals(findMissingRequiredFields(fields, { op_vault: "Private" }), []);
  assertEquals(
    findMissingRequiredFields(fields, { op_vault: "" }).map((f) => f.name),
    [],
  );
});

Deno.test("exampleConfigFor: keeps what the user supplied and adds one placeholder per missing field", () => {
  const fields = describeVaultConfigFields(ONE_PASSWORD);
  assertEquals(
    exampleConfigFor(findMissingRequiredFields(fields, {})),
    '{"op_vault":"<op_vault>"}',
  );
  assertEquals(
    exampleConfigFor(findMissingRequiredFields(fields, { op_account: "me" }), {
      op_account: "me",
    }),
    '{"op_account":"me","op_vault":"<op_vault>"}',
  );
  assertEquals(exampleConfigFor([]), "{}");
});

Deno.test("exampleConfigFor: never repeats a value under a secret-looking key", () => {
  assertEquals(
    exampleConfigFor(
      [{ name: "region", type: "string", required: true }],
      { secretKey: "s3cr3t", projectId: "p1", api_token: "t" },
    ),
    '{"secretKey":"<secretKey>","projectId":"p1","api_token":"<api_token>","region":"<region>"}',
  );
});

Deno.test("isSecretLikeFieldName: credential-shaped names, in any case or separator", () => {
  for (
    const name of [
      "secretKey",
      "token",
      "VAULT_TOKEN",
      "password",
      "passwd",
      "api_key",
      "api-key",
      "apiKey",
      "private_key",
      "credentials",
      "client_secret",
    ]
  ) {
    assertEquals(isSecretLikeFieldName(name), true, name);
  }
  for (
    const name of ["op_vault", "region", "vault_url", "project_id", "keyring"]
  ) {
    assertEquals(isSecretLikeFieldName(name), false, name);
  }
});

Deno.test("findMissingRequiredFields: an inherited property does not count as supplied", () => {
  const fields = [
    { name: "constructor", type: "string", required: true },
    { name: "toString", type: "string", required: true },
  ];
  assertEquals(findMissingRequiredFields(fields, {}).map((f) => f.name), [
    "constructor",
    "toString",
  ]);
  assertEquals(
    findMissingRequiredFields(fields, { constructor: "x", toString: "y" }),
    [],
  );
});

function explain(
  schema: z.ZodTypeAny,
  config: Record<string, unknown>,
  rerunHint = migrateHint,
): string {
  const result = schema.safeParse(config);
  if (result.success) throw new Error("expected the config to fail");
  return explainVaultConfigIssues({
    vaultType: "@swamp/1password",
    config,
    issues: result.error.issues,
    fields: describeVaultConfigFields(schema),
    rerunHint,
  });
}

Deno.test("explainVaultConfigIssues: a missing required field is named with its description and an example --config", () => {
  assertEquals(
    explain(ONE_PASSWORD, {}),
    "Invalid config for vault type '@swamp/1password': missing required field " +
      "'op_vault' (The 1Password vault to use). Re-run with: swamp vault migrate " +
      "my-vault --to-type '@swamp/1password' --config '{\"op_vault\":\"<op_vault>\"}'",
  );
});

Deno.test("explainVaultConfigIssues: a wrong type names the expected and actual kinds", () => {
  const message = explain(ONE_PASSWORD, { op_vault: 42 });
  assertStringIncludes(message, "field 'op_vault' expects string, got number");
  assertStringIncludes(message, "Re-run with:");
});

Deno.test("explainVaultConfigIssues: an unknown key lists the accepted fields", () => {
  const message = explain(ONE_PASSWORD, { op_vault: "Private", vault: "x" });
  assertEquals(
    message,
    "Invalid config for vault type '@swamp/1password': unknown field 'vault'; " +
      "accepted fields: op_vault, op_account. Re-run with: swamp vault migrate " +
      "my-vault --to-type '@swamp/1password' --config " +
      '\'{"op_vault":"Private","vault":"x"}\'',
  );
});

Deno.test("explainVaultConfigIssues: several problems become a bulleted list with the hint last", () => {
  const message = explain(ONE_PASSWORD, { bogus: 1, op_account: 7 });
  assertEquals(message.split("\n"), [
    "Invalid config for vault type '@swamp/1password':",
    "  - missing required field 'op_vault' (The 1Password vault to use)",
    "  - field 'op_account' expects string, got number",
    "  - unknown field 'bogus'; accepted fields: op_vault, op_account",
    "Re-run with: swamp vault migrate my-vault --to-type '@swamp/1password' " +
    '--config \'{"bogus":1,"op_account":7,"op_vault":"<op_vault>"}\'',
  ]);
});

Deno.test("explainVaultConfigIssues: other issues fall back to the issue message under the field path", () => {
  const message = explain(ONE_PASSWORD, { op_vault: "" }, () => "");
  assertEquals(
    message,
    "Invalid config for vault type '@swamp/1password': field 'op_vault': " +
      "Too small: expected string to have >=1 characters.",
  );
});

Deno.test("explainVaultConfigIssues: a missing field unknown to the field list is still named", () => {
  const message = explainVaultConfigIssues({
    vaultType: "@acme/vault",
    vaultName: "shared",
    config: {},
    issues: [{
      code: "invalid_type",
      path: ["token"],
      message: "Invalid input: expected string, received undefined",
      expected: "string",
    }],
    fields: [],
  });
  assertEquals(
    message,
    "Invalid config for vault type '@acme/vault' (vault 'shared'): missing " +
      "required field 'token'.",
  );
});

Deno.test("explainVaultConfigIssues: a nested path and author-written messages are sanitized", () => {
  const message = explainVaultConfigIssues({
    vaultType: "@acme/vault",
    config: { auth: {} },
    issues: [{
      code: "custom",
      path: ["auth", "mode"],
      message: "pick one\x1b[0m\nof the modes",
    }],
    fields: [],
  });
  assertEquals(
    message,
    "Invalid config for vault type '@acme/vault': field 'auth.mode': pick one of the modes.",
  );
});

Deno.test("explainVaultConfigIssues: no issues still produces a sentence", () => {
  assertEquals(
    explainVaultConfigIssues({
      vaultType: "@acme/vault",
      config: {},
      issues: [],
      fields: [],
    }),
    "Invalid config for vault type '@acme/vault': the config does not match the type's schema.",
  );
});

Deno.test("shellSingleQuote: wraps in single quotes and escapes an embedded one", () => {
  assertEquals(shellSingleQuote('{"a":"b"}'), '\'{"a":"b"}\'');
  assertEquals(shellSingleQuote("it's"), "'it'\\''s'");
  assertEquals(shellSingleQuote(""), "''");
});
