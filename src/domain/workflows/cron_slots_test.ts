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
import { Cron } from "croner";
import { nextSlotAfter } from "./cron_slots.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// each 2026 fall-back instant, and whether the zone's UTC offset is negative
const FALL_BACKS = [
  { timezone: "America/Chicago", at: "2026-11-01T07:00:00Z", negative: true },
  { timezone: "America/Santiago", at: "2026-04-05T03:00:00Z", negative: true },
  { timezone: "Europe/London", at: "2026-10-25T01:00:00Z", negative: false },
  {
    timezone: "Australia/Lord_Howe",
    at: "2026-04-04T15:00:00Z",
    negative: false,
  },
];

function instantsAround(at: string, stepMs: number): Date[] {
  const centre = Date.parse(at);
  const out: Date[] = [];
  // an odd offset keeps most probes off the slot grid
  for (
    let t = centre - 3 * HOUR_MS + 7_013;
    t < centre + 3 * HOUR_MS;
    t += stepMs
  ) {
    out.push(new Date(t));
  }
  return out;
}

Deno.test("nextSlotAfter: in America/Chicago just after the fall-back, gives the next slot croner fires rather than one before the instant", () => {
  const cron = new Cron("*/15 * * * *", {
    timezone: "America/Chicago",
    paused: true,
  });
  const after = new Date("2026-11-01T07:00:00.000Z");
  assertEquals(
    nextSlotAfter(cron, after),
    new Date("2026-11-01T08:00:00.000Z"),
  );
  assertEquals(
    nextSlotAfter(cron, new Date("2026-11-01T06:30:00.000Z")),
    new Date("2026-11-01T06:45:00.000Z"),
  );
  cron.stop();
});

Deno.test("nextSlotAfter: across every fall-back hour the slot is strictly after the instant", () => {
  for (const { timezone, at } of FALL_BACKS) {
    for (const expression of ["*/15 * * * *", "30 1 * * *", "0 * * * *"]) {
      const cron = new Cron(expression, { timezone, paused: true });
      for (const after of instantsAround(at, MINUTE_MS)) {
        const next = nextSlotAfter(cron, after);
        assert(next, `${timezone} ${expression} ${after.toISOString()}`);
        assert(
          next.getTime() > after.getTime(),
          `${timezone} ${expression} ${after.toISOString()} gave ${next.toISOString()}`,
        );
      }
      cron.stop();
    }
  }
});

Deno.test("nextSlotAfter: a second-level schedule across a fall-back hour stays strictly after the instant", () => {
  for (const { timezone, at } of FALL_BACKS) {
    const cron = new Cron("*/20 * * * * *", { timezone, paused: true });
    for (const after of instantsAround(at, 37_000)) {
      const next = nextSlotAfter(cron, after);
      assert(next && next.getTime() > after.getTime(), timezone);
    }
    cron.stop();
  }
});

Deno.test("nextSlotAfter: in negative-offset zones the slot never moves back as the instant moves forward", () => {
  for (const { timezone, at } of FALL_BACKS.filter((z) => z.negative)) {
    const cron = new Cron("*/15 * * * *", { timezone, paused: true });
    let previous = 0;
    for (const after of instantsAround(at, MINUTE_MS)) {
      const next = nextSlotAfter(cron, after)!;
      assert(next.getTime() >= previous, `${timezone} ${after.toISOString()}`);
      previous = next.getTime();
    }
    cron.stop();
  }
});

Deno.test("nextSlotAfter: across a spring-forward and away from DST it gives croner's own next slot", () => {
  const cron = new Cron("*/15 * * * *", {
    timezone: "America/Chicago",
    paused: true,
  });
  for (const at of ["2026-03-08T08:00:00Z", "2026-07-01T12:00:00Z"]) {
    for (const after of instantsAround(at, MINUTE_MS)) {
      assertEquals(nextSlotAfter(cron, after), cron.nextRun(after));
    }
  }
  cron.stop();
});
