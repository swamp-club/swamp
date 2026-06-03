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
import { parseKeyValue, resolveKeyValue } from "./vault_put.ts";

Deno.test("parseKeyValue - simple key=value", () => {
  const result = parseKeyValue("API_KEY=secret123");
  assertEquals(result, { key: "API_KEY", value: "secret123" });
});

Deno.test("parseKeyValue - value containing equals sign", () => {
  const result = parseKeyValue("TOKEN=abc=def=ghi");
  assertEquals(result, { key: "TOKEN", value: "abc=def=ghi" });
});

Deno.test("parseKeyValue - empty value", () => {
  const result = parseKeyValue("EMPTY=");
  assertEquals(result, { key: "EMPTY", value: "" });
});

Deno.test("parseKeyValue - value with special characters", () => {
  const result = parseKeyValue("SECRET=p@ssw0rd!#$%");
  assertEquals(result, { key: "SECRET", value: "p@ssw0rd!#$%" });
});

Deno.test("parseKeyValue - no equals sign returns null", () => {
  const result = parseKeyValue("invalid");
  assertEquals(result, null);
});

Deno.test("parseKeyValue - empty key returns null", () => {
  const result = parseKeyValue("=value");
  assertEquals(result, null);
});

Deno.test("parseKeyValue - key with dashes", () => {
  const result = parseKeyValue("my-api-key=secret");
  assertEquals(result, { key: "my-api-key", value: "secret" });
});

Deno.test("parseKeyValue - key with underscores", () => {
  const result = parseKeyValue("MY_API_KEY=secret");
  assertEquals(result, { key: "MY_API_KEY", value: "secret" });
});

// resolveKeyValue tests

Deno.test("resolveKeyValue - KEY=VALUE inline takes precedence over stdin", () => {
  const result = resolveKeyValue("API_KEY=inline-secret", "stdin-secret\n");
  assertEquals(result, { key: "API_KEY", value: "inline-secret" });
});

Deno.test("resolveKeyValue - KEY=VALUE works without stdin", () => {
  const result = resolveKeyValue("API_KEY=secret123", null);
  assertEquals(result, { key: "API_KEY", value: "secret123" });
});

Deno.test("resolveKeyValue - KEY with stdin value", () => {
  const result = resolveKeyValue("API_KEY", "piped-secret");
  assertEquals(result, { key: "API_KEY", value: "piped-secret" });
});

Deno.test("resolveKeyValue - strips trailing newline from stdin", () => {
  const result = resolveKeyValue("API_KEY", "piped-secret\n");
  assertEquals(result, { key: "API_KEY", value: "piped-secret" });
});

Deno.test("resolveKeyValue - preserves multiline content exactly (PEM keys, certificates)", () => {
  const result = resolveKeyValue("API_KEY", "line1\nline2\n");
  assertEquals(result, { key: "API_KEY", value: "line1\nline2\n" });
});

Deno.test("resolveKeyValue - preserves value with no trailing newline", () => {
  const result = resolveKeyValue("API_KEY", "exact-value");
  assertEquals(result, { key: "API_KEY", value: "exact-value" });
});

Deno.test("resolveKeyValue - preserves PEM key with trailing newline", () => {
  const pem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n";
  const result = resolveKeyValue("SSH_KEY", pem);
  assertEquals(result, { key: "SSH_KEY", value: pem });
});

Deno.test("resolveKeyValue - error when no = and no stdin", () => {
  const result = resolveKeyValue("API_KEY", null);
  assertEquals("error" in result, true);
});

Deno.test("resolveKeyValue - error message includes all usage formats", () => {
  const result = resolveKeyValue("MY_KEY", null);
  assertEquals("error" in result, true);
  if ("error" in result) {
    assertEquals(result.error.includes("MY_KEY <value>"), true);
    assertEquals(result.error.includes("MY_KEY=<value>"), true);
    assertEquals(result.error.includes("echo"), true);
  }
});
