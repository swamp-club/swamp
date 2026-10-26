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
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretRedactor } from "./secret_redactor.ts";

Deno.test("SecretRedactor", async (t) => {
  await t.step("basic redaction replaces secret with ***", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("my-secret-value");
    assertEquals(
      redactor.redact("the password is my-secret-value here"),
      "the password is *** here",
    );
  });

  await t.step("secrets shorter than 3 chars are ignored", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("ab");
    redactor.addSecret("");
    redactor.addSecret("x");
    assertEquals(redactor.hasSecrets, false);
    assertEquals(redactor.redact("ab x test"), "ab x test");
  });

  await t.step("multiple secrets are all redacted", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("secret1");
    redactor.addSecret("secret2");
    assertEquals(
      redactor.redact("secret1 and secret2 in text"),
      "*** and *** in text",
    );
  });

  await t.step("longer secrets are replaced before shorter substrings", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("abc");
    redactor.addSecret("abcdef");
    assertEquals(
      redactor.redact("value is abcdef here"),
      "value is *** here",
    );
  });

  await t.step("JSON-escaped variants are redacted", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret('value with "quotes" inside');
    // The JSON-escaped version should also be redacted
    assertEquals(
      redactor.redact('data: value with \\"quotes\\" inside end'),
      "data: *** end",
    );
  });

  await t.step(
    "redact returns text unchanged when no secrets registered",
    () => {
      const redactor = new SecretRedactor();
      assertEquals(
        redactor.redact("nothing to redact here"),
        "nothing to redact here",
      );
    },
  );

  await t.step("hasSecrets property reflects state", () => {
    const redactor = new SecretRedactor();
    assertEquals(redactor.hasSecrets, false);
    redactor.addSecret("my-secret");
    assertEquals(redactor.hasSecrets, true);
  });

  await t.step("redacts multiple occurrences of the same secret", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("token123");
    assertEquals(
      redactor.redact("token123 then token123 again"),
      "*** then *** again",
    );
  });

  await t.step("a CRLF secret is redacted in its LF-normalised form", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("line-one\r\nline-two");
    assertEquals(
      redactor.redact("key: line-one\nline-two end"),
      "key: *** end",
    );
  });

  await t.step("a CRLF secret is still redacted in its original form", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("line-one\r\nline-two");
    assertEquals(
      redactor.redact("key: line-one\r\nline-two end"),
      "key: *** end",
    );
  });

  await t.step("a secret ending in CR is redacted once the CR is gone", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("token123\r");
    assertEquals(redactor.redact("token123\nnext"), "***\nnext");
  });

  await t.step("the JSON-escaped LF-normalised form is redacted", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("line-one\r\nline-two");
    assertEquals(
      redactor.redact('{"v":"line-one\\nline-two"}'),
      '{"v":"***"}',
    );
  });

  await t.step("a CR not before an LF or the end is kept in the form", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("abc\rdef");
    assertEquals(redactor.redact("abcdef"), "abcdef");
    assertEquals(redactor.redact("abc\rdef"), "***");
  });

  await t.step("a normalised form under 3 chars is not registered", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("ab\r");
    assertEquals(redactor.redact("ab ab\r"), "ab ***");
  });
});

Deno.test("SecretRedactor.maskSentinelsOf: masks every sentinel the run issued before any value is registered, and hasSecrets says so", () => {
  const registry = new SecretBagRegistry();
  const redactor = new SecretRedactor();
  redactor.maskSentinelsOf(registry);
  // An empty registry masks nothing yet.
  assertEquals(redactor.hasSecrets, false);
  const bag = new VaultSecretBag(registry);
  const vault = bag.addSecret({ vaultName: "v", key: "k" }, "loc");
  const data = bag.addDataReference({ vaultName: "v", key: "j" }, "db/main.p");
  assertEquals(redactor.hasSecrets, true);
  const other = `__SWAMP_VSEC_${"ab".repeat(16)}_0__`;
  assertEquals(
    redactor.redact(`a ${vault} b ${data} c ${other}`),
    `a *** b *** c ${other}`,
  );
  // Values and sentinels are masked together.
  redactor.addSecret("hunter2-long");
  assertEquals(redactor.redact(`${vault}=hunter2-long`), "***=***");
  assertEquals(redactor.redact("nothing here"), "nothing here");
});

Deno.test("SecretRedactor: without an attached registry a sentinel is text", () => {
  const registry = new SecretBagRegistry();
  const sentinel = new VaultSecretBag(registry).addSecret(
    { vaultName: "v", key: "k" },
    "loc",
  );
  const redactor = new SecretRedactor();
  assertEquals(redactor.hasSecrets, false);
  assertEquals(redactor.redact(`x ${sentinel}`), `x ${sentinel}`);
});

Deno.test("SecretRedactor.isSecret: answers for a registered value matched whole, never for a substring, a superstring or a value too short to register (swamp-club#3754)", () => {
  const redactor = new SecretRedactor();
  redactor.addSecret("73816542");
  redactor.addSecret("ab");
  assertEquals(redactor.isSecret("73816542"), true);
  assertEquals(redactor.isSecret("7381654"), false);
  assertEquals(redactor.isSecret("738165421"), false);
  assertEquals(redactor.isSecret("ab"), false);
  assertEquals(redactor.isSecret(""), false);
});
