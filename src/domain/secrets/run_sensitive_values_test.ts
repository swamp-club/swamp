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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  RunSensitiveValues,
  vaultReferenceText,
} from "./run_sensitive_values.ts";
import { SecretRedactor } from "./secret_redactor.ts";

const source = { vaultName: "prod-vault", key: "db-password" };

Deno.test("RunSensitiveValues.addSecret: records a value with its vault source", () => {
  const values = new RunSensitiveValues();
  values.addSecret("hunter2-long", source);
  assertEquals(values.list(), [{ value: "hunter2-long", source }]);
  assertEquals(values.sourceOf("hunter2-long"), source);
  assertEquals(values.isEmpty, false);
});

Deno.test("RunSensitiveValues.addSecret: ignores values shorter than 3 characters", () => {
  const values = new RunSensitiveValues();
  values.addSecret("ab", source);
  values.addSecret("", source);
  assertEquals(values.isEmpty, true);
});

Deno.test("RunSensitiveValues.addSecret: forwards every value to the redactor", () => {
  const redactor = new SecretRedactor();
  const values = new RunSensitiveValues(redactor);
  values.addSecret("hunter2-long", source);
  values.addSecret("no-source-value");
  assertEquals(redactor.redact("a hunter2-long b"), "a *** b");
  assertEquals(redactor.redact("no-source-value"), "***");
  // Only values with a vault source are recorded.
  assertEquals(values.list().map((e) => e.value), ["hunter2-long"]);
});

Deno.test("RunSensitiveValues.list: returns longest values first", () => {
  const values = new RunSensitiveValues();
  values.addSecret("abc", source);
  values.addSecret("abcdef", { vaultName: "v", key: "k" });
  assertEquals(values.list().map((e) => e.value), ["abcdef", "abc"]);
});

Deno.test("RunSensitiveValues.placeholderFor: never merges distinct vault keys", () => {
  const values = new RunSensitiveValues();
  const names = [
    { vaultName: "a-b", key: "c" },
    { vaultName: "a", key: "b-c" },
    { vaultName: "a", key: "x/y" },
    { vaultName: "a", key: "x--y" },
    { vaultName: "a", key: ".b" },
    { vaultName: "a", key: "..b" },
  ].map((s) => values.placeholderFor(s));
  assertEquals(new Set(names).size, names.length);
  for (const name of names) {
    assertEquals(name.includes("/"), false);
    assertEquals(name.includes(".."), false);
  }
  assertEquals(names[0], "sensitive-a-b.c");
});

Deno.test("RunSensitiveValues.withPlaceholders: replaces recorded values in text", () => {
  const values = new RunSensitiveValues();
  values.addSecret("s3cr3t-token", source);
  assertEquals(
    values.withPlaceholders("deploy-s3cr3t-token"),
    "deploy-sensitive-prod-vault.db-password",
  );
  assertEquals(
    values.tagsWithPlaceholders({ env: "prod", token: "s3cr3t-token" }),
    { env: "prod", token: "sensitive-prod-vault.db-password" },
  );
});

Deno.test("RunSensitiveValues.masked: masks values, escaped forms and coerced scalars", () => {
  const values = new RunSensitiveValues();
  values.addSecret('pa"ss\nword', source);
  values.addSecret("8080", { vaultName: "v", key: "port" });
  const masked = values.masked({
    run: 'echo pa"ss\nword',
    json: JSON.stringify({ p: 'pa"ss\nword' }),
    port: 8080,
    other: 1,
  });
  assertEquals(masked, {
    run: "echo ***",
    json: '{"p":"***"}',
    port: "***",
    other: 1,
  });
});

Deno.test("vaultReferenceText: matches the reference a data record stores", () => {
  assertEquals(
    vaultReferenceText(source),
    "${{ vault.get('prod-vault', 'db-password') }}",
  );
  assertNotEquals(vaultReferenceText(source), "");
});

Deno.test("RunSensitiveValues.withPlaceholdersDeep: hides values before a suffix rewrites them", async () => {
  const { coerceToSuffix } = await import("../workflows/data_suffix.ts");
  const values = new RunSensitiveValues();
  const slashed = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const quoted = 'pa"ss\\word-long';
  values.addSecret(slashed, { vaultName: "aws", key: "secret" });
  values.addSecret(quoted, { vaultName: "db", key: "pw" });
  values.addSecret("8080", { vaultName: "net", key: "port" });
  const suffixes = [
    coerceToSuffix(values.withPlaceholdersDeep(slashed)),
    coerceToSuffix(values.withPlaceholdersDeep({
      user: "svc",
      password: slashed,
      note: "x".repeat(40),
    })),
    coerceToSuffix(values.withPlaceholdersDeep({ secret: quoted })),
    coerceToSuffix(values.withPlaceholdersDeep(8080)),
  ];
  for (const suffix of suffixes) {
    assertEquals(suffix.includes("wJalrXUtnFEMI"), false, suffix);
    assertEquals(suffix.includes('pa\\\\"ss'), false, suffix);
    assertEquals(suffix.includes("ss\\\\word"), false, suffix);
    assertEquals(suffix === "8080", false, suffix);
  }
  assertEquals(suffixes[0], "sensitive-aws.secret");
  assertEquals(suffixes[3], "sensitive-net.port");
});

Deno.test("RunSensitiveValues.masked: keeps a key named __proto__ as data", () => {
  const values = new RunSensitiveValues();
  values.addSecret("hunter2-long", { vaultName: "v", key: "k" });
  const input = JSON.parse('{"__proto__": {"pw": "hunter2-long"}, "a": 1}');
  const masked = values.masked(input) as Record<string, unknown>;
  assertEquals(Object.keys(masked), ["__proto__", "a"]);
  assertEquals(
    JSON.stringify(masked),
    '{"__proto__":{"pw":"***"},"a":1}',
  );
});
