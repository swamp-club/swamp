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
import { createWorkflowGateService } from "./workflow_gate.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import { getLogger } from "@logtape/logtape";

function createSuspendedWorkflowAndRun(): {
  workflow: Workflow;
  run: WorkflowRun;
} {
  const workflow = Workflow.create({
    name: "test-gate-workflow",
    jobs: [
      Job.create({
        name: "gate-job",
        steps: [
          Step.create({
            name: "approval-step",
            task: StepTask.manualApproval("Do you approve?"),
          }),
        ],
      }),
    ],
  });

  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.jobs[0];
  job.start();
  const step = job.getStep("approval-step")!;
  step.start();
  step.waitForApproval();
  run.suspend();

  return { workflow, run };
}

function createMockRepos(
  workflow: Workflow,
  run: WorkflowRun,
): { workflowRepo: WorkflowRepository; runRepo: WorkflowRunRepository } {
  return {
    workflowRepo: {
      findByIdOrName: () => Promise.resolve(workflow),
      findById: () => Promise.resolve(workflow),
      findByName: () => Promise.resolve(workflow),
      findAll: () => Promise.resolve([workflow]),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    } as unknown as WorkflowRepository,
    runRepo: {
      findById: () => Promise.resolve(run),
      findAllByWorkflowId: () => Promise.resolve([run]),
      findLatestByWorkflowId: () => Promise.resolve(run),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    } as unknown as WorkflowRunRepository,
  };
}

Deno.test("createWorkflowGateService: approve returns richer result with correct fields", async () => {
  const { workflow, run } = createSuspendedWorkflowAndRun();
  const { workflowRepo, runRepo } = createMockRepos(workflow, run);

  const service = createWorkflowGateService(workflowRepo, runRepo);
  const result = await service.approve(
    { workflowIdOrName: "test-gate-workflow", stepName: "approval-step" },
    { definitionName: "webhook-handler", methodName: "handle" },
    new AbortController().signal,
    getLogger(["test"]),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.runId, run.id);
    assertEquals(result.workflowName, "test-gate-workflow");
    assertEquals(result.stepName, "approval-step");
    assertEquals(result.approved, true);
    assertEquals(result.decidedBy, "model:webhook-handler/handle");
  }
});

Deno.test("createWorkflowGateService: reject returns richer result with approved=false", async () => {
  const { workflow, run } = createSuspendedWorkflowAndRun();
  const { workflowRepo, runRepo } = createMockRepos(workflow, run);

  const service = createWorkflowGateService(workflowRepo, runRepo);
  const result = await service.reject(
    {
      workflowIdOrName: "test-gate-workflow",
      stepName: "approval-step",
      reason: "not ready",
    },
    { definitionName: "reviewer-model", methodName: "review" },
    new AbortController().signal,
    getLogger(["test"]),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.runId, run.id);
    assertEquals(result.workflowName, "test-gate-workflow");
    assertEquals(result.stepName, "approval-step");
    assertEquals(result.approved, false);
    assertEquals(result.decidedBy, "model:reviewer-model/review");
  }
});

Deno.test("createWorkflowGateService: approve auto-populates decidedBy from caller context", async () => {
  const { workflow, run } = createSuspendedWorkflowAndRun();
  const { workflowRepo, runRepo } = createMockRepos(workflow, run);

  const service = createWorkflowGateService(workflowRepo, runRepo);
  const result = await service.approve(
    { workflowIdOrName: "test-gate-workflow", stepName: "approval-step" },
    { definitionName: "linear-bridge", methodName: "on_comment" },
    new AbortController().signal,
    getLogger(["test"]),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.decidedBy, "model:linear-bridge/on_comment");
  }
});

Deno.test("createWorkflowGateService: approve returns error for non-existent workflow", async () => {
  const workflowRepo = {
    findByIdOrName: () => Promise.resolve(null),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
  } as unknown as WorkflowRepository;
  const runRepo = {
    findAllByWorkflowId: () => Promise.resolve([]),
  } as unknown as WorkflowRunRepository;

  const service = createWorkflowGateService(workflowRepo, runRepo);
  const result = await service.approve(
    { workflowIdOrName: "nonexistent", stepName: "any-step" },
    { definitionName: "test", methodName: "test" },
    new AbortController().signal,
    getLogger(["test"]),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(typeof result.error.message, "string");
    assertEquals(result.error.message.length > 0, true);
  }
});

Deno.test("createWorkflowGateService: approve returns error for wrong step name", async () => {
  const { workflow, run } = createSuspendedWorkflowAndRun();
  const { workflowRepo, runRepo } = createMockRepos(workflow, run);

  const service = createWorkflowGateService(workflowRepo, runRepo);
  const result = await service.approve(
    { workflowIdOrName: "test-gate-workflow", stepName: "wrong-step" },
    { definitionName: "test", methodName: "test" },
    new AbortController().signal,
    getLogger(["test"]),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("wrong-step"), true);
  }
});
