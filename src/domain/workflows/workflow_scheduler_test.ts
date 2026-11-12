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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  canonicalFireTime,
  nextFireTime,
  WorkflowScheduler,
} from "./workflow_scheduler.ts";
import { Cron } from "croner";
import type { WorkflowId } from "./workflow_id.ts";
import { FakeSchedulerClock } from "./schedule_dst_test_helpers.ts";

const TEST_ID_1 = "aaaaaaaa-1111-1111-1111-111111111111" as WorkflowId;
const TEST_ID_2 = "bbbbbbbb-2222-2222-2222-222222222222" as WorkflowId;

Deno.test("WorkflowScheduler: register adds a schedule entry", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.register(TEST_ID_1, "0 * * * *");
  assertEquals(scheduler.size, 1);
  const schedules = scheduler.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].workflowId, TEST_ID_1);
  assertEquals(schedules[0].cronExpression, "0 * * * *");
  scheduler.stop();
});

Deno.test("WorkflowScheduler: register replaces existing schedule", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.register(TEST_ID_1, "0 * * * *");
  scheduler.register(TEST_ID_1, "30 * * * *");
  assertEquals(scheduler.size, 1);
  const schedules = scheduler.listSchedules();
  assertEquals(schedules[0].cronExpression, "30 * * * *");
  scheduler.stop();
});

Deno.test("WorkflowScheduler: unregister removes a schedule entry", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.register(TEST_ID_1, "0 * * * *");
  scheduler.unregister(TEST_ID_1);
  assertEquals(scheduler.size, 0);
  scheduler.stop();
});

Deno.test("WorkflowScheduler: unregister is no-op for unknown workflow", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.unregister(TEST_ID_1);
  assertEquals(scheduler.size, 0);
  scheduler.stop();
});

Deno.test("WorkflowScheduler: multiple workflows can be registered", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.register(TEST_ID_1, "0 * * * *");
  scheduler.register(TEST_ID_2, "30 * * * *");
  assertEquals(scheduler.size, 2);
  scheduler.stop();
});

Deno.test("WorkflowScheduler: stop clears all entries", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.register(TEST_ID_1, "0 * * * *");
  scheduler.register(TEST_ID_2, "30 * * * *");
  scheduler.stop();
  assertEquals(scheduler.size, 0);
});

Deno.test("WorkflowScheduler: listSchedules includes nextRun", () => {
  const scheduler = new WorkflowScheduler();
  scheduler.register(TEST_ID_1, "0 * * * *");
  const schedules = scheduler.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].nextRun instanceof Date, true);
  scheduler.stop();
});

Deno.test("WorkflowScheduler: start fires callback on cron match", async () => {
  const scheduler = new WorkflowScheduler();
  const fired: WorkflowId[] = [];

  scheduler.register(TEST_ID_1, "* * * * * *");
  scheduler.start((id) => {
    fired.push(id);
  });

  await waitFor(() => fired.length > 0, "first cron fire");
  scheduler.stop();

  assertEquals(fired.length > 0, true);
  assertEquals(fired[0], TEST_ID_1);
});

function fakeScheduler(start: string, timezone?: string) {
  const clock = new FakeSchedulerClock(new Date(start));
  const scheduler = new WorkflowScheduler({ timezone, clock });
  const fires: { id: WorkflowId; at: string; fireTime: string }[] = [];
  const record = (id: WorkflowId, fireTime: Date) => {
    fires.push({
      id,
      at: new Date(clock.now()).toISOString(),
      fireTime: fireTime.toISOString(),
    });
  };
  return { clock, scheduler, fires, record };
}

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

Deno.test("WorkflowScheduler: a schedule armed in the repeated fall-back hour waits for its next slot and fires once", () => {
  const { clock, scheduler, fires, record } = fakeScheduler(
    "2026-11-01T07:05:00Z",
    "America/Chicago",
  );
  scheduler.register(TEST_ID_1, "*/15 * * * *");
  scheduler.start(record);

  clock.advanceTo(new Date("2026-11-01T08:20:00Z"));
  scheduler.stop();

  assertEquals(fires.map((f) => f.fireTime), [
    "2026-11-01T08:00:00.000Z",
    "2026-11-01T08:15:00.000Z",
  ]);
  assertEquals(fires.map((f) => f.at), fires.map((f) => f.fireTime));
});

Deno.test("WorkflowScheduler: an ordinary hour fires each slot once", () => {
  const { clock, scheduler, fires, record } = fakeScheduler(
    "2026-10-01T06:40:00Z",
    "America/Chicago",
  );
  scheduler.register(TEST_ID_1, "*/15 * * * *");
  scheduler.start(record);

  clock.advanceTo(new Date("2026-10-01T07:40:00Z"));
  scheduler.stop();

  assertEquals(fires.map((f) => hhmm(f.fireTime)), [
    "06:45",
    "07:00",
    "07:15",
    "07:30",
  ]);
});

Deno.test("WorkflowScheduler: running through a fall-back fires a strictly increasing sequence with no repeats", () => {
  const chicago = fakeScheduler("2026-11-01T05:40:00Z", "America/Chicago");
  chicago.scheduler.register(TEST_ID_1, "*/15 * * * *");
  chicago.scheduler.start(chicago.record);
  chicago.clock.advanceTo(new Date("2026-11-01T08:20:00Z"));
  chicago.scheduler.stop();
  assertEquals(chicago.fires.map((f) => hhmm(f.fireTime)), [
    "05:45",
    "06:00",
    "06:15",
    "06:30",
    "06:45",
    "08:00",
    "08:15",
  ]);

  const london = fakeScheduler("2026-10-24T23:40:00Z", "Europe/London");
  london.scheduler.register(TEST_ID_1, "*/15 * * * *");
  london.scheduler.start(london.record);
  london.clock.advanceTo(new Date("2026-10-25T02:20:00Z"));
  london.scheduler.stop();
  const times = london.fires.map((f) => Date.parse(f.fireTime));
  assert(times.length > 0);
  for (let i = 1; i < times.length; i++) assert(times[i] > times[i - 1]);
  for (const fire of london.fires) {
    assert(Date.parse(fire.at) >= Date.parse(fire.fireTime));
  }
});

Deno.test("WorkflowScheduler: a distant slot is waited for in steps of at most 30s and not fired early", () => {
  const { clock, scheduler, fires, record } = fakeScheduler(
    "2026-12-30T00:00:00Z",
    "UTC",
  );
  scheduler.register(TEST_ID_1, "0 0 1 1 *");
  scheduler.start(record);

  clock.advanceTo(new Date("2026-12-31T00:00:00Z"));
  assertEquals(fires.length, 0);
  assert(clock.delays.length > 1);
  assert(clock.delays.every((ms) => ms <= 30_000));

  clock.advanceTo(new Date("2027-01-01T00:00:00Z"));
  scheduler.stop();
  assertEquals(fires.map((f) => f.fireTime), ["2027-01-01T00:00:00.000Z"]);
});

Deno.test("WorkflowScheduler: register before start does not fire, and start twice fires each slot once", () => {
  const { clock, scheduler, fires, record } = fakeScheduler(
    "2026-06-01T00:00:00Z",
    "UTC",
  );
  scheduler.register(TEST_ID_1, "*/15 * * * *");
  clock.advanceTo(new Date("2026-06-01T00:20:00Z"));
  assertEquals(fires.length, 0);
  assertEquals(clock.pendingCount, 0);

  scheduler.start(record);
  scheduler.start(record);
  assertEquals(clock.pendingCount, 1);
  clock.advanceTo(new Date("2026-06-01T00:50:00Z"));
  scheduler.stop();

  assertEquals(fires.map((f) => hhmm(f.fireTime)), ["00:30", "00:45"]);
});

Deno.test("WorkflowScheduler: unregister, stop and re-register leave no timer for a removed or replaced entry", () => {
  const { clock, scheduler, fires, record } = fakeScheduler(
    "2026-06-01T00:00:00Z",
    "UTC",
  );
  scheduler.start(record);
  scheduler.register(TEST_ID_1, "*/15 * * * *");
  scheduler.register(TEST_ID_1, "*/30 * * * *");
  scheduler.register(TEST_ID_2, "*/15 * * * *");
  assertEquals(clock.pendingCount, 2);

  scheduler.unregister(TEST_ID_2);
  assertEquals(clock.pendingCount, 1);
  clock.advanceTo(new Date("2026-06-01T01:00:00Z"));
  assertEquals(fires.map((f) => `${f.id}@${hhmm(f.fireTime)}`), [
    `${TEST_ID_1}@00:30`,
    `${TEST_ID_1}@01:00`,
  ]);

  scheduler.stop();
  assertEquals(clock.pendingCount, 0);
  clock.advanceTo(new Date("2026-06-01T02:00:00Z"));
  assertEquals(fires.length, 2);
});

Deno.test("WorkflowScheduler: an onFire that unregisters or re-registers its own workflow leaves only the registered entries' timers", () => {
  const removing = fakeScheduler("2026-06-01T00:00:00Z", "UTC");
  removing.scheduler.register(TEST_ID_1, "*/15 * * * *");
  removing.scheduler.start((id, fireTime) => {
    removing.record(id, fireTime);
    removing.scheduler.unregister(id);
  });
  removing.clock.advanceTo(new Date("2026-06-01T01:00:00Z"));
  assertEquals(removing.fires.length, 1);
  assertEquals(removing.clock.pendingCount, 0);

  const replacing = fakeScheduler("2026-06-01T00:00:00Z", "UTC");
  replacing.scheduler.register(TEST_ID_1, "*/15 * * * *");
  replacing.scheduler.start((id, fireTime) => {
    replacing.record(id, fireTime);
    replacing.scheduler.register(id, "*/15 * * * *");
  });
  replacing.clock.advanceTo(new Date("2026-06-01T01:00:00Z"));
  replacing.scheduler.stop();
  assertEquals(replacing.fires.map((f) => hhmm(f.fireTime)), [
    "00:15",
    "00:30",
    "00:45",
    "01:00",
  ]);
});

Deno.test("WorkflowScheduler: an onFire that throws or rejects keeps the schedule firing", () => {
  for (const failure of ["throw", "reject"] as const) {
    const { clock, scheduler, fires, record } = fakeScheduler(
      "2026-06-01T00:00:00Z",
      "UTC",
    );
    scheduler.register(TEST_ID_1, "*/15 * * * *");
    scheduler.start((id, fireTime) => {
      record(id, fireTime);
      if (failure === "throw") throw new Error("sync failure");
      return Promise.reject(new Error("async failure"));
    });
    clock.advanceTo(new Date("2026-06-01T00:45:00Z"));
    scheduler.stop();
    assertEquals(fires.map((f) => hhmm(f.fireTime)), [
      "00:15",
      "00:30",
      "00:45",
    ], failure);
  }
});

Deno.test("canonicalFireTime: snaps to cron grid regardless of sub-second offset", () => {
  const cron = new Cron("*/10 * * * * *", { paused: true });

  const base = new Date("2026-08-01T12:00:30.000Z");
  const skewed = new Date(base.getTime() + 123);
  const result = canonicalFireTime(cron, skewed);
  assertEquals(result.getTime(), base.getTime());

  const lateSkew = new Date(base.getTime() + 999);
  assertEquals(canonicalFireTime(cron, lateSkew).getTime(), base.getTime());

  cron.stop();
});

Deno.test("canonicalFireTime: two instances with 500ms clock skew produce the same time", () => {
  const cron = new Cron("0 * * * *", { paused: true });

  const instanceA = new Date("2026-08-01T15:00:00.050Z");
  const instanceB = new Date("2026-08-01T15:00:00.550Z");

  const timeA = canonicalFireTime(cron, instanceA);
  const timeB = canonicalFireTime(cron, instanceB);
  assertEquals(timeA.getTime(), timeB.getTime());
  assertEquals(timeA.toISOString(), "2026-08-01T15:00:00.000Z");

  cron.stop();
});

Deno.test("canonicalFireTime: handles per-second cron", () => {
  const cron = new Cron("* * * * * *", { paused: true });

  const now = new Date("2026-08-01T12:00:45.789Z");
  const result = canonicalFireTime(cron, now);
  assertEquals(result.toISOString(), "2026-08-01T12:00:45.000Z");

  cron.stop();
});

Deno.test("canonicalFireTime: snaps forward when timer fires early", () => {
  const cron = new Cron("0 * * * *", { paused: true });

  const earlyFire = new Date("2026-08-01T14:59:59.998Z");
  const result = canonicalFireTime(cron, earlyFire);
  assertEquals(result.toISOString(), "2026-08-01T15:00:00.000Z");

  cron.stop();
});

Deno.test("canonicalFireTime: inside the repeated fall-back hour never resolves to a slot before its lookback", () => {
  const cron = new Cron("*/15 * * * *", {
    timezone: "America/Chicago",
    paused: true,
  });

  const inRepeatedHour = new Date("2026-11-01T07:15:00.000Z");
  const result = canonicalFireTime(cron, inRepeatedHour);
  assertEquals(
    result.getTime() >= inRepeatedHour.getTime() - 120_000,
    true,
  );
  assertEquals(result, inRepeatedHour);

  const nextFire = new Date("2026-11-01T08:00:00.050Z");
  assertEquals(
    canonicalFireTime(cron, nextFire).toISOString(),
    "2026-11-01T08:00:00.000Z",
  );

  cron.stop();
});

Deno.test("nextFireTime: gives the first slot strictly after the instant, or null for an invalid expression", () => {
  assertEquals(
    nextFireTime("0 * * * *", new Date(2026, 7, 1, 15, 0, 0, 0)),
    new Date(2026, 7, 1, 16, 0, 0, 0),
  );
  assertEquals(nextFireTime("not a cron", new Date()), null);
});
