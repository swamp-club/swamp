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
import { WorkflowScheduler } from "./workflow_scheduler.ts";
import type { WorkflowId } from "./workflow_id.ts";

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

  // Use per-second cron: fires every second
  scheduler.register(TEST_ID_1, "* * * * * *");
  scheduler.start((id) => fired.push(id));

  // Wait for at least one fire
  await new Promise((resolve) => setTimeout(resolve, 1500));
  scheduler.stop();

  assertEquals(fired.length > 0, true);
  assertEquals(fired[0], TEST_ID_1);
});
