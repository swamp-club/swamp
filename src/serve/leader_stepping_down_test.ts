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
import { LeaderSteppingDown } from "./leader_stepping_down.ts";

Deno.test("LeaderSteppingDown.begin: tells each listener once, however often it is called", () => {
  const steppingDown = new LeaderSteppingDown();
  let told = 0;
  steppingDown.onBegin(() => told++);
  assertEquals(steppingDown.down, false);
  steppingDown.begin();
  steppingDown.begin();
  assertEquals(steppingDown.down, true);
  assertEquals(told, 1);
});

Deno.test("LeaderSteppingDown.onBegin: a removed listener is not told", () => {
  const steppingDown = new LeaderSteppingDown();
  let told = 0;
  const off = steppingDown.onBegin(() => told++);
  off();
  steppingDown.begin();
  assertEquals(told, 0);
});
