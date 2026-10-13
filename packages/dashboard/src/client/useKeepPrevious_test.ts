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
import { holdLatest } from "./useKeepPrevious.ts";

Deno.test("holdLatest: holds the last value through a gap", () => {
  const held = holdLatest(null, 1, "24h");
  assertEquals(holdLatest(held, null, "24h"), { key: "24h", value: 1 });
  assertEquals(holdLatest(held, 2, "24h"), { key: "24h", value: 2 });
});

Deno.test("holdLatest: a new key drops the previous value", () => {
  const held = holdLatest(null, 1, "24h");
  assertEquals(holdLatest(held, null, "7d"), null);
  assertEquals(holdLatest(held, 3, "7d"), { key: "7d", value: 3 });
});

Deno.test("holdLatest: reset drops the value", () => {
  const held = holdLatest(null, 1, "");
  assertEquals(holdLatest(held, 2, "", true), null);
});
