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

import { assert } from "@std/assert";
import fc from "fast-check";
import { Cron } from "croner";
import { nextSlotAfter } from "./cron_slots.ts";
import {
  arbZoneAndWatermark,
  FakeSchedulerClock,
  HOUR_MS,
} from "./schedule_dst_test_helpers.ts";
import { WorkflowScheduler } from "./workflow_scheduler.ts";
import type { WorkflowId } from "./workflow_id.ts";

const WORKFLOW_ID = "cccccccc-3333-3333-3333-333333333333" as WorkflowId;

// windows stay short so the fake clock runs few timers per property run
const arbScheduleAndWindow = fc.oneof(
  fc.record({
    expression: fc.constantFrom(
      "*/15 * * * *",
      "0 * * * *",
      "30 1 * * *",
      "0 9 1 * *",
    ),
    windowMs: fc.integer({ min: 1, max: 6 * HOUR_MS }),
  }),
  fc.record({
    expression: fc.constant("*/5 * * * * *"),
    windowMs: fc.integer({ min: 1, max: 2 * 60 * 1000 }),
  }),
);

Deno.test("WorkflowScheduler: across DST transitions fire times strictly increase, never precede their fire, and never outnumber the slots", () => {
  fc.assert(
    fc.property(
      arbScheduleAndWindow,
      arbZoneAndWatermark,
      ({ expression, windowMs }, { timezone, watermarkMs: startMs }) => {
        const clock = new FakeSchedulerClock(startMs);
        const scheduler = new WorkflowScheduler({ timezone, clock });
        const fires: { at: number; fireTime: number }[] = [];
        scheduler.register(WORKFLOW_ID, expression);
        scheduler.start((_id, fireTime) => {
          fires.push({ at: clock.now(), fireTime: fireTime.getTime() });
        });
        const endMs = startMs + windowMs;
        clock.advanceTo(endMs);
        scheduler.stop();

        for (let i = 1; i < fires.length; i++) {
          assert(fires[i].fireTime > fires[i - 1].fireTime);
        }
        for (const fire of fires) {
          assert(fire.at >= fire.fireTime);
          assert(fire.fireTime > startMs);
        }

        const cron = new Cron(expression, { timezone });
        let slots = 0;
        let cursor = new Date(startMs);
        for (;;) {
          const next = nextSlotAfter(cron, cursor);
          if (!next || next.getTime() > endMs) break;
          slots++;
          cursor = next;
        }
        assert(fires.length <= slots);
      },
    ),
    { numRuns: 100 },
  );
});
