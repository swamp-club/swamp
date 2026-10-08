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
import { scheduleQueueLabel, totalQueued } from "./schedule_queue.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

Deno.test("scheduleQueueLabel: nothing waiting shows nothing", () => {
  assertEquals(
    scheduleQueueLabel({ queued: 0, oldestQueuedAt: null }, NOW),
    null,
  );
});

Deno.test("scheduleQueueLabel: a server without queue fields shows nothing", () => {
  assertEquals(scheduleQueueLabel({}, NOW), null);
});

Deno.test("scheduleQueueLabel: shows the count and how long the oldest has waited", () => {
  assertEquals(
    scheduleQueueLabel(
      { queued: 2, oldestQueuedAt: "2026-10-08T11:48:00.000Z" },
      NOW,
    ),
    "2 queued · waiting 12m",
  );
  assertEquals(
    scheduleQueueLabel(
      { queued: 1, oldestQueuedAt: "2026-10-08T09:11:00.000Z" },
      NOW,
    ),
    "1 queued · waiting 2h 49m",
  );
  assertEquals(
    scheduleQueueLabel(
      { queued: 1, oldestQueuedAt: "2026-10-08T11:59:30.000Z" },
      NOW,
    ),
    "1 queued · waiting < 1m",
  );
});

Deno.test("scheduleQueueLabel: an unreadable fire time still shows the count", () => {
  assertEquals(
    scheduleQueueLabel({ queued: 3, oldestQueuedAt: "not a date" }, NOW),
    "3 queued",
  );
});

Deno.test("totalQueued: sums the visible schedules and treats missing as zero", () => {
  assertEquals(totalQueued([{ queued: 2 }, {}, { queued: 1 }]), 3);
  assertEquals(totalQueued([]), 0);
});
