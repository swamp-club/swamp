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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import {
  parseKeyValue,
  resolveKeyValue,
  resolveRemoteKeyValue,
  skipsOverwriteConfirmation,
  vaultPutCommand,
} from "./vault_put.ts";

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

Deno.test("vaultPutCommand: exposes the write-secret alias", () => {
  assertEquals(vaultPutCommand.getAliases().includes("write-secret"), true);
});

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

Deno.test("skipsOverwriteConfirmation: --yes alone skips confirmation", () => {
  assertEquals(skipsOverwriteConfirmation({ yes: true }), true);
});

Deno.test("skipsOverwriteConfirmation: --force alone skips confirmation", () => {
  assertEquals(skipsOverwriteConfirmation({ force: true }), true);
});

Deno.test("skipsOverwriteConfirmation: --yes with --force skips confirmation", () => {
  assertEquals(skipsOverwriteConfirmation({ yes: true, force: true }), true);
});

Deno.test("skipsOverwriteConfirmation: neither flag requires confirmation", () => {
  assertEquals(skipsOverwriteConfirmation({}), false);
  assertEquals(
    skipsOverwriteConfirmation({ yes: undefined, force: undefined }),
    false,
  );
  assertEquals(skipsOverwriteConfirmation({ yes: false, force: false }), false);
});

function countingReader(content: string | null) {
  const reader = {
    calls: 0,
    read: (): Promise<string | null> => {
      reader.calls++;
      return Promise.resolve(content);
    },
  };
  return reader;
}

Deno.test("resolveRemoteKeyValue: reads a piped value and strips its trailing newline", async () => {
  const reader = countingReader("piped-secret\n");
  const result = await resolveRemoteKeyValue(
    "API_KEY",
    undefined,
    false,
    reader.read,
  );
  assertEquals(result, { key: "API_KEY", value: "piped-secret" });
  assertEquals(reader.calls, 1);
});

Deno.test("resolveRemoteKeyValue: preserves a piped multiline PEM value exactly", async () => {
  const pem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n";
  const result = await resolveRemoteKeyValue(
    "SSH_KEY",
    undefined,
    false,
    countingReader(pem).read,
  );
  assertEquals(result, { key: "SSH_KEY", value: pem });
});

Deno.test("resolveRemoteKeyValue: a value argument wins and stdin is not read", async () => {
  const reader = countingReader("stdin-secret");
  const result = await resolveRemoteKeyValue(
    "API_KEY",
    "arg-secret",
    false,
    reader.read,
  );
  assertEquals(result, { key: "API_KEY", value: "arg-secret" });
  assertEquals(reader.calls, 0);
});

Deno.test("resolveRemoteKeyValue: KEY=VALUE wins and stdin is not read", async () => {
  const reader = countingReader("stdin-secret");
  const result = await resolveRemoteKeyValue(
    "API_KEY=inline-secret",
    undefined,
    false,
    reader.read,
  );
  assertEquals(result, { key: "API_KEY", value: "inline-secret" });
  assertEquals(reader.calls, 0);
});

Deno.test("resolveRemoteKeyValue: a TTY with no value errors without reading or prompting", async () => {
  const reader = countingReader("unused");
  const error = await assertRejects(
    () => resolveRemoteKeyValue("API_KEY", undefined, true, reader.read),
    UserError,
  );
  assertStringIncludes(
    error.message,
    'echo "<value>" | swamp vault put <vault> API_KEY --server <url>',
  );
  assertStringIncludes(
    error.message,
    "swamp vault put <vault> API_KEY <value> --server <url>",
  );
  assertStringIncludes(
    error.message,
    "swamp vault put <vault> API_KEY=<value> --server <url>",
  );
  assertStringIncludes(
    error.message,
    "Interactive prompts are not available with --server",
  );
  assertEquals(reader.calls, 0);
});

Deno.test("resolveRemoteKeyValue: empty stdin errors with remote usage and no prompt note", async () => {
  const error = await assertRejects(
    () =>
      resolveRemoteKeyValue(
        "API_KEY",
        undefined,
        false,
        countingReader(null).read,
      ),
    UserError,
  );
  assertStringIncludes(error.message, "No value given for API_KEY");
  assertStringIncludes(error.message, "--server <url>");
  assertEquals(error.message.includes("Interactive prompts"), false);
});

Deno.test("resolveRemoteKeyValue: an empty key errors without reading stdin", async () => {
  const reader = countingReader("secret");
  await assertRejects(
    () => resolveRemoteKeyValue("", undefined, false, reader.read),
    UserError,
    "Key cannot be empty",
  );
  assertEquals(reader.calls, 0);
});

Deno.test("vaultPutCommand: help advertises piping the value with --server", () => {
  const description = vaultPutCommand.getDescription();
  assertStringIncludes(description, "With --server, pipe the value on stdin");
  assertEquals(
    description.includes(
      "stdin and interactive prompts are not available remotely",
    ),
    false,
  );
});
