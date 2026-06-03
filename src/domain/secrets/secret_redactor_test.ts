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
});
