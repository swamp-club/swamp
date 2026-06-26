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
import { isAuthenticated, setAuthenticated } from "./auth_context.ts";

Deno.test("auth_context: defaults to not authenticated", () => {
  setAuthenticated(false);
  assertEquals(isAuthenticated(), false);
});

Deno.test("auth_context: setAuthenticated true makes isAuthenticated return true", () => {
  setAuthenticated(true);
  assertEquals(isAuthenticated(), true);
  setAuthenticated(false);
});

Deno.test("auth_context: setAuthenticated false makes isAuthenticated return false", () => {
  setAuthenticated(true);
  setAuthenticated(false);
  assertEquals(isAuthenticated(), false);
});
