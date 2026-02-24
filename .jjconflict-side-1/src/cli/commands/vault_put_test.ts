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

/**
 * Parses a KEY=VALUE string into key and value parts.
 * Handles values that contain = signs.
 */
function parseKeyValue(input: string): { key: string; value: string } | null {
  const equalsIndex = input.indexOf("=");
  if (equalsIndex === -1) {
    return null;
  }

  const key = input.substring(0, equalsIndex);
  const value = input.substring(equalsIndex + 1);

  if (key.length === 0) {
    return null;
  }

  return { key, value };
}

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
