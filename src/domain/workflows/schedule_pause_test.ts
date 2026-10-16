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

import { assert, assertEquals } from "@std/assert";
import {
  isSchedulePauseActiveAt,
  SCHEDULE_PAUSE_REASON_MAX_LENGTH,
  type SchedulePause,
  SchedulePauseReasonSchema,
  SchedulePauseSchema,
} from "./schedule_pause.ts";

const BASE: SchedulePause = {
  workflowId: crypto.randomUUID(),
  workflowName: "nightly-gc",
  pausedBy: "user:ops",
  pausedAt: "2026-10-16T12:00:00.000Z",
};

Deno.test("SchedulePauseReasonSchema: accepts plain text up to the limit", () => {
  assert(SchedulePauseReasonSchema.safeParse("stalling serve, #3518").success);
  assert(
    SchedulePauseReasonSchema.safeParse(
      "x".repeat(SCHEDULE_PAUSE_REASON_MAX_LENGTH),
    ).success,
  );
});

Deno.test("SchedulePauseReasonSchema: rejects text over the limit", () => {
  assertEquals(
    SchedulePauseReasonSchema.safeParse(
      "x".repeat(SCHEDULE_PAUSE_REASON_MAX_LENGTH + 1),
    ).success,
    false,
  );
});

Deno.test("SchedulePauseReasonSchema: rejects newlines and other control characters", () => {
  for (const reason of ["a\nb", "a\rb", "tab\there", "esc\x1b[31m", "\x7f"]) {
    assertEquals(
      SchedulePauseReasonSchema.safeParse(reason).success,
      false,
      JSON.stringify(reason),
    );
  }
});

Deno.test("SchedulePauseReasonSchema: rejects an empty reason", () => {
  assertEquals(SchedulePauseReasonSchema.safeParse("").success, false);
});

Deno.test("SchedulePauseSchema: accepts a pause with and without until", () => {
  assert(SchedulePauseSchema.safeParse(BASE).success);
  assert(
    SchedulePauseSchema.safeParse({
      ...BASE,
      reason: "incident",
      until: "2026-10-16T14:00:00.000Z",
    }).success,
  );
});

Deno.test("SchedulePauseSchema: rejects a pause without a workflow id or principal", () => {
  assertEquals(
    SchedulePauseSchema.safeParse({ ...BASE, workflowId: "" }).success,
    false,
  );
  assertEquals(
    SchedulePauseSchema.safeParse({ ...BASE, pausedBy: "" }).success,
    false,
  );
});

Deno.test("isSchedulePauseActiveAt: a pause without until is always in force", () => {
  assert(isSchedulePauseActiveAt(BASE, new Date("2099-01-01T00:00:00Z")));
});

Deno.test("isSchedulePauseActiveAt: a pause lapses at its until time", () => {
  const pause = { ...BASE, until: "2026-10-16T14:00:00.000Z" };
  assert(isSchedulePauseActiveAt(pause, new Date("2026-10-16T13:59:59.999Z")));
  assertEquals(
    isSchedulePauseActiveAt(pause, new Date("2026-10-16T14:00:00.000Z")),
    false,
  );
});
