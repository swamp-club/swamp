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
import fc from "fast-check";
import { MISSED_FIRE_COUNT_CAP } from "./schedule_catch_up.ts";
import {
  advanceScheduleState,
  MISSED_FIRE_REASONS,
  type MissedFire,
  type ScheduleState,
} from "./schedule_state.ts";
import { createWorkflowId } from "./workflow_id.ts";

const BASE = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

const arbStep = fc.record({
  slot: fc.integer({ min: 0, max: 200 }),
  lost: fc.option(
    fc.record({
      reason: fc.constantFrom(...MISSED_FIRE_REASONS),
      count: fc.integer({ min: 1, max: MISSED_FIRE_COUNT_CAP }),
      caughtUp: fc.boolean(),
    }),
    { nil: undefined },
  ),
  fired: fc.boolean(),
  expression: fc.constantFrom("* * * * *", "*/5 * * * *"),
});

Deno.test("advanceScheduleState: the watermark never moves back, a lost fire's count stays within the cap, and a fired later slot leaves no older miss", () => {
  const id = createWorkflowId(crypto.randomUUID());
  fc.assert(
    fc.property(fc.array(arbStep, { maxLength: 30 }), (steps) => {
      let state: ScheduleState | null = null;
      for (const step of steps) {
        const fireTime = new Date(BASE + step.slot * MINUTE);
        const lastMissed: MissedFire | undefined = step.lost && {
          ...step.lost,
          fireTime: fireTime.toISOString(),
          detectedAt: fireTime.toISOString(),
        };
        const before: ScheduleState | null = state;
        state = advanceScheduleState(before, id, "wf", fireTime, {
          lastMissed,
          cronExpression: step.expression,
          fired: step.fired,
        });

        if (before) {
          assert(
            Date.parse(state.lastEvaluatedFireTime) >=
              Date.parse(before.lastEvaluatedFireTime),
          );
        }
        const kept = state.lastMissed;
        if (!kept) continue;
        assert(kept.count >= 1 && kept.count <= MISSED_FIRE_COUNT_CAP);
        if (step.fired && !lastMissed) {
          assert(Date.parse(kept.fireTime) >= fireTime.getTime());
        }
        if (
          before?.lastMissed && kept !== before.lastMissed &&
          before.cronExpression === step.expression &&
          kept.reason === before.lastMissed.reason && !kept.caughtUp &&
          !before.lastMissed.caughtUp &&
          Date.parse(kept.fireTime) > Date.parse(before.lastMissed.fireTime) &&
          !(step.fired && lastMissed)
        ) {
          assertEquals(
            kept.count,
            Math.min(
              before.lastMissed.count + (lastMissed?.count ?? 0),
              MISSED_FIRE_COUNT_CAP,
            ),
          );
        }
      }
    }),
    { numRuns: 200 },
  );
});
