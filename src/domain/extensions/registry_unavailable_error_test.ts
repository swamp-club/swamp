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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { UserError } from "../errors.ts";
import { RegistryUnavailableError } from "./registry_unavailable_error.ts";

Deno.test("RegistryUnavailableError: is a UserError reported under that name", () => {
  const error = new RegistryUnavailableError("Request timed out.");
  assertInstanceOf(error, UserError);
  assertEquals(error.name, "UserError");
  assertEquals(error.message, "Request timed out.");
  assertEquals(error.code, undefined);
});

Deno.test("RegistryUnavailableError: keeps the underlying failure as its cause", () => {
  const cause = new DOMException("Signal timed out.", "TimeoutError");
  const error = new RegistryUnavailableError("Request timed out.", { cause });
  assertEquals(error.cause, cause);
  assertEquals(Object.keys(error).includes("cause"), false);
});

Deno.test("RegistryUnavailableError: has no cause when none is given", () => {
  const error = new RegistryUnavailableError("Request timed out.");
  assertEquals("cause" in error, false);
});
