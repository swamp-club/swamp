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
import { MISSED_FIRE_COUNT_CAP } from "./schedule_catch_up.ts";
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
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed(),
  });
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE).lastMissed,
    missed(),
  );
});

Deno.test("advanceScheduleState: a new missed fire replaces the recorded one", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed(),
  });
  const replacement = missed({ count: 3, caughtUp: true });
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE, {
      lastMissed: replacement,
    }).lastMissed,
    replacement,
  );
});

Deno.test("ScheduleStateSchema: accepts an advanced state", () => {
  const state = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed(),
  });
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

function paused(fireTime: string): MissedFire {
  return missed({ fireTime, reason: "paused", detectedAt: fireTime });
}

Deno.test("advanceScheduleState: a later slot that fires clears the missed fire", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: paused(EARLY.toISOString()),
  });
  const next = advanceScheduleState(current, ID, "nightly", LATE, {
    fired: true,
  });
  assertEquals(next.lastMissed, undefined);
  assertEquals(next.lastEvaluatedFireTime, LATE.toISOString());
});

Deno.test("advanceScheduleState: a write that fires nothing keeps the missed fire", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: paused(EARLY.toISOString()),
  });
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE).lastMissed,
    paused(EARLY.toISOString()),
  );
});

Deno.test("advanceScheduleState: the catch-up fire of the missed slot keeps it, caught up", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed({ count: 4 }),
  });
  const next = advanceScheduleState(current, ID, "nightly", EARLY, {
    lastMissed: missed({ count: 4, caughtUp: true }),
    fired: true,
  });
  assertEquals(next.lastMissed, missed({ count: 4, caughtUp: true }));
});

Deno.test("advanceScheduleState: lost fires in a row for the same reason add up", () => {
  let state = advanceScheduleState(null, ID, "nightly", EARLY);
  for (const hour of ["09", "10", "11"]) {
    const at = `2026-11-01T${hour}:00:00.000Z`;
    state = advanceScheduleState(state, ID, "nightly", new Date(at), {
      lastMissed: paused(at),
    });
  }
  assertEquals(state.lastMissed?.count, 3);
  assertEquals(state.lastMissed?.fireTime, "2026-11-01T11:00:00.000Z");
});

Deno.test("advanceScheduleState: the same slot reported twice counts once", () => {
  const at = EARLY.toISOString();
  const once = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: paused(at),
  });
  const twice = advanceScheduleState(once, ID, "nightly", EARLY, {
    lastMissed: paused(at),
  });
  assertEquals(twice.lastMissed?.count, 1);
});

Deno.test("advanceScheduleState: a lost fire for another reason replaces the count", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: paused(EARLY.toISOString()),
  });
  const overlap = missed({
    fireTime: LATE.toISOString(),
    reason: "overlap",
  });
  assertEquals(
    advanceScheduleState(current, ID, "nightly", LATE, { lastMissed: overlap })
      .lastMissed,
    overlap,
  );
});

Deno.test("advanceScheduleState: an older lost fire never replaces a newer one", () => {
  const current = advanceScheduleState(null, ID, "nightly", LATE, {
    lastMissed: paused(LATE.toISOString()),
  });
  assertEquals(
    advanceScheduleState(current, ID, "nightly", EARLY, {
      lastMissed: paused(EARLY.toISOString()),
    }).lastMissed,
    paused(LATE.toISOString()),
  );
});

Deno.test("advanceScheduleState: adding up stops at the cap and marks the count saturated", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed({ count: MISSED_FIRE_COUNT_CAP - 1 }),
  });
  const next = advanceScheduleState(current, ID, "nightly", LATE, {
    lastMissed: missed({ fireTime: LATE.toISOString(), count: 5 }),
  });
  assertEquals(next.lastMissed?.count, MISSED_FIRE_COUNT_CAP);
  assertEquals(next.lastMissed?.saturated, true);
});

Deno.test("advanceScheduleState: another cron expression drops the missed fire", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed(),
    cronExpression: "0 9 * * *",
  });
  const same = advanceScheduleState(current, ID, "nightly", LATE, {
    cronExpression: "0 9 * * *",
  });
  assertEquals(same.lastMissed, missed());
  const changed = advanceScheduleState(current, ID, "nightly", LATE, {
    cronExpression: "0 10 * * *",
  });
  assertEquals(changed.lastMissed, undefined);
  assertEquals(changed.cronExpression, "0 10 * * *");
});

Deno.test("advanceScheduleState: a sum that lands exactly on the cap is an exact count", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed({ count: MISSED_FIRE_COUNT_CAP - 1 }),
  });
  const next = advanceScheduleState(current, ID, "nightly", LATE, {
    lastMissed: missed({ fireTime: LATE.toISOString(), count: 1 }),
  });
  assertEquals(next.lastMissed?.count, MISSED_FIRE_COUNT_CAP);
  assertEquals(next.lastMissed?.saturated, undefined);
});

Deno.test("advanceScheduleState: a slot caught up is not reported missed again by a later write for the same slot", () => {
  const caughtUp = missed({ count: 2, caughtUp: true });
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: caughtUp,
    fired: true,
  });
  const next = advanceScheduleState(current, ID, "nightly", EARLY, {
    lastMissed: missed({ count: 2, detectedAt: "2026-11-01T10:00:02.000Z" }),
  });
  assertEquals(next.lastMissed, caughtUp);
});

Deno.test("advanceScheduleState: a slot reported missed is replaced when its catch-up lands later", () => {
  const current = advanceScheduleState(null, ID, "nightly", EARLY, {
    lastMissed: missed({ count: 2 }),
  });
  const caughtUp = missed({ count: 2, caughtUp: true });
  const next = advanceScheduleState(current, ID, "nightly", EARLY, {
    lastMissed: caughtUp,
    fired: true,
  });
  assertEquals(next.lastMissed, caughtUp);
});
