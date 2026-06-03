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
import {
  DEFAULT_UPDATE_PREFERENCES,
  isValidCadence,
} from "./update_preferences.ts";

Deno.test("isValidCadence: accepts daily", () => {
  assertEquals(isValidCadence("daily"), true);
});

Deno.test("isValidCadence: accepts weekly", () => {
  assertEquals(isValidCadence("weekly"), true);
});

Deno.test("isValidCadence: rejects invalid values", () => {
  assertEquals(isValidCadence("hourly"), false);
  assertEquals(isValidCadence(""), false);
  assertEquals(isValidCadence("monthly"), false);
});

Deno.test("DEFAULT_UPDATE_PREFERENCES: has safe defaults", () => {
  assertEquals(DEFAULT_UPDATE_PREFERENCES.enabled, false);
  assertEquals(DEFAULT_UPDATE_PREFERENCES.cadence, "daily");
});
