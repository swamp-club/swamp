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
import { nextBackoffSleep } from "./file_lock.ts";

Deno.test("nextBackoffSleep: sleep and next backoff never exceed the cap or the budget", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      fc.integer({ min: -1_000, max: 120_000 }),
      fc.integer({ min: 1, max: 60_000 }),
      (currentBackoffMs, jitterSample, remainingMs, maxBackoffMs) => {
        const { sleepMs, nextBackoffMs } = nextBackoffSleep(
          currentBackoffMs,
          jitterSample,
          remainingMs,
          maxBackoffMs,
        );
        assert(sleepMs <= maxBackoffMs, `sleep ${sleepMs} > cap`);
        assert(sleepMs <= remainingMs, `sleep ${sleepMs} > remaining`);
        assert(nextBackoffMs <= maxBackoffMs, `next ${nextBackoffMs} > cap`);
      },
    ),
  );
});
