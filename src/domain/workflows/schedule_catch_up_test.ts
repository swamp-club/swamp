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
  evaluateMissedFires,
  firstRecordedSlot,
  latestRecordedSlot,
  MISSED_FIRE_COUNT_CAP,
  missedAroundRecordedSlot,
  ScheduleCatchUpSchema,
  SCHEDULED_FOR_TAG,
} from "./schedule_catch_up.ts";

const LATEST_6H = { policy: "latest" as const, maxDelay: "6h" };

// croner reads cron fields in the process time zone, so a monthly schedule's
// slots are built from local-time fields to hold in any TZ
const OCT_1_0900 = new Date(2026, 9, 1, 9, 0, 0, 0);
const NOV_1_0900 = new Date(2026, 10, 1, 9, 0, 0, 0);
const NOV_1_1000 = new Date(2026, 10, 1, 10, 0, 0, 0);

function issueMessages(value: unknown): string[] {
  const parsed = ScheduleCatchUpSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

Deno.test("ScheduleCatchUpSchema: accepts policy none and policy latest with a maxDelay", () => {
  assertEquals(ScheduleCatchUpSchema.parse({ policy: "none" }), {
    policy: "none",
  });
  assertEquals(ScheduleCatchUpSchema.parse(LATEST_6H), LATEST_6H);
  assertEquals(
    ScheduleCatchUpSchema.safeParse({ policy: "latest", maxDelay: "31d" })
      .success,
    true,
  );
});

Deno.test("ScheduleCatchUpSchema: policy latest requires maxDelay", () => {
  assertEquals(issueMessages({ policy: "latest" }), [
    "policy 'latest' requires maxDelay, e.g. 6h",
  ]);
});

Deno.test("ScheduleCatchUpSchema: policy none refuses a maxDelay", () => {
  assertEquals(issueMessages({ policy: "none", maxDelay: "6h" }), [
    "maxDelay applies only to policy 'latest'",
  ]);
});

Deno.test("ScheduleCatchUpSchema: refuses a malformed or zero maxDelay", () => {
  assertEquals(
    ScheduleCatchUpSchema.safeParse({ policy: "latest", maxDelay: "6 hours" })
      .success,
    false,
  );
  assertEquals(
    ScheduleCatchUpSchema.safeParse({ policy: "latest", maxDelay: "0h" })
      .success,
    false,
  );
});

Deno.test("ScheduleCatchUpSchema: refuses a maxDelay over 31d", () => {
  assertEquals(issueMessages({ policy: "latest", maxDelay: "32d" }), [
    "maxDelay must be at most 31d",
  ]);
});

Deno.test("ScheduleCatchUpSchema: refuses an unknown policy or key", () => {
  assertEquals(
    ScheduleCatchUpSchema.safeParse({ policy: "all" }).success,
    false,
  );
  assertEquals(
    ScheduleCatchUpSchema.safeParse({ policy: "none", extra: true }).success,
    false,
  );
});

Deno.test("evaluateMissedFires: a watermark at or after now misses nothing", () => {
  const now = new Date("2026-11-01T10:00:00.000Z");
  for (const watermark of [now, new Date(now.getTime() + 60_000)]) {
    assertEquals(evaluateMissedFires("* * * * *", watermark, now, LATEST_6H), {
      missedCount: 0,
      saturated: false,
      oldestMissed: null,
      latestMissed: null,
      catchUpFireTime: null,
    });
  }
});

Deno.test("evaluateMissedFires: no slot between the watermark and now misses nothing", () => {
  const result = evaluateMissedFires(
    "*/15 * * * *",
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:14:59.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 0);
  assertEquals(result.latestMissed, null);
  assertEquals(result.catchUpFireTime, null);
});

Deno.test("evaluateMissedFires: a monthly slot missed an hour ago is caught up within maxDelay", () => {
  const result = evaluateMissedFires(
    "0 9 1 * *",
    OCT_1_0900,
    NOV_1_1000,
    LATEST_6H,
  );
  assertEquals(result.missedCount, 1);
  assertEquals(result.saturated, false);
  assertEquals(result.oldestMissed, NOV_1_0900);
  assertEquals(result.latestMissed, NOV_1_0900);
  assertEquals(result.catchUpFireTime, NOV_1_0900);
});

Deno.test("evaluateMissedFires: a slot older than maxDelay is reported but not caught up", () => {
  const result = evaluateMissedFires(
    "0 9 1 * *",
    OCT_1_0900,
    NOV_1_1000,
    { policy: "latest", maxDelay: "30m" },
  );
  assertEquals(result.missedCount, 1);
  assertEquals(result.latestMissed, NOV_1_0900);
  assertEquals(result.catchUpFireTime, null);
});

Deno.test("evaluateMissedFires: policy none, or no policy, never catches up", () => {
  for (
    const catchUp of [{ policy: "none" as const }, undefined]
  ) {
    const result = evaluateMissedFires(
      "0 9 1 * *",
      OCT_1_0900,
      NOV_1_1000,
      catchUp,
    );
    assertEquals(result.missedCount, 1);
    assertEquals(result.latestMissed, NOV_1_0900);
    assertEquals(result.catchUpFireTime, null);
  }
});

Deno.test("evaluateMissedFires: a slot exactly at now is missed", () => {
  const now = new Date("2026-11-01T10:15:00.000Z");
  const result = evaluateMissedFires(
    "*/15 * * * *",
    new Date("2026-11-01T10:05:00.000Z"),
    now,
    LATEST_6H,
  );
  assertEquals(result.missedCount, 1);
  assertEquals(result.latestMissed, now);
  assertEquals(result.catchUpFireTime, now);
});

Deno.test("evaluateMissedFires: a watermark on a slot excludes that slot", () => {
  const result = evaluateMissedFires(
    "*/15 * * * *",
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:20:00.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 1);
  assertEquals(result.oldestMissed, new Date("2026-11-01T10:15:00.000Z"));
});

Deno.test("evaluateMissedFires: several missed slots report the oldest and latest and catch up only the latest", () => {
  const result = evaluateMissedFires(
    "*/15 * * * *",
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T11:05:00.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 4);
  assertEquals(result.saturated, false);
  assertEquals(result.oldestMissed, new Date("2026-11-01T10:15:00.000Z"));
  assertEquals(result.latestMissed, new Date("2026-11-01T11:00:00.000Z"));
  assertEquals(result.catchUpFireTime, new Date("2026-11-01T11:00:00.000Z"));
});

Deno.test("evaluateMissedFires: a dense schedule over a long outage saturates at the cap and still finds the latest slot", () => {
  const watermark = new Date("2026-11-01T00:00:00.000Z");
  const now = new Date(watermark.getTime() + 24 * 60 * 60 * 1000 + 500);
  const result = evaluateMissedFires(
    "* * * * * *",
    watermark,
    now,
    LATEST_6H,
  );
  const lastSecond = new Date(Math.floor(now.getTime() / 1000) * 1000);
  assertEquals(result.missedCount, MISSED_FIRE_COUNT_CAP);
  assertEquals(result.saturated, true);
  assertEquals(result.oldestMissed, new Date(watermark.getTime() + 1000));
  assertEquals(result.latestMissed, lastSecond);
  assertEquals(result.catchUpFireTime, lastSecond);
});

Deno.test("evaluateMissedFires: exactly the cap of slots is not saturated", () => {
  const watermark = new Date("2026-11-01T00:00:00.000Z");
  const now = new Date(watermark.getTime() + MISSED_FIRE_COUNT_CAP * 1000);
  const result = evaluateMissedFires("* * * * * *", watermark, now);
  assertEquals(result.missedCount, MISSED_FIRE_COUNT_CAP);
  assertEquals(result.saturated, false);
  assertEquals(result.latestMissed, now);
});

Deno.test("latestRecordedSlot: counts only runs the scheduler started", () => {
  const scheduler = "service:scheduler";
  const runs: { initiatedBy: string; tags: Record<string, string> }[] = [
    {
      initiatedBy: scheduler,
      tags: { [SCHEDULED_FOR_TAG]: "2026-10-01T09:00:00.000Z" },
    },
    {
      initiatedBy: scheduler,
      tags: { [SCHEDULED_FOR_TAG]: "2026-11-01T09:00:00.000Z" },
    },
    {
      initiatedBy: "user:mallory",
      tags: { [SCHEDULED_FOR_TAG]: "2099-01-01T00:00:00.000Z" },
    },
    { initiatedBy: scheduler, tags: {} },
    { initiatedBy: scheduler, tags: { [SCHEDULED_FOR_TAG]: "not a date" } },
  ];
  assertEquals(
    latestRecordedSlot(runs, scheduler)?.toISOString(),
    "2026-11-01T09:00:00.000Z",
  );
  assertEquals(latestRecordedSlot(runs.slice(2), scheduler), null);
  assertEquals(latestRecordedSlot([], scheduler), null);
});

Deno.test("firstRecordedSlot: passes over runs the scheduler did not start and stops at the first it did", async () => {
  const scheduler = "service:scheduler";
  let read = 0;
  async function* latestFirst() {
    const runs = [
      {
        initiatedBy: "user:mallory",
        tags: { [SCHEDULED_FOR_TAG]: "2099-01-01T00:00:00.000Z" },
      },
      {
        initiatedBy: scheduler,
        tags: { [SCHEDULED_FOR_TAG]: "2026-11-01T09:00:00.000Z" },
      },
      {
        initiatedBy: scheduler,
        tags: { [SCHEDULED_FOR_TAG]: "2026-10-01T09:00:00.000Z" },
      },
    ];
    for (const run of runs) {
      read++;
      yield await Promise.resolve(run);
    }
  }
  assertEquals(
    (await firstRecordedSlot(latestFirst(), scheduler, NOV_1_1000))
      ?.toISOString(),
    "2026-11-01T09:00:00.000Z",
  );
  assertEquals(read, 2);
});

Deno.test("firstRecordedSlot: with no run the scheduler started gives null", async () => {
  async function* none() {
    yield await Promise.resolve({
      initiatedBy: "user:mallory",
      tags: { [SCHEDULED_FOR_TAG]: "2026-11-01T09:00:00.000Z" },
    });
  }
  assertEquals(
    await firstRecordedSlot(none(), "service:scheduler", NOV_1_1000),
    null,
  );
});

Deno.test("firstRecordedSlot: passes over a slot after notAfter and takes the next one the scheduler started", async () => {
  const scheduler = "service:scheduler";
  async function* latestFirst() {
    yield await Promise.resolve({
      initiatedBy: scheduler,
      tags: { [SCHEDULED_FOR_TAG]: "2099-01-01T00:00:00.000Z" },
    });
    yield await Promise.resolve({
      initiatedBy: scheduler,
      tags: { [SCHEDULED_FOR_TAG]: "2026-10-01T09:00:00.000Z" },
    });
  }
  assertEquals(
    (await firstRecordedSlot(
      latestFirst(),
      scheduler,
      new Date("2026-11-01T00:00:00.000Z"),
    ))?.toISOString(),
    "2026-10-01T09:00:00.000Z",
  );
});

Deno.test("firstRecordedSlot: a slot exactly at notAfter counts, and only slots after it give null", async () => {
  const scheduler = "service:scheduler";
  const slot = "2026-11-01T09:00:00.000Z";
  async function* one() {
    yield await Promise.resolve({
      initiatedBy: scheduler,
      tags: { [SCHEDULED_FOR_TAG]: slot },
    });
  }
  assertEquals(
    (await firstRecordedSlot(one(), scheduler, new Date(slot)))?.toISOString(),
    slot,
  );
  assertEquals(
    await firstRecordedSlot(
      one(),
      scheduler,
      new Date(Date.parse(slot) - 1),
    ),
    null,
  );
});

const QUARTER = "*/15 * * * *";

Deno.test("missedAroundRecordedSlot: a recorded slot equal to the latest missed reports the gap before it and catches up nothing", () => {
  const result = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T11:00:00.000Z"),
    new Date("2026-11-01T11:05:00.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 3);
  assertEquals(result.saturated, false);
  assertEquals(result.oldestMissed, new Date("2026-11-01T10:15:00.000Z"));
  assertEquals(result.latestMissed, new Date("2026-11-01T10:45:00.000Z"));
  assertEquals(result.catchUpFireTime, null);
});

Deno.test("missedAroundRecordedSlot: a recorded slot mid-way reports the gap and the slots after it, and catches up only the latest after it", () => {
  const result = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:30:00.000Z"),
    new Date("2026-11-01T11:05:00.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 3);
  assertEquals(result.oldestMissed, new Date("2026-11-01T10:15:00.000Z"));
  assertEquals(result.latestMissed, new Date("2026-11-01T11:00:00.000Z"));
  assertEquals(result.catchUpFireTime, new Date("2026-11-01T11:00:00.000Z"));
});

Deno.test("missedAroundRecordedSlot: a recorded slot right after the watermark leaves no gap", () => {
  const result = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:15:00.000Z"),
    new Date("2026-11-01T10:20:00.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 0);
  assertEquals(result.oldestMissed, null);
  assertEquals(result.latestMissed, null);
  assertEquals(result.catchUpFireTime, null);
});

Deno.test("missedAroundRecordedSlot: a recorded time off the schedule splits without removing a slot", () => {
  const result = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:20:00.000Z"),
    new Date("2026-11-01T10:50:00.000Z"),
    LATEST_6H,
  );
  assertEquals(result.missedCount, 3);
  assertEquals(result.oldestMissed, new Date("2026-11-01T10:15:00.000Z"));
  assertEquals(result.latestMissed, new Date("2026-11-01T10:45:00.000Z"));
  assertEquals(result.catchUpFireTime, new Date("2026-11-01T10:45:00.000Z"));
});

Deno.test("missedAroundRecordedSlot: slots after the recorded one older than maxDelay are reported but not caught up", () => {
  const result = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:30:00.000Z"),
    new Date("2026-11-01T18:00:00.000Z"),
    { policy: "latest", maxDelay: "1m" },
  );
  assertEquals(result.missedCount, 31);
  assertEquals(result.latestMissed, new Date("2026-11-01T18:00:00.000Z"));
  assertEquals(result.catchUpFireTime, new Date("2026-11-01T18:00:00.000Z"));
  const late = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:30:00.000Z"),
    new Date("2026-11-01T18:05:00.000Z"),
    { policy: "latest", maxDelay: "1m" },
  );
  assertEquals(late.latestMissed, new Date("2026-11-01T18:00:00.000Z"));
  assertEquals(late.catchUpFireTime, null);
});

Deno.test("missedAroundRecordedSlot: without a catch-up policy nothing is caught up", () => {
  const result = missedAroundRecordedSlot(
    QUARTER,
    new Date("2026-11-01T10:00:00.000Z"),
    new Date("2026-11-01T10:30:00.000Z"),
    new Date("2026-11-01T11:05:00.000Z"),
  );
  assertEquals(result.missedCount, 3);
  assertEquals(result.catchUpFireTime, null);
});

Deno.test("missedAroundRecordedSlot: a saturated gap saturates the result, and the sum stays capped", () => {
  const watermark = new Date("2026-11-01T00:00:00.000Z");
  const recorded = new Date(
    watermark.getTime() + 2 * MISSED_FIRE_COUNT_CAP * 1000,
  );
  const now = new Date(recorded.getTime() + 10 * 1000);
  const result = missedAroundRecordedSlot(
    "* * * * * *",
    watermark,
    recorded,
    now,
    LATEST_6H,
  );
  assertEquals(result.missedCount, MISSED_FIRE_COUNT_CAP);
  assertEquals(result.saturated, true);
  assertEquals(result.oldestMissed, new Date(watermark.getTime() + 1000));
  assertEquals(result.latestMissed, now);
  assertEquals(result.catchUpFireTime, now);
});

Deno.test("missedAroundRecordedSlot: two parts that together pass the cap saturate though neither does", () => {
  const watermark = new Date("2026-11-01T00:00:00.000Z");
  const recorded = new Date(watermark.getTime() + 601 * 1000);
  const now = new Date(recorded.getTime() + 600 * 1000);
  const result = missedAroundRecordedSlot(
    "* * * * * *",
    watermark,
    recorded,
    now,
  );
  assertEquals(result.missedCount, MISSED_FIRE_COUNT_CAP);
  assertEquals(result.saturated, true);
});
