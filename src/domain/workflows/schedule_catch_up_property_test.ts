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
import { parseDataDuration } from "../data/duration.ts";
import {
  evaluateMissedFires,
  MISSED_FIRE_COUNT_CAP,
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
