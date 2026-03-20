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
  inputValidationFailed,
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
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  assertEquals(events[0].kind, "validating_inputs");
  assertEquals(events[1].kind, "evaluating_workflow");
  assertEquals(events[2].kind, "started");
});

Deno.test("workflowRun yields error for missing workflow", async () => {
  const deps = createTestDeps(null, []);
  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "nonexistent",
  }));

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
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
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    { kind: "step_completed", jobId: "job1", stepId: "step1" },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const steps = events.map((e) => e.kind);
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
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
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

// --- Input coercion and validation tests ---

/**
 * Creates a fake execution service that captures the options passed to run().
 */
function createCapturingFakeService(
  events: WorkflowExecutionEvent[],
  captured: { options?: Record<string, unknown> },
) {
  return {
    async *run(
      _idOrName: string,
      options?: Record<string, unknown>,
    ): AsyncGenerator<WorkflowExecutionEvent> {
      captured.options = options;
      for (const event of events) {
        yield event;
      }
    },
    execute(): Promise<WorkflowRun> {
      throw new Error("not implemented");
    },
  };
}

function createTestDepsWithCapture(
  workflow: Workflow | null,
  events: WorkflowExecutionEvent[],
  captured: { options?: Record<string, unknown> },
): WorkflowRunDeps {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();

  return {
    workflowRepo,
    runRepo,
    repoDir: "/tmp/test",
    lookupWorkflow: (_repo, _idOrName) => Promise.resolve(workflow),
    createExecutionService: () =>
      // deno-lint-ignore no-explicit-any
      createCapturingFakeService(events, captured) as any,
  };
}

Deno.test("workflowRun coerces string inputs to match schema types", async () => {
  const workflow = Workflow.create({
    name: "coerce-wf",
    inputs: {
      properties: {
        count: { type: "number" },
      },
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({ name: "step1", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const captured: { options?: Record<string, unknown> } = {};
  const deps = createTestDepsWithCapture(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "coerce-wf",
      logPath: "/tmp/log",
    },
    { kind: "completed", run },
  ], captured);

  const ctx = createLibSwampContext();
  await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "coerce-wf",
    inputs: { count: "42" },
  }));

  assertEquals(captured.options?.inputs, { count: 42 });
});

Deno.test("workflowRun yields error for missing required input", async () => {
  const workflow = Workflow.create({
    name: "required-wf",
    inputs: {
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({ name: "step1", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });

  const deps = createTestDeps(workflow, []);
  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "required-wf",
    inputs: {},
  }));

  const steps = events.map((e) => e.kind);
  assertEquals(steps.includes("evaluating_workflow"), false);

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "input_validation_failed");
  }
});

Deno.test("workflowRun applies default values from schema", async () => {
  const workflow = Workflow.create({
    name: "defaults-wf",
    inputs: {
      properties: {
        region: { type: "string", default: "us-east-1" },
      },
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({ name: "step1", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const captured: { options?: Record<string, unknown> } = {};
  const deps = createTestDepsWithCapture(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "defaults-wf",
      logPath: "/tmp/log",
    },
    { kind: "completed", run },
  ], captured);

  const ctx = createLibSwampContext();
  await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "defaults-wf",
    inputs: {},
  }));

  assertEquals(captured.options?.inputs, { region: "us-east-1" });
});

Deno.test("workflowRun with lastEvaluated skips validation but still coerces", async () => {
  const workflow = Workflow.create({
    name: "last-eval-wf",
    inputs: {
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({ name: "step1", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const captured: { options?: Record<string, unknown> } = {};
  // Empty inputs would fail validation, but lastEvaluated skips it
  const deps = createTestDepsWithCapture(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "last-eval-wf",
      logPath: "/tmp/log",
    },
    { kind: "completed", run },
  ], captured);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "last-eval-wf",
    lastEvaluated: true,
    inputs: { count: "7" },
  }));

  // Should not error — validation was skipped
  const steps = events.map((e) => e.kind);
  assertEquals(steps.includes("error"), false);
  assertEquals(steps.includes("evaluating_workflow"), true);
  // But coercion should still apply
  assertEquals(captured.options?.inputs, { count: 7 });
});

Deno.test("workflowRun forwards model_resolved, method_executing, and method_output events", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "model_resolved",
      jobId: "job1",
      stepId: "step1",
      modelName: "my-model",
      modelType: "command/shell",
      methodName: "run",
    },
    {
      kind: "method_executing",
      jobId: "job1",
      stepId: "step1",
      modelName: "my-model",
      methodName: "run",
    },
    {
      kind: "method_output",
      jobId: "job1",
      stepId: "step1",
      modelName: "my-model",
      methodName: "run",
      stream: "stdout" as const,
      line: "hello",
    },
    { kind: "step_completed", jobId: "job1", stepId: "step1" },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const steps = events.map((e) => e.kind);
  assertEquals(steps.includes("model_resolved"), true);
  assertEquals(steps.includes("method_executing"), true);
  assertEquals(steps.includes("method_output"), true);

  const modelResolved = events.find((e) => e.kind === "model_resolved");
  if (modelResolved?.kind === "model_resolved") {
    assertEquals(modelResolved.modelName, "my-model");
    assertEquals(modelResolved.modelType, "command/shell");
    assertEquals(modelResolved.methodName, "run");
  }
});

Deno.test("workflowRun forwards method_event events", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "method_event",
      jobId: "job1",
      stepId: "step1",
      modelName: "my-model",
      methodName: "create",
      event: {
        type: "vault_secret_stored" as const,
        fieldPath: "password",
        vaultName: "default",
        vaultKey: "my-key",
      },
    },
    { kind: "step_completed", jobId: "job1", stepId: "step1" },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const steps = events.map((e) => e.kind);
  assertEquals(steps.includes("method_event"), true);

  const methodEvent = events.find((e) => e.kind === "method_event");
  if (methodEvent?.kind === "method_event") {
    assertEquals(methodEvent.modelName, "my-model");
    assertEquals(methodEvent.event.type, "vault_secret_stored");
    if (methodEvent.event.type === "vault_secret_stored") {
      assertEquals(methodEvent.event.fieldPath, "password");
      assertEquals(methodEvent.event.vaultName, "default");
    }
  }
});

Deno.test("inputValidationFailed returns correct error structure", () => {
  const error = inputValidationFailed([
    { path: "name", message: "name is required" },
  ]);
  assertEquals(error.code, "input_validation_failed");
  assertEquals(error.message, "Input validation failed:\n  name is required");
});

// --- Report event collection tests ---

Deno.test("workflowRun collects report_completed events from execution service", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "model_resolved",
      jobId: "job1",
      stepId: "step1",
      modelName: "my-model",
      modelType: "command/shell",
      methodName: "run",
    },
    {
      kind: "report_started",
      reportName: "test-report",
      scope: "method",
    },
    {
      kind: "report_completed",
      reportName: "test-report",
      scope: "method",
      markdown: "# Report",
      json: { status: "ok" },
    },
    { kind: "step_completed", jobId: "job1", stepId: "step1" },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  // Report events should be forwarded
  const reportStarted = events.find((e) => e.kind === "report_started");
  assertEquals(reportStarted?.kind, "report_started");
  if (reportStarted?.kind === "report_started") {
    assertEquals(reportStarted.reportName, "test-report");
  }

  const reportCompleted = events.find((e) => e.kind === "report_completed");
  assertEquals(reportCompleted?.kind, "report_completed");
  if (reportCompleted?.kind === "report_completed") {
    assertEquals(reportCompleted.reportName, "test-report");
    assertEquals(reportCompleted.markdown, "# Report");
  }

  // Completed event should include per-step report results
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.reports?.length, 1);
    assertEquals(completed.run.reports![0].name, "test-report");
    assertEquals(completed.run.reports![0].success, true);
  }
});

Deno.test("workflowRun collects report_failed events from execution service", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [
    {
      kind: "started",
      runId: run.id,
      workflowName: "test-workflow",
      logPath: "/tmp/log",
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "report_failed",
      reportName: "broken-report",
      scope: "method",
      error: "report crashed",
    },
    { kind: "step_completed", jobId: "job1", stepId: "step1" },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  // Report failed event should be forwarded
  const reportFailed = events.find((e) => e.kind === "report_failed");
  assertEquals(reportFailed?.kind, "report_failed");
  if (reportFailed?.kind === "report_failed") {
    assertEquals(reportFailed.reportName, "broken-report");
    assertEquals(reportFailed.error, "report crashed");
  }

  // Completed event should include the failed report result
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.reports?.length, 1);
    assertEquals(completed.run.reports![0].name, "broken-report");
    assertEquals(completed.run.reports![0].success, false);
    assertEquals(completed.run.reports![0].error, "report crashed");
  }
});

// --- Cancellation tests ---

Deno.test("workflowRun yields cancelled error when abort signal fires during execution", async () => {
  const workflow = createTestWorkflow();
  const controller = new AbortController();

  // Create a service that aborts mid-stream
  const deps: WorkflowRunDeps = {
    ...createTestDeps(workflow, []),
    createExecutionService: () =>
      ({
        // deno-lint-ignore require-yield
        async *run() {
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        },
        execute(): Promise<WorkflowRun> {
          throw new Error("not implemented");
        },
        // deno-lint-ignore no-explicit-any
      }) as any,
  };

  const ctx = createLibSwampContext({ signal: controller.signal });
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "cancelled");
  }
});

Deno.test("workflowRun yields cancelled error when signal is pre-aborted", async () => {
  const workflow = createTestWorkflow();
  const controller = new AbortController();
  controller.abort();

  // Service throws AbortError immediately
  const deps: WorkflowRunDeps = {
    ...createTestDeps(workflow, []),
    createExecutionService: () =>
      ({
        // deno-lint-ignore require-yield
        async *run() {
          throw new DOMException("The operation was aborted.", "AbortError");
        },
        execute(): Promise<WorkflowRun> {
          throw new Error("not implemented");
        },
        // deno-lint-ignore no-explicit-any
      }) as any,
  };

  const ctx = createLibSwampContext({ signal: controller.signal });
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "cancelled");
  }
});
