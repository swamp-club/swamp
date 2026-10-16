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

import fc from "fast-check";
import { assertEquals } from "@std/assert";
import {
  isSchedulePauseActiveAt,
  SCHEDULE_PAUSE_REASON_MAX_LENGTH,
  type SchedulePause,
  SchedulePauseSchema,
} from "./schedule_pause.ts";

const MIN_MS = Date.parse("2000-01-01T00:00:00Z");
const MAX_MS = Date.parse("2100-01-01T00:00:00Z");

const isoTime = fc.integer({ min: MIN_MS, max: MAX_MS }).map((ms) =>
  new Date(ms).toISOString()
);

// Printable text only: the schema refuses control characters.
const reason = fc.string({
  minLength: 1,
  maxLength: SCHEDULE_PAUSE_REASON_MAX_LENGTH,
  unit: fc.constantFrom(..."abc XYZ 019 #-_.,:()/@'\"é漢🙂".split("")),
});

const pause: fc.Arbitrary<SchedulePause> = fc.record(
  {
    workflowId: fc.uuid(),
    workflowName: fc.string({ minLength: 1, maxLength: 40 }),
    reason,
    pausedBy: fc.string({ minLength: 1, maxLength: 40 }),
    pausedAt: isoTime,
    until: isoTime,
  },
  { requiredKeys: ["workflowId", "workflowName", "pausedBy", "pausedAt"] },
);

Deno.test("SchedulePauseSchema: a valid pause round-trips through JSON unchanged", () => {
  fc.assert(
    fc.property(pause, (p) => {
      const parsed = SchedulePauseSchema.safeParse(
        JSON.parse(JSON.stringify(p)),
      );
      assertEquals(parsed.success, true);
      assertEquals(parsed.data, p);
    }),
  );
});

Deno.test("isSchedulePauseActiveAt: in force exactly before its until time", () => {
  fc.assert(
    fc.property(
      pause,
      fc.integer({ min: MIN_MS, max: MAX_MS }),
      fc.integer({ min: MIN_MS, max: MAX_MS }),
      (p, untilMs, atMs) => {
        const bounded = { ...p, until: new Date(untilMs).toISOString() };
        assertEquals(
          isSchedulePauseActiveAt(bounded, new Date(atMs)),
          atMs < untilMs,
        );
        const { until: _until, ...open } = p;
        assertEquals(isSchedulePauseActiveAt(open, new Date(atMs)), true);
      },
    ),
  );
});
