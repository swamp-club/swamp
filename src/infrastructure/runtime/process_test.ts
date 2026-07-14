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
  checkOpenFileLimit,
  getOpenFileSoftLimit,
  isProcessDead,
} from "./process.ts";

Deno.test("isProcessDead: returns false for the current process", () => {
  assertEquals(isProcessDead(Deno.pid), false);
});

Deno.test("isProcessDead: returns true for a non-existent PID", () => {
  // PID 2147483647 is the max 32-bit signed int — extremely unlikely to be in use
  assertEquals(isProcessDead(2147483647), true);
});

Deno.test("getOpenFileSoftLimit: returns a positive number or null on POSIX", () => {
  if (Deno.build.os === "windows") return;
  const limit = getOpenFileSoftLimit();
  if (limit === null) return;
  assertEquals(typeof limit, "number");
  assertEquals(limit > 0, true);
});

Deno.test("checkOpenFileLimit: returns null when limit is sufficient", () => {
  if (Deno.build.os === "windows") return;
  const limit = getOpenFileSoftLimit();
  if (limit === null || limit < 8192) return;
  assertEquals(checkOpenFileLimit(), null);
});
