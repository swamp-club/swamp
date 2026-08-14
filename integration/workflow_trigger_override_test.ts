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
  type ScheduledExecutionEvent,
  ScheduledExecutionService,
} from "../src/libswamp/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { WorkflowRepository } from "../src/domain/workflows/repositories.ts";
import type { WorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

function createTestWorkflow(
  name: string,
  schedule?: string,
): Workflow {
  return Workflow.create({
    name,
    trigger: schedule ? { schedule } : undefined,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "echo",
            task: StepTask.directExecution(
              "command/shell",
              `${name}-shell`,
              "execute",
              { run: "echo ok" },
            ),
          }),
        ],
      }),
    ],
  });
}

function createMockRepo(workflows: Workflow[]): WorkflowRepository {
  return {
    findAll: () => Promise.resolve(workflows),
    findById: (id: WorkflowId) =>
      Promise.resolve(workflows.find((w) => w.id === id) ?? null),
    findByName: (name: string) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => crypto.randomUUID() as WorkflowId,
    getPath: () => "",
  };
}

Deno.test({
  name:
    "trigger override: adds schedule to unscheduled extension workflow and scheduler registers it",
  fn: async () => {
    const extWorkflow = createTestWorkflow("ext-scanner");
    assertEquals(extWorkflow.schedule, undefined);

    const events: ScheduledExecutionEvent[] = [];
    const service = new ScheduledExecutionService({
      workflowRepo: createMockRepo([extWorkflow]),
      repoDir: "/tmp/nonexistent-trigger-override-test",
      executeWorkflow: () => Promise.resolve(),
      triggerOverrides: new Map([
        ["ext-scanner", { schedule: "0 3 * * *" }],
      ]),
    });

    await service.start((e) => events.push(e));

    const schedules = service.listSchedules();
    assertEquals(schedules.length, 1);
    assertEquals(schedules[0].workflowId, extWorkflow.id);
    assertEquals(schedules[0].cronExpression, "0 3 * * *");

    const registered = events.filter((e) => e.kind === "schedule_registered");
    assertEquals(registered.length, 1);
    assertEquals(
      registered[0].kind === "schedule_registered" &&
        registered[0].cronExpression,
      "0 3 * * *",
    );

    await service.stop();
  },
});

Deno.test({
  name: "trigger override: replaces built-in schedule with override schedule",
  fn: async () => {
    const workflow = createTestWorkflow("daily-report", "0 12 * * *");

    const service = new ScheduledExecutionService({
      workflowRepo: createMockRepo([workflow]),
      repoDir: "/tmp/nonexistent-trigger-override-test",
      executeWorkflow: () => Promise.resolve(),
      triggerOverrides: new Map([
        ["daily-report", { schedule: "0 8 * * 1-5" }],
      ]),
    });

    await service.start();

    const schedules = service.listSchedules();
    assertEquals(schedules.length, 1);
    assertEquals(schedules[0].cronExpression, "0 8 * * 1-5");

    await service.stop();
  },
});

Deno.test({
  name: "trigger override: multiple overrides registered correctly",
  fn: async () => {
    const wf1 = createTestWorkflow("scheduled-wf", "0 * * * *");
    const wf2 = createTestWorkflow("unscheduled-wf");

    const service = new ScheduledExecutionService({
      workflowRepo: createMockRepo([wf1, wf2]),
      repoDir: "/tmp/nonexistent-trigger-override-test",
      executeWorkflow: () => Promise.resolve(),
      triggerOverrides: new Map([
        ["scheduled-wf", { schedule: "0 3 * * *" }],
        ["unscheduled-wf", { schedule: "0 6 * * *" }],
      ]),
    });

    await service.start();

    const schedules = service.listSchedules();
    assertEquals(schedules.length, 2);

    const byId = new Map(schedules.map((s) => [s.workflowId, s]));
    assertEquals(byId.get(wf1.id)!.cronExpression, "0 3 * * *");
    assertEquals(byId.get(wf2.id)!.cronExpression, "0 6 * * *");

    await service.stop();
  },
});
