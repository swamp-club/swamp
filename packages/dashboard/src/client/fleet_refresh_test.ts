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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  activeDispatchIds,
  chunk,
  clampTtlMinutes,
  formatTtl,
  TTL_MAX_MINUTES,
  workerSignature,
} from "./fleet_refresh.ts";

Deno.test("workerSignature: ignores order, changes on status or dispatch changes", () => {
  const a = { name: "a", status: "idle", activeDispatchIds: [] };
  const b = { name: "b", status: "busy", activeDispatchIds: ["d2", "d1"] };
  assertEquals(workerSignature([a, b]), workerSignature([b, a]));
  assertEquals(
    workerSignature([{ ...b, activeDispatchIds: ["d1", "d2"] }]),
    workerSignature([b]),
  );
  assertNotEquals(
    workerSignature([a, b]),
    workerSignature([a, { ...b, status: "draining" }]),
  );
  assertNotEquals(
    workerSignature([a, b]),
    workerSignature([a, { ...b, activeDispatchIds: ["d1"] }]),
  );
  assertEquals(workerSignature(undefined), "");
});

Deno.test("clampTtlMinutes: steps by 30 minutes between 30m and 24h", () => {
  assertEquals(clampTtlMinutes(0), 30);
  assertEquals(clampTtlMinutes(100), 90);
  assertEquals(clampTtlMinutes(100_000), TTL_MAX_MINUTES);
  assertEquals(clampTtlMinutes(Number.NaN), 120);
});

Deno.test("formatTtl: hours and minutes", () => {
  assertEquals(formatTtl(30), "30m");
  assertEquals(formatTtl(120), "2h");
  assertEquals(formatTtl(90), "1h 30m");
});

Deno.test("chunk: splits into runs no longer than the batch size", () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 2), []);
});

Deno.test("activeDispatchIds: unique and sorted, so the request payload is stable", () => {
  assertEquals(
    activeDispatchIds([
      { activeDispatchIds: ["b", "a"] },
      { activeDispatchIds: ["a", "c"] },
    ]),
    ["a", "b", "c"],
  );
});
