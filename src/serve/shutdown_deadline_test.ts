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
  SHUTDOWN_AFTER_DRAIN_BUDGET_MS,
  SHUTDOWN_STAGE_FLOOR_MS,
  ShutdownDeadline,
} from "./shutdown_deadline.ts";

Deno.test("ShutdownDeadline.forShutdown: ends the budget after the drain timeout", () => {
  const deadline = ShutdownDeadline.forShutdown(1_000, 30_000, {
    now: () => 1_000,
  });
  assertEquals(deadline.at, 1_000 + 30_000 + SHUTDOWN_AFTER_DRAIN_BUDGET_MS);
  assertEquals(deadline.remaining(), 30_000 + SHUTDOWN_AFTER_DRAIN_BUDGET_MS);
});

Deno.test("ShutdownDeadline.forShutdown: a zero or negative drain adds nothing", () => {
  const deadline = ShutdownDeadline.forShutdown(0, -5, {
    now: () => 0,
    budgetMs: 10_000,
  });
  assertEquals(deadline.at, 10_000);
});

Deno.test("ShutdownDeadline.remaining: is capped at the stage's own bound", () => {
  let now = 0;
  const deadline = ShutdownDeadline.forShutdown(0, 0, {
    now: () => now,
    budgetMs: 20_000,
  });
  assertEquals(deadline.remaining(5_000), 5_000);
  now = 17_000;
  assertEquals(deadline.remaining(5_000), 3_000);
  assertEquals(deadline.remaining(), 3_000);
});

Deno.test("ShutdownDeadline.remaining: never goes below the floor once spent", () => {
  let now = 0;
  const deadline = ShutdownDeadline.forShutdown(0, 0, {
    now: () => now,
    budgetMs: 1_000,
  });
  now = 1_000;
  assertEquals(deadline.remaining(), SHUTDOWN_STAGE_FLOOR_MS);
  now = 60_000;
  assertEquals(deadline.remaining(5_000), SHUTDOWN_STAGE_FLOOR_MS);
  // A cap below the floor is raised to it, as every stage gets one attempt.
  now = 0;
  assertEquals(deadline.remaining(100), SHUTDOWN_STAGE_FLOOR_MS);
});
