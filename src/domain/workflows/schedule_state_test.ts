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
  advanceScheduleState,
  type MissedFire,
  ScheduleStateSchema,
} from "./schedule_state.ts";
import { createWorkflowId } from "./workflow_id.ts";

const ID = createWorkflowId(crypto.randomUUID());
const EARLY = new Date("2026-11-01T09:00:00.000Z");
const LATE = new Date("2026-11-01T10:00:00.000Z");

function missed(extra: Partial<MissedFire> = {}): MissedFire {
  return {
    fireTime: "2026-11-01T09:00:00.000Z",
    count: 1,
    reason: "serve_down",
    caughtUp: false,
    detectedAt: "2026-11-01T10:00:01.000Z",
    ...extra,
  };
}

Deno.test("advanceScheduleState: from no state seeds the watermark at the fire time", () => {
  assertEquals(advanceScheduleState(null, ID, "nightly", EARLY), {
    workflowId: ID,
    workflowName: "nightly",
    lastEvaluatedFireTime: EARLY.toISOString(),
  });
});

Deno.test("advanceScheduleState: a later fire moves the watermark forward", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY);
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE).lastEvaluatedFireTime,
    LATE.toISOString(),
  );
});

Deno.test("advanceScheduleState: an older fire never moves the watermark back", () => {
  const current = advanceScheduleState(null, ID, "nightly", LATE);
  const next = advanceScheduleState(current, ID, "renamed", EARLY);
  assertEquals(next.lastEvaluatedFireTime, LATE.toISOString());
  assertEquals(next.workflowName, "renamed");
});

Deno.test("advanceScheduleState: keeps the recorded missed fire when none is given", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, missed());
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE).lastMissed,
    missed(),
  );
});

Deno.test("advanceScheduleState: a new missed fire replaces the recorded one", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, missed());
  const replacement = missed({ count: 3, caughtUp: true });
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE, replacement).lastMissed,
    replacement,
  );
});

Deno.test("ScheduleStateSchema: accepts an advanced state", () => {
  const state = advanceScheduleState(null, ID, "nightly", EARLY, missed());
  assertEquals(ScheduleStateSchema.parse(state), state);
});

Deno.test("ScheduleStateSchema: refuses an unknown missed reason", () => {
  const state = advanceScheduleState(null, ID, "nightly", EARLY);
  assertEquals(
    ScheduleStateSchema.safeParse({
      ...state,
      lastMissed: { ...missed(), reason: "gremlins" },
    }).success,
    false,
  );
});

Deno.test("ScheduleStateSchema: refuses a watermark that is not a timestamp", () => {
  assertEquals(
    ScheduleStateSchema.safeParse({
      workflowId: ID,
      workflowName: "nightly",
      lastEvaluatedFireTime: "yesterday",
    }).success,
    false,
  );
});
