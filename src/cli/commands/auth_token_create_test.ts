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
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { authTokenCreateCommand, parseTokenTtl } from "./auth_token_create.ts";

await initializeLogging({});

Deno.test("parseTokenTtl: accepts each unit", () => {
  assertEquals(parseTokenTtl("30m"), 30 * 60 * 1000);
  assertEquals(parseTokenTtl("12h"), 12 * 60 * 60 * 1000);
  assertEquals(parseTokenTtl("30d"), 30 * 24 * 60 * 60 * 1000);
  assertEquals(parseTokenTtl("1w"), 7 * 24 * 60 * 60 * 1000);
  assertEquals(parseTokenTtl("1mo"), 30 * 24 * 60 * 60 * 1000);
  assertEquals(parseTokenTtl("1y"), 365 * 24 * 60 * 60 * 1000);
});

Deno.test("parseTokenTtl: refuses zero, bare numbers, seconds and unknown units", () => {
  for (const value of ["0d", "30", "30s", "1x", "", "-1d", "1.5d"]) {
    const err = assertThrows(() => parseTokenTtl(value), UserError);
    assertEquals(
      err.message,
      `Invalid --ttl value "${value}": expected a duration like 30m, 12h, 30d or 1w`,
    );
  }
});

Deno.test("authTokenCreateCommand has --ttl option", () => {
  const ttl = authTokenCreateCommand.getOptions().find((o) =>
    o.flags.includes("--ttl")
  );
  assertEquals(ttl !== undefined, true);
});
