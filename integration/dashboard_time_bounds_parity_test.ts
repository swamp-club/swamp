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

/**
 * The dashboard sends a preset time range to serve as a relative duration
 * (packages/dashboard time_range.ts), so the request does not change as the
 * clock moves (swamp-club#3444). Serve must read each one back as exactly
 * the window the dashboard shows for that preset.
 */

import { assertEquals } from "@std/assert";
import { parseRunTimeBound } from "../src/libswamp/workflows/run_search.ts";
import {
  requestTimeBounds,
  resolveTimeRange,
  TIME_PRESETS,
  type TimeRange,
} from "../packages/dashboard/src/client/time_range.ts";

const NOW = Date.UTC(2026, 9, 14, 16, 0, 0);

Deno.test("dashboard time bounds: serve reads every preset's duration as the window the dashboard shows", () => {
  for (const { preset } of TIME_PRESETS) {
    const range: TimeRange = { kind: "preset", preset };
    const sent = requestTimeBounds(range);
    const shown = resolveTimeRange(range, NOW);
    assertEquals(sent.until, undefined, preset);
    if (shown.since === undefined) {
      assertEquals(sent.since, undefined, preset);
      continue;
    }
    assertEquals(
      sent.since === undefined ? undefined : parseRunTimeBound(sent.since, NOW),
      Date.parse(shown.since),
      preset,
    );
  }
});
