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

import { assertEquals, assertThrows } from "@std/assert";
import { createEphemeralStore, parseByteSize } from "./ephemeral_store.ts";

Deno.test("parseByteSize: parses plain bytes", () => {
  assertEquals(parseByteSize("1024"), 1024);
  assertEquals(parseByteSize("0"), 0);
  assertEquals(parseByteSize("100b"), 100);
});

Deno.test("parseByteSize: parses kilobytes", () => {
  assertEquals(parseByteSize("1k"), 1024);
  assertEquals(parseByteSize("1kb"), 1024);
  assertEquals(parseByteSize("1KB"), 1024);
  assertEquals(parseByteSize("2K"), 2048);
});

Deno.test("parseByteSize: parses megabytes", () => {
  assertEquals(parseByteSize("1m"), 1024 * 1024);
  assertEquals(parseByteSize("1mb"), 1024 * 1024);
  assertEquals(parseByteSize("512M"), 512 * 1024 * 1024);
  assertEquals(parseByteSize("1MB"), 1024 * 1024);
});

Deno.test("parseByteSize: parses gigabytes", () => {
  assertEquals(parseByteSize("1g"), 1024 * 1024 * 1024);
  assertEquals(parseByteSize("1gb"), 1024 * 1024 * 1024);
  assertEquals(parseByteSize("2G"), 2 * 1024 * 1024 * 1024);
});

Deno.test("parseByteSize: handles fractional values", () => {
  assertEquals(parseByteSize("0.5g"), Math.floor(0.5 * 1024 * 1024 * 1024));
  assertEquals(parseByteSize("1.5m"), Math.floor(1.5 * 1024 * 1024));
});

Deno.test("parseByteSize: trims whitespace", () => {
  assertEquals(parseByteSize("  512m  "), 512 * 1024 * 1024);
});

Deno.test("parseByteSize: returns undefined for invalid input", () => {
  assertEquals(parseByteSize(""), undefined);
  assertEquals(parseByteSize("abc"), undefined);
  assertEquals(parseByteSize("-1m"), undefined);
  assertEquals(parseByteSize("1t"), undefined);
});

Deno.test("createEphemeralStore: dispose closes the catalog SQLite database", () => {
  const store = createEphemeralStore();
  store.dispose();

  assertThrows(
    () => store.catalog.markPopulated(),
    Error,
  );
});
