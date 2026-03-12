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
  extractStepArtifacts,
  toRunData,
  workflowExecutionFailed,
  workflowNotFound,
  workflowRun,
  type WorkflowRunDeps,
} from "./run.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowExecutionEvent } from "../../domain/workflows/execution_service.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";

// --- Test helpers ---

class InMemoryWorkflowRepository implements WorkflowRepository {
  private workflows = new Map<string, Workflow>();

  findById(id: WorkflowId): Promise<Workflow | null> {
    return Promise.resolve(this.workflows.get(id) ?? null);
  }
  findByName(name: string): Promise<Workflow | null> {
    for (const w of this.workflows.values()) {
      if (w.name === name) return Promise.resolve(w);
    }
    return Promise.resolve(null);
  }
  findAll(): Promise<Workflow[]> {
    return Promise.resolve(Array.from(this.workflows.values()));
  }
  save(w: Workflow): Promise<void> {
    this.workflows.set(w.id, w);
    return Promise.resolve();
  }
  delete(id: WorkflowId): Promise<void> {
    this.workflows.delete(id);
    return Promise.resolve();
  }
  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }
  getPath(id: WorkflowId): string {
    return `workflows/workflow-${id}.yaml`;
  }
}

class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private runs = new Map<string, WorkflowRun[]>();

  findById(
    wfId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    const runs = this.runs.get(wfId) ?? [];
    return Promise.resolve(runs.find((r) => r.id === runId) ?? null);
  }
  findAllByWorkflowId(wfId: WorkflowId): Promise<WorkflowRun[]> {
    return Promise.resolve(this.runs.get(wfId) ?? []);
  }
  findLatestByWorkflowId(wfId: WorkflowId): Promise<WorkflowRun | null> {
    const runs = this.runs.get(wfId) ?? [];
    return Promise.resolve(runs[runs.length - 1] ?? null);
  }
  findAllGlobal(): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
    for (const [wfId, runs] of this.runs.entries()) {
      for (const run of runs) {
        results.push({ run, workflowId: wfId as WorkflowId });
      }
    }
    return Promise.resolve(results);
  }
  save(wfId: WorkflowId, run: WorkflowRun): Promise<void> {
    const existing = this.runs.get(wfId) ?? [];
    const idx = existing.findIndex((r) => r.id === run.id);
    if (idx >= 0) existing[idx] = run;
    else existing.push(run);
    this.runs.set(wfId, existing);
    return Promise.resolve();
  }
  nextId(): WorkflowRunId {
    return createWorkflowRunId(crypto.randomUUID());
  }
  getPath(wfId: WorkflowId, runId: WorkflowRunId): string {
    return `workflows/workflow-${wfId}/workflow-run-${runId}.yaml`;
  }
  deleteAllByWorkflowId(wfId: WorkflowId): Promise<number> {
    const runs = this.runs.get(wfId) ?? [];
    this.runs.delete(wfId);
    return Promise.resolve(runs.length);
  }
}

/**
 * Creates a fake execution service whose run() yields a predetermined
 * sequence of events.
 */
function createFakeService(events: WorkflowExecutionEvent[]) {
  return {
    async *run(
      _idOrName: string,
      _options?: Record<string, unknown>,
    ): AsyncGenerator<WorkflowExecutionEvent> {
      for (const event of events) {
        yield event;
      }
    },
    execute(): Promise<WorkflowRun> {
      throw new Error("not implemented");
    },
  };
}

function createTestWorkflow(): Workflow {
  return Workflow.create({
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

function createTestDeps(
  workflow: Workflow | null,
  events: WorkflowExecutionEvent[],
): WorkflowRunDeps {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();

  return {
    workflowRepo,
    runRepo,
    repoDir: "/tmp/test",
    lookupWorkflow: (_repo, _idOrName) => Promise.resolve(workflow),
    // deno-lint-ignore no-explicit-any
    createExecutionService: () => createFakeService(events) as any,
  };
}

// --- Tests ---

Deno.test("workflowRun yields validating_inputs and evaluating_workflow prefix events", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      step: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { step: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  assertEquals(events[0].step, "validating_inputs");
  assertEquals(events[1].step, "evaluating_workflow");
  assertEquals(events[2].step, "started");
});

Deno.test("workflowRun yields error for missing workflow", async () => {
  const deps = createTestDeps(null, []);
  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "nonexistent",
  }));

  const last = events[events.length - 1];
  assertEquals(last.step, "error");
  if (last.step === "error") {
    assertEquals(last.error.code, "workflow_not_found");
  }
});

Deno.test("workflowRun forwards job and step events", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      step: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { step: "job_started", jobId: "job1" },
    { step: "step_started", jobId: "job1", stepId: "step1" },
    { step: "step_completed", jobId: "job1", stepId: "step1" },
    { step: "job_completed", jobId: "job1", status: "succeeded" },
    { step: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const steps = events.map((e) => e.step);
  assertEquals(steps.includes("job_started"), true);
  assertEquals(steps.includes("step_started"), true);
  assertEquals(steps.includes("step_completed"), true);
  assertEquals(steps.includes("job_completed"), true);
  assertEquals(steps.includes("completed"), true);
});

Deno.test("workflowRun completed event contains WorkflowRunData", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      step: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { step: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const completed = events.find((e) => e.step === "completed");
  assertEquals(completed?.step, "completed");
  if (completed?.step === "completed") {
    assertEquals(completed.run.workflowName, "test-workflow");
    assertEquals(typeof completed.run.id, "string");
  }
});

Deno.test("workflowNotFound returns correct error", () => {
  const error = workflowNotFound("my-wf");
  assertEquals(error.code, "workflow_not_found");
  assertEquals(error.message, "Workflow not found: my-wf");
});

Deno.test("workflowExecutionFailed wraps error", () => {
  const error = workflowExecutionFailed(new Error("boom"));
  assertEquals(error.code, "workflow_execution_failed");
  assertEquals(error.message, "Workflow execution failed: boom");
  assertEquals(error.cause?.message, "boom");
});

Deno.test("toRunData converts WorkflowRun to data shape", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const data = toRunData(run, "/some/path", false);
  assertEquals(data.workflowName, "test-workflow");
  assertEquals(data.path, "/some/path");
  assertEquals(data.jobs.length, 1);
  assertEquals(data.jobs[0].name, "job1");
});

Deno.test("extractStepArtifacts returns undefined for no output", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  const step = run.getJob("job1")!.getStep("step1")!;
  assertEquals(extractStepArtifacts(step), undefined);
});
