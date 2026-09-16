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
import {
  AUTH_ENFORCEMENT_DEADLINE,
  AUTH_WARNING_MESSAGE,
  isFirstRunNudge,
} from "./auth_nudge.ts";

Deno.test("AUTH_WARNING_MESSAGE: includes enforcement deadline", () => {
  assertStringIncludes(AUTH_WARNING_MESSAGE, AUTH_ENFORCEMENT_DEADLINE);
});

Deno.test("AUTH_WARNING_MESSAGE: includes swamp auth login", () => {
  assertStringIncludes(AUTH_WARNING_MESSAGE, "swamp auth login");
});

Deno.test("isFirstRunNudge: returns true when firstRunShown is undefined", () => {
  assertEquals(isFirstRunNudge({}), true);
});

Deno.test("isFirstRunNudge: returns true when firstRunShown is false and no lastShown", () => {
  assertEquals(isFirstRunNudge({ firstRunShown: false }), true);
});

Deno.test("isFirstRunNudge: returns false when firstRunShown is true", () => {
  assertEquals(isFirstRunNudge({ firstRunShown: true }), false);
});

Deno.test("isFirstRunNudge: returns false for existing user missing firstRunShown field", () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assertEquals(isFirstRunNudge({ lastShown: oneHourAgo }), false);
});
