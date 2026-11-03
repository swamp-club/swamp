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
import { Cron } from "croner";
import { parseDataDuration } from "../data/duration.ts";
import {
  evaluateMissedFires,
  MISSED_FIRE_COUNT_CAP,
  missedAroundRecordedSlot,
  type ScheduleCatchUp,
} from "./schedule_catch_up.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const arbExpression = fc.constantFrom(
  "*/15 * * * *",
  "0 * * * *",
  "0 9 1 * *",
  "30 2 * * 1",
  "*/5 * * * * *",
);

const arbCatchUp: fc.Arbitrary<ScheduleCatchUp | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant({ policy: "none" as const }),
  fc.constantFrom("1m", "30m", "6h", "2d", "31d").map((maxDelay) => ({
    policy: "latest" as const,
    maxDelay,
  })),
);

const arbWindow = fc.record({
  watermarkMs: fc.integer({
    min: Date.UTC(2026, 0, 1),
    max: Date.UTC(2027, 0, 1),
  }),
  gapMs: fc.integer({ min: -DAY_MS, max: 40 * DAY_MS }),
});

Deno.test("evaluateMissedFires: a catch-up is the latest missed slot, never after now nor older than maxDelay", () => {
  fc.assert(
    fc.property(
      arbExpression,
      arbWindow,
      arbCatchUp,
      (expression, { watermarkMs, gapMs }, catchUp) => {
        const watermark = new Date(watermarkMs);
        const now = new Date(watermarkMs + gapMs);
        const result = evaluateMissedFires(expression, watermark, now, catchUp);

        assert(result.missedCount >= 0);
        assert(result.missedCount <= MISSED_FIRE_COUNT_CAP);
        if (result.saturated) {
          assertEquals(result.missedCount, MISSED_FIRE_COUNT_CAP);
        }
        assertEquals(result.latestMissed === null, result.missedCount === 0);
        if (result.latestMissed && result.oldestMissed) {
          assert(result.latestMissed.getTime() <= now.getTime());
          assert(result.oldestMissed.getTime() > watermark.getTime());
          assert(
            result.oldestMissed.getTime() <= result.latestMissed.getTime(),
          );
        }

        const fire = result.catchUpFireTime;
        if (fire === null) return;
        assertEquals(fire, result.latestMissed);
        assert(fire.getTime() <= now.getTime());
        assertEquals(catchUp?.policy, "latest");
        const maxDelayMs = parseDataDuration(catchUp?.maxDelay ?? "0m");
        assert(now.getTime() - fire.getTime() <= maxDelayMs);
      },
    ),
    { numRuns: 100 },
  );
});

// dense second-level schedules over long windows would hit the cap
const arbSparseExpression = fc.constantFrom(
  "*/15 * * * *",
  "0 * * * *",
  "0 9 * * *",
  "30 2 * * 1",
);

Deno.test("missedAroundRecordedSlot: the split misses exactly the slots after the watermark except the recorded one, and catches up as from it", () => {
  fc.assert(
    fc.property(
      arbSparseExpression,
      fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) }),
      fc.integer({ min: 1, max: 5 * DAY_MS }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      arbCatchUp,
      (expression, watermarkMs, windowMs, pick, catchUp) => {
        const watermark = new Date(watermarkMs);
        const now = new Date(watermarkMs + windowMs);
        const all = evaluateMissedFires(expression, watermark, now);
        fc.pre(all.missedCount > 0 && !all.saturated);
        const slots = new Cron(expression).nextRuns(all.missedCount, watermark);
        const recorded =
          slots[Math.min(slots.length - 1, Math.floor(pick * slots.length))];

        const split = missedAroundRecordedSlot(
          expression,
          watermark,
          recorded,
          now,
          catchUp,
        );
        assertEquals(split.missedCount, all.missedCount - 1);
        assertEquals(split.saturated, false);
        assertEquals(
          split.catchUpFireTime,
          evaluateMissedFires(expression, recorded, now, catchUp)
            .catchUpFireTime,
        );
        if (split.missedCount > 0) {
          assertEquals(
            split.oldestMissed,
            recorded.getTime() === all.oldestMissed!.getTime()
              ? slots[1]
              : all.oldestMissed,
          );
          assertEquals(
            split.latestMissed,
            recorded.getTime() === all.latestMissed!.getTime()
              ? slots[slots.length - 2]
              : all.latestMissed,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
