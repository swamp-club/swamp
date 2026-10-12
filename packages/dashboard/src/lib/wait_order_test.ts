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
import { formatWait, oldestFirst } from "./wait_order.ts";

Deno.test("oldestFirst: longest wait first, untimed items last in order", () => {
  const items = [
    { id: "b", at: "2026-10-12T10:00:00Z" },
    { id: "x", at: undefined },
    { id: "a", at: "2026-10-11T10:00:00Z" },
    { id: "y", at: "not a date" },
    { id: "c", at: "2026-10-12T11:00:00Z" },
  ];
  assertEquals(
    oldestFirst(items, (i) => i.at).map((i) => i.id),
    ["a", "b", "c", "x", "y"],
  );
});

Deno.test("oldestFirst: stable for equal times and leaves the input alone", () => {
  const items = [
    { id: "1", at: "2026-10-12T10:00:00Z" },
    { id: "2", at: "2026-10-12T10:00:00Z" },
  ];
  assertEquals(oldestFirst(items, (i) => i.at).map((i) => i.id), ["1", "2"]);
  assertEquals(items[0].id, "1");
});

Deno.test("formatWait: coarse units without seconds", () => {
  assertEquals(formatWait(5_000), "< 1m");
  assertEquals(formatWait(-1), "< 1m");
  assertEquals(formatWait(20 * 60_000 + 59_000), "20m");
  assertEquals(formatWait(3 * 3_600_000 + 5 * 60_000), "3h 05m");
  assertEquals(formatWait(50 * 3_600_000), "2d 2h");
  assertEquals(formatWait(48 * 3_600_000), "2d");
});
