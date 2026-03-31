// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
} from "./scheduled_execution.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { createWorkflowRunId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRunDeps } from "./run.ts";

function createTestWorkflow(
  name: string,
  schedule?: string,
): Workflow {
  const step = Step.fromData({
    name: "step1",
    task: {
      type: "model_method",
      modelIdOrName: "test",
      methodName: "execute",
    },
    dependsOn: [],
    weight: 0,
    allowFailure: false,
  });
  const job = Job.fromData({
    name: "job1",
    steps: [step.toData()],
    dependsOn: [],
    weight: 0,
  });
  return Workflow.create({
    name,
    schedule,
    jobs: [job],
  });
}

function createMockWorkflowRepo(
  workflows: Workflow[],
): WorkflowRepository {
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

// Minimal mock deps that won't actually execute
function createMockWorkflowRunDeps(): WorkflowRunDeps {
  const mockRepo = createMockWorkflowRepo([]);
  return {
    workflowRepo: mockRepo,
    runRepo: {
      findById: () => Promise.resolve(null),
      findAllByWorkflowId: () => Promise.resolve([]),
      findLatestByWorkflowId: () => Promise.resolve(null),
      findAllGlobal: () => Promise.resolve([]),
      save: () => Promise.resolve(),
      nextId: () => createWorkflowRunId(crypto.randomUUID()),
      getPath: () => "",
      deleteAllByWorkflowId: () => Promise.resolve(0),
    },
    repoDir: "/tmp/test-repo",
    lookupWorkflow: () => Promise.resolve(null),
    createExecutionService: () => {
      throw new Error("not implemented in mock");
    },
  };
}

Deno.test("ScheduledExecutionService: registers schedules from existing workflows", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    createWorkflowRunDeps: () => createMockWorkflowRunDeps(),
  });

  await service.start((e) => events.push(e));

  // Should have registered the schedule
  const schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].cronExpression, "0 * * * *");

  // Should have emitted a registration event
  const registered = events.filter((e) => e.kind === "schedule_registered");
  assertEquals(registered.length, 1);

  await service.stop();
});

Deno.test("ScheduledExecutionService: ignores workflows without schedules", async () => {
  const wf = createTestWorkflow("no-schedule-wf");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    createWorkflowRunDeps: () => createMockWorkflowRunDeps(),
  });

  await service.start((e) => events.push(e));

  assertEquals(service.listSchedules().length, 0);
  assertEquals(events.length, 0);

  await service.stop();
});

Deno.test("ScheduledExecutionService: stop clears schedules", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 * * * *");

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    createWorkflowRunDeps: () => createMockWorkflowRunDeps(),
  });

  await service.start();
  assertEquals(service.listSchedules().length, 1);

  await service.stop();
  assertEquals(service.listSchedules().length, 0);
});
