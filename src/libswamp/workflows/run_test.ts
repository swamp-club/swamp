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

import type { StepStart } from "../../domain/workflows/step_start.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  deferCompletedForOutputs,
  extractStepArtifacts,
  inputValidationFailed,
  mapWorkflowExecutionEvent,
  resolveCompletedRunOutputs,
  resolveRunStepOutputs,
  RunAttributeBudget,
  type RunStepOutputs,
  toRunData,
  withRunStepOutputs,
  workflowExecutionFailed,
  workflowNotFound,
  workflowRun,
  type WorkflowRunDeps,
} from "./run.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { join } from "@std/path";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { unclaimedRuns } from "../../domain/workflows/run_claim.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { RunSensitiveValues } from "../../domain/secrets/run_sensitive_values.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { StepOutputResolver } from "../../domain/workflows/step_output_resolver.ts";
import type { WorkflowExecutionEvent } from "../../domain/workflows/execution_service.ts";
import type { DataHandle } from "../../domain/models/model.ts";
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
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import { createNamespace } from "../../domain/data/namespace.ts";
import { UserError } from "../../domain/errors.ts";
import { UNREADABLE_CONTENT_CODE } from "../../domain/datastore/unreadable_content.ts";

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
  recordsAreForwarded = false;
  private runs = new Map<string, WorkflowRun[]>();

  findStepStarts(): Promise<StepStart[]> {
    return Promise.resolve([]);
  }

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
  async findAllGlobalSince(
    cutoff: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    const all = await this.findAllGlobal();
    return all.filter(({ run }) =>
      run.startedAt !== undefined && run.startedAt >= cutoff
    );
  }
  async findGlobalByStatus(
    status: string | string[],
    since?: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    const statuses = new Set(Array.isArray(status) ? status : [status]);
    const all = await this.findAllGlobal();
    return all.filter(({ run }) => {
      if (!statuses.has(run.status)) return false;
      if (since !== undefined) {
        if (run.startedAt === undefined || run.startedAt < since) return false;
      }
      return true;
    });
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
  deleteOlderThan(
    _cutoff: Date,
    _options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }> {
    return Promise.resolve({ deleted: 0, bytesReclaimed: 0 });
  }
}

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
  const catalogStore = new CatalogStore(":memory:");

  return {
    workflowRepo,
    runRepo,
    repoDir: "/tmp/test",
    catalogStore,
    lookupWorkflow: (_repo, _idOrName) => Promise.resolve(workflow),
    createExecutionService: (_wr, _rr, _rd, _cs) =>
      // deno-lint-ignore no-explicit-any
      createFakeService(events) as any,
  };
}

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
      jobs: [],
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

Deno.test("workflowRun surfaces the parse error for a schema-rejected workflow file", async () => {
  // a schema-rejected workflow file misses the repository lookup; run must
  // report the parse error rather than not found
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await Deno.mkdir(join(repoDir, "workflows"));
    await Deno.writeTextFile(
      join(
        repoDir,
        "workflows",
        "workflow-74ae52ba-5f3f-4937-a4fd-c1de950572e7.yaml",
      ),
      `
id: 74ae52ba-5f3f-4937-a4fd-c1de950572e7
name: broken-unknown-key
jobs:
  - name: placed
    environmnet: prod
    steps:
      - name: echo
        task:
          type: model_method
          modelIdOrName: fb28-probe
          methodName: execute
`,
    );

    const deps = { ...createTestDeps(null, []), repoDir };
    const ctx = createLibSwampContext();
    const events = await collect(workflowRun(ctx, deps, {
      workflowIdOrName: "broken-unknown-key",
    }));

    const last = events[events.length - 1];
    assertEquals(last.kind, "error");
    if (last.kind === "error") {
      assertEquals(last.error.code, "workflow_load_failed");
      assertStringIncludes(last.error.message, "Unknown key 'environmnet'");
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

const MISNAMED_WORKFLOW = `
id: 550e8400-e29b-41d4-a716-446655440000
name: plain
jobs:
  - name: main
    steps:
      - name: step1
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: run
`;

Deno.test("workflowRun names a misnamed file that declares the workflow (swamp-club#3839)", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await Deno.mkdir(join(repoDir, "workflows"));
    await Deno.writeTextFile(
      join(repoDir, "workflows", "plain.yaml"),
      MISNAMED_WORKFLOW,
    );

    const deps = { ...createTestDeps(null, []), repoDir };
    const ctx = createLibSwampContext();
    const events = await collect(workflowRun(ctx, deps, {
      workflowIdOrName: "plain",
    }));

    const last = events[events.length - 1];
    assertEquals(last.kind, "error");
    if (last.kind === "error") {
      assertEquals(last.error.code, "workflow_not_found");
      assertStringIncludes(
        last.error.message,
        "Workflow not found: plain.\nNot loaded: swamp only reads files " +
          "named workflow-<name>.yaml in the workflows directory. " +
          "Rename plain.yaml to workflow-<name>.yaml",
      );
      assertEquals(last.error.message.includes(repoDir), false);
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("workflowRun reports a broken workflow file before a misnamed one", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await Deno.mkdir(join(repoDir, "workflows"));
    await Deno.writeTextFile(
      join(repoDir, "workflows", "plain.yaml"),
      MISNAMED_WORKFLOW,
    );
    await Deno.writeTextFile(
      join(repoDir, "workflows", "workflow-plain.yaml"),
      MISNAMED_WORKFLOW.replace(
        "  - name: main\n",
        "  - name: main\n    environmnet: prod\n",
      ),
    );

    const deps = { ...createTestDeps(null, []), repoDir };
    const ctx = createLibSwampContext();
    const events = await collect(workflowRun(ctx, deps, {
      workflowIdOrName: "plain",
    }));

    const last = events[events.length - 1];
    assertEquals(last.kind, "error");
    if (last.kind === "error") {
      assertEquals(last.error.code, "workflow_load_failed");
      assertStringIncludes(last.error.message, "Unknown key 'environmnet'");
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("workflowRun by id ignores a misnamed file whose name does not match the expected name", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await Deno.mkdir(join(repoDir, "workflows"));
    await Deno.writeTextFile(
      join(repoDir, "workflows", "plain.yaml"),
      MISNAMED_WORKFLOW,
    );

    const deps = { ...createTestDeps(null, []), repoDir };
    const ctx = createLibSwampContext();
    const events = await collect(workflowRun(ctx, deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
      byId: true,
      expectedName: "other",
    }));

    const last = events[events.length - 1];
    assertEquals(last.kind, "error");
    if (last.kind === "error") {
      assertEquals(last.error.code, "workflow_not_found");
      assertEquals(last.error.message.includes("Not loaded"), false);
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
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
      jobs: [],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
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

Deno.test("workflowRun started event includes jobs array from domain event", async () => {
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
      jobs: [
        { id: "job1", stepCount: 2, dependsOn: [] },
        { id: "job2", stepCount: 1, dependsOn: ["job1"] },
      ],
    },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const started = events.find((e) => e.kind === "started");
  assertEquals(started?.kind, "started");
  if (started?.kind === "started") {
    assertEquals(started.jobs.length, 2);
    assertEquals(started.jobs[0].id, "job1");
    assertEquals(started.jobs[0].stepCount, 2);
    assertEquals(started.jobs[0].dependsOn, []);
    assertEquals(started.jobs[1].id, "job2");
    assertEquals(started.jobs[1].dependsOn, ["job1"]);
  }
});

Deno.test("workflowRun passes through report event jobId and stepId", async () => {
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
      jobs: [],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "report_completed",
      reportName: "@swamp/method-summary",
      scope: "method",
      markdown: "# Summary",
      json: {},
      jobId: "job1",
      stepId: "step1",
    },
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const reportEvent = events.find((e) => e.kind === "report_completed");
  assertEquals(reportEvent?.kind, "report_completed");
  if (reportEvent?.kind === "report_completed") {
    assertEquals(reportEvent.jobId, "job1");
    assertEquals(reportEvent.stepId, "step1");
  }
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
      jobs: [],
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
  assertEquals(
    error.message,
    "Workflow not found: my-wf.\n" +
      "Create it with 'swamp workflow create my-wf', " +
      "or run 'swamp doctor workflows --json' to check for broken workflow files",
  );
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

Deno.test("toRunData: includes startedAt and completedAt timestamps", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("step1")!;
  step.start();
  step.succeed();
  job.succeed();
  run.complete();

  const data = toRunData(run, "/some/path", false);
  assertEquals(typeof data.startedAt, "string");
  assertEquals(typeof data.completedAt, "string");
  assertEquals(typeof data.jobs[0].startedAt, "string");
  assertEquals(typeof data.jobs[0].completedAt, "string");
  assertEquals(typeof data.jobs[0].steps[0].startedAt, "string");
  assertEquals(typeof data.jobs[0].steps[0].completedAt, "string");
  assertEquals(typeof data.jobs[0].steps[0].duration, "number");
});

Deno.test("toRunData: maps approved approval decision", () => {
  const workflow = Workflow.create({
    name: "approval-wf",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Please approve"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("gate")!;
  step.start();
  step.recordApprovalDecision({
    approved: true,
    decidedBy: "user:abc123",
    decidedAt: "2026-09-10T02:18:20.696Z",
  });
  step.succeed();
  job.succeed();
  run.complete();

  const data = toRunData(run);
  const stepView = data.jobs[0].steps[0];
  assertEquals(stepView.approval?.status, "approved");
  assertEquals(stepView.approval?.approvedBy, "user:abc123");
  assertEquals(stepView.approval?.approvedAt, "2026-09-10T02:18:20.696Z");
  assertEquals(typeof stepView.approval?.approvalDuration, "number");
});

Deno.test("toRunData: carries the client of the run and of a decision, only when recorded", () => {
  const workflow = Workflow.create({
    name: "client-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(
    workflow,
    {},
    "user:alice",
    "api",
    "integration:ops-slack",
  );
  run.getJob("main")!.getStep("gate")!.recordApprovalDecision({
    approved: true,
    decidedBy: "user:bob",
    client: "direct:cli",
    decidedAt: "2026-09-10T02:18:20.696Z",
  });
  const data = toRunData(run);
  assertEquals(data.client, "integration:ops-slack");
  assertEquals(data.jobs[0].steps[0].approval?.client, "direct:cli");

  const plain = toRunData(WorkflowRun.create(workflow));
  assertEquals("client" in plain, false);
});

Deno.test("toRunData: maps rejected approval decision", () => {
  const workflow = Workflow.create({
    name: "reject-wf",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Please approve"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("gate")!;
  step.start();
  step.recordApprovalDecision({
    approved: false,
    reason: "Needs review",
    decidedBy: "user:xyz789",
    decidedAt: "2026-09-10T02:20:00.000Z",
  });
  step.fail("Approval rejected");
  job.fail();
  run.complete();

  const data = toRunData(run);
  const stepView = data.jobs[0].steps[0];
  assertEquals(stepView.approval?.status, "rejected");
  assertEquals(stepView.approval?.rejectedBy, "user:xyz789");
  assertEquals(stepView.approval?.reason, "Needs review");
});

Deno.test("toRunData: step without approval has no approval field", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const data = toRunData(run);
  assertEquals(data.jobs[0].steps[0].approval, undefined);
});

Deno.test("toRunData: a failed step carries its error code only when it has one (swamp-club#3748)", () => {
  for (const code of ["deployment_refused", undefined]) {
    const run = WorkflowRun.create(createTestWorkflow());
    run.start();
    const step = run.getJob("job1")!.getStep("step1")!;
    step.start();
    step.fail("deploy refused", code);

    const data = toRunData(run);
    const stepData = data.jobs[0].steps[0];
    assertEquals(stepData.error, "deploy refused");
    assertEquals(stepData.errorCode, code);
    assertEquals(Object.hasOwn(stepData, "errorCode"), code !== undefined);
  }
});

function createModelMethodRun(): WorkflowRun {
  const run = WorkflowRun.create(createTestWorkflow());
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("step1")!;
  step.start();
  step.addDataArtifact({
    dataId: "data-audience",
    name: "audience",
    version: 1,
    tags: {},
  });
  step.addDataArtifact({
    dataId: "data-log",
    name: "log",
    version: 1,
    tags: {},
  });
  step.succeed({
    type: "model_method",
    model: "test-model",
    method: "run",
    resources: {
      result: {
        audience: {
          id: "data-audience",
          name: "audience",
          version: 1,
          modelType: "test/model",
          modelId: "model-1",
          contentType: "application/json",
          tags: {},
          attributes: null,
          content: null,
        },
      },
    },
  });
  job.succeed();
  run.complete();
  return run;
}

const AUDIENCE_OUTPUTS: RunStepOutputs = {
  job1: {
    step1: {
      outputs: { audienceId: "aud_123", status: "Building" },
      attributesByDataId: {
        "data-audience": { audienceId: "aud_123", status: "Building" },
      },
    },
  },
};

Deno.test("toRunData: includes step outputs from the resolved step outputs", () => {
  const data = toRunData(
    createModelMethodRun(),
    undefined,
    false,
    AUDIENCE_OUTPUTS,
  );

  const stepView = data.jobs[0].steps[0];
  assertEquals(stepView.outputs, { audienceId: "aud_123", status: "Building" });
});

Deno.test("toRunData: attaches attributes only to the artifact they came from", () => {
  const data = toRunData(
    createModelMethodRun(),
    undefined,
    true,
    AUDIENCE_OUTPUTS,
  );

  const stepView = data.jobs[0].steps[0];
  const byName = Object.fromEntries(
    stepView.dataArtifacts!.map((a) => [a.name, a.attributes]),
  );
  assertEquals(byName.audience, { audienceId: "aud_123", status: "Building" });
  assertEquals(byName.log, undefined);
  assertEquals(stepView.artifacts?.dataAttributes, {
    audienceId: "aud_123",
    status: "Building",
  });
});

Deno.test("toRunData: without resolved outputs a model_method step shows none", () => {
  const data = toRunData(createModelMethodRun(), undefined, true);

  const stepView = data.jobs[0].steps[0];
  assertEquals(stepView.outputs, undefined);
  assertEquals(stepView.artifacts, undefined);
  assertEquals(stepView.dataArtifacts?.[0].attributes, undefined);
});

Deno.test("toRunData: includes workflow child step outputs namespaced by step", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("step1")!;
  step.start();
  step.succeed({
    type: "workflow",
    workflow: "child-wf",
    workflowId: "child-wf-id",
    runId: "child-run-123",
    status: "succeeded",
  });
  job.succeed();
  run.complete();

  const data = toRunData(run, undefined, false, {
    job1: {
      step1: {
        outputs: {
          "create-audience": { audienceId: "aud_456", name: "test-audience" },
        },
        attributesByDataId: {},
      },
    },
  });
  const stepView = data.jobs[0].steps[0];
  const childOutputs = stepView.outputs as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(childOutputs["create-audience"].audienceId, "aud_456");
  assertEquals(childOutputs["create-audience"].name, "test-audience");
});

Deno.test("resolveRunStepOutputs: resolves every step keyed by job and step", async () => {
  const run = createModelMethodRun();
  const resolver = new StepOutputResolver({
    readAttributes: (ref) =>
      Promise.resolve(
        ref.name === "audience" ? { audienceId: "aud_123" } : undefined,
      ),
  });

  const resolved = await resolveRunStepOutputs(run, resolver);

  assertEquals(resolved.job1.step1.outputs, { audienceId: "aud_123" });
  assertEquals(resolved.job1.step1.attributesByDataId, {
    "data-audience": { audienceId: "aud_123" },
  });
});

Deno.test("toRunData: includes references on run", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.setReferences({
    jiraTicket: "DNA-5570",
    prUrl: "https://github.com/example/pull/21",
  });
  run.start();
  run.complete();

  const data = toRunData(run);
  assertEquals(data.references?.jiraTicket, "DNA-5570");
  assertEquals(data.references?.prUrl, "https://github.com/example/pull/21");
});

Deno.test("toRunData: run without references has no references field", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const data = toRunData(run);
  assertEquals(data.references, undefined);
});

Deno.test("toRunData: step without model method output has no outputs", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("step1")!;
  step.start();
  step.succeed();
  job.succeed();
  run.complete();

  const data = toRunData(run);
  assertEquals(data.jobs[0].steps[0].outputs, undefined);
});

Deno.test("extractStepArtifacts returns undefined for no output", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  const step = run.getJob("job1")!.getStep("step1")!;
  assertEquals(extractStepArtifacts(step), undefined);
});

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
  const catalogStore = new CatalogStore(":memory:");

  return {
    workflowRepo,
    runRepo,
    repoDir: "/tmp/test",
    catalogStore,
    lookupWorkflow: (_repo, _idOrName) => Promise.resolve(workflow),
    createExecutionService: (_wr, _rr, _rd, _cs) =>
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
      jobs: [],
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
      jobs: [],
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
      jobs: [],
    },
    { kind: "completed", run },
  ], captured);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "last-eval-wf",
    lastEvaluated: true,
    inputs: { count: "7" },
  }));

  const steps = events.map((e) => e.kind);
  assertEquals(steps.includes("error"), false);
  assertEquals(steps.includes("evaluating_workflow"), true);
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
      jobs: [],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "model_resolved",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
      modelName: "my-model",
      modelType: "command/shell",
      modelId: "test-model-id",
      methodName: "run",
    },
    {
      kind: "method_executing",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
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
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
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
      jobs: [],
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
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
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
      jobs: [],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "model_resolved",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
      modelName: "my-model",
      modelType: "command/shell",
      modelId: "test-model-id",
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
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

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
      jobs: [],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    {
      kind: "report_failed",
      reportName: "broken-report",
      scope: "method",
      error: "report crashed",
    },
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const reportFailed = events.find((e) => e.kind === "report_failed");
  assertEquals(reportFailed?.kind, "report_failed");
  if (reportFailed?.kind === "report_failed") {
    assertEquals(reportFailed.reportName, "broken-report");
    assertEquals(reportFailed.error, "report crashed");
  }

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.reports?.length, 1);
    assertEquals(completed.run.reports![0].name, "broken-report");
    assertEquals(completed.run.reports![0].success, false);
    assertEquals(completed.run.reports![0].error, "report crashed");
  }
});

Deno.test("workflowRun keeps an empty-markdown report in the completed run's reports", async () => {
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
      jobs: [],
    },
    { kind: "job_started", jobId: "job1" },
    { kind: "step_started", jobId: "job1", stepId: "step1" },
    { kind: "report_started", reportName: "quiet-report", scope: "method" },
    {
      kind: "report_completed",
      reportName: "quiet-report",
      scope: "method",
      markdown: "",
      json: {},
    },
    {
      kind: "step_completed",
      jobId: "job1",
      stepId: "step1",
      runId: run.id,
    },
    { kind: "job_completed", jobId: "job1", status: "succeeded" },
    { kind: "completed", run },
  ]);

  const events = await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: "test-workflow",
  }));

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected a completed event");
  }
  assertEquals(completed.run.reports, [{
    name: "quiet-report",
    scope: "method",
    success: true,
    markdown: "",
    json: {},
  }]);
});

Deno.test("workflowRun yields cancelled error when abort signal fires during execution", async () => {
  const workflow = createTestWorkflow();
  const controller = new AbortController();

  const deps: WorkflowRunDeps = {
    ...createTestDeps(workflow, []),
    createExecutionService: (_wr, _rr, _rd, _cs) =>
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

  const deps: WorkflowRunDeps = {
    ...createTestDeps(workflow, []),
    createExecutionService: (_wr, _rr, _rd, _cs) =>
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

Deno.test("workflowRun bridge finalizes in-flight invocations when execution service throws mid-stream", async () => {
  // If the execution service throws after method_executing but before a
  // terminal step event, the bridge must drain the invocation as an error child
  // entry.
  const workflow = createTestWorkflow();

  type RecordedCall = {
    methodName: string;
    error: Error | null;
    durationMs: number;
  };
  const recorded: RecordedCall[] = [];

  const deps: WorkflowRunDeps = {
    ...createTestDeps(workflow, []),
    createExecutionService: (_wr, _rr, _rd, _cs) =>
      ({
        async *run(): AsyncGenerator<WorkflowExecutionEvent> {
          yield {
            kind: "started",
            runId: "run-throw",
            workflowName: "test-workflow",
            logPath: "/tmp/log",
            jobs: [],
          };
          yield {
            kind: "method_executing",
            jobId: "job1",
            stepId: "step1",
            runId: "run-throw",
            modelName: "test-model",
            methodName: "run",
          };
          throw new Error("execution service crashed");
        },
        execute(): Promise<WorkflowRun> {
          throw new Error("not implemented");
        },
        // deno-lint-ignore no-explicit-any
      }) as any,
    telemetrySink: {
      parentInvocationId: "parent-throw",
      recordChildInvocation: (
        invocation,
        startedAt,
        completedAt,
        error,
      ) => {
        recorded.push({
          methodName: invocation.args[2],
          error,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        });
        return Promise.resolve();
      },
    },
  };

  const ctx = createLibSwampContext();
  const events = await collect(workflowRun(ctx, deps, {
    workflowIdOrName: "test-workflow",
  }));

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");

  assertEquals(recorded.length, 1);
  assertEquals(recorded[0].methodName, "run");
  assertStringIncludes(
    recorded[0].error!.message,
    "workflow run terminated before completion",
  );
  if (recorded[0].durationMs < 0 || Number.isNaN(recorded[0].durationMs)) {
    throw new Error(`unexpected durationMs: ${recorded[0].durationMs}`);
  }
});

Deno.test("workflowRun creates the ephemeral store in the data repo's namespace", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();

  const deps = createTestDeps(workflow, [{ kind: "completed", run }]);
  deps.dataRepo = {
    namespace: createNamespace("team-a"),
  } as unknown as UnifiedDataRepository;
  let ephemeralNamespace: string | undefined;
  const createService = deps.createExecutionService;
  deps.createExecutionService = (wr, rr, rd, cs, ephRepo, ephCatalog) => {
    ephemeralNamespace = ephRepo?.namespace;
    return createService(wr, rr, rd, cs, ephRepo, ephCatalog);
  };

  await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: "test-workflow",
  }));

  assertEquals(ephemeralNamespace, "team-a");
});

Deno.test("mapWorkflowExecutionEvent: keeps step_failed dataHandles off the published event", () => {
  const event: WorkflowExecutionEvent = {
    kind: "step_failed",
    jobId: "job1",
    stepId: "step1",
    runId: "run-1",
    error: "deploy blew up",
    errorCode: "deployment_refused",
    modelName: "failer",
    methodName: "run",
    dataHandles: [
      {
        name: "state",
        specName: "state",
        kind: "resource",
        dataId: "d-1",
        version: 1,
        size: 1,
        tags: {},
        metadata: { contentType: "application/json" },
      } as unknown as DataHandle,
    ],
  };

  const published = mapWorkflowExecutionEvent(
    event,
    new InMemoryWorkflowRunRepository(),
  );

  assertEquals(published, {
    kind: "step_failed",
    jobId: "job1",
    stepId: "step1",
    error: "deploy blew up",
    errorCode: "deployment_refused",
    modelName: "failer",
    methodName: "run",
  });
});

Deno.test("mapWorkflowExecutionEvent: keeps step_failed errorPaths off the published event (swamp-club#2830)", () => {
  const event: WorkflowExecutionEvent = {
    kind: "step_failed",
    jobId: "job1",
    stepId: "step1",
    runId: "run-1",
    error: "cannot read /srv/acme/final report",
    modelName: "failer",
    methodName: "run",
    errorPaths: ["/srv/acme/final report"],
  };

  const published = mapWorkflowExecutionEvent(
    event,
    new InMemoryWorkflowRunRepository(),
  );

  assertEquals(published, {
    kind: "step_failed",
    jobId: "job1",
    stepId: "step1",
    error: "cannot read /srv/acme/final report",
    modelName: "failer",
    methodName: "run",
  });
});

Deno.test("mapWorkflowExecutionEvent: carries a wait's key and a wait_key_held holder to the published events (swamp-club#3214)", () => {
  const repo = new InMemoryWorkflowRunRepository();
  const holder = {
    workflowId: "wf-1",
    workflowName: "kitchen",
    key: "verdict",
    runId: "run-0",
    stepName: "review",
    waitId: "wait-0",
  };
  assertEquals(
    mapWorkflowExecutionEvent({
      kind: "step_failed",
      jobId: "job1",
      stepId: "review",
      runId: "run-1",
      error: "wait_key_held",
      allowedFailure: true,
      waitKeyHolder: holder,
    }, repo),
    {
      kind: "step_failed",
      jobId: "job1",
      stepId: "review",
      error: "wait_key_held",
      allowedFailure: true,
      waitKeyHolder: holder,
    },
  );

  const requested: WorkflowExecutionEvent = {
    kind: "signal_wait_requested",
    runId: "run-1",
    workflowName: "kitchen",
    jobId: "job1",
    stepId: "review",
    waitId: "wait-1",
    deadline: "2026-01-01T00:05:00.000Z",
    key: "verdict",
  };
  assertEquals(mapWorkflowExecutionEvent(requested, repo), requested);

  const workflow = Workflow.create({
    name: "kitchen",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(300, { type: "object" }, "verdict"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  const nested = {
    workflowId: "wf-2",
    workflowName: "child",
    runId: "run-2",
    jobId: "job1",
    stepId: "review",
    waitId: "wait-2",
    deadline: "2026-01-01T00:05:00.000Z",
    key: "child-verdict",
  };
  const suspended = mapWorkflowExecutionEvent({
    kind: "suspended",
    run,
    jobId: "job1",
    stepId: "review",
    prompt: "",
    wait: {
      id: "wait-1",
      deadline: "2026-01-01T00:05:00.000Z",
      key: "verdict",
    },
    nestedSignalWaits: [nested],
  }, repo);
  if (suspended.kind !== "suspended") throw new Error(suspended.kind);
  assertEquals(suspended.wait?.key, "verdict");
  assertEquals(suspended.nestedSignalWaits, [nested]);
});

Deno.test("mapWorkflowExecutionEvent: carries a nested run's parentRunId on started and omits it at top level (swamp-club#2470)", () => {
  const started = (parentRunId?: string): WorkflowExecutionEvent => ({
    kind: "started",
    runId: "run-1",
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    workflowName: "wf",
    logPath: "/tmp/wf.log",
    jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
  });
  const repo = new InMemoryWorkflowRunRepository();

  assertEquals(mapWorkflowExecutionEvent(started("parent-1"), repo), {
    kind: "started",
    runId: "run-1",
    parentRunId: "parent-1",
    workflowName: "wf",
    jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
  });
  assertEquals(mapWorkflowExecutionEvent(started(), repo), {
    kind: "started",
    runId: "run-1",
    workflowName: "wf",
    jobs: [{ id: "main", stepCount: 1, dependsOn: [] }],
  });
});

Deno.test("workflowRun: byId looks the workflow up by id only and passes byId to the execution service", async () => {
  const target = createTestWorkflow();
  const run = WorkflowRun.create(target);
  run.start();
  run.complete();

  const captured: { options?: Record<string, unknown> } = {};
  const calls: { idOrName?: string } = {};
  const deps = createTestDepsWithCapture(target, [], captured);
  await deps.workflowRepo.save(target);
  deps.lookupWorkflow = () => {
    throw new Error("name-first lookup must not be used with byId");
  };
  const service = createCapturingFakeService([
    {
      kind: "started",
      runId: run.id,
      workflowName: target.name,
      logPath: "/tmp/log",
      jobs: [],
    },
    { kind: "completed", run },
  ], captured);
  deps.createExecutionService = (_wr, _rr, _rd, _cs) =>
    ({
      ...service,
      run(idOrName: string, options?: Record<string, unknown>) {
        calls.idOrName = idOrName;
        return service.run(idOrName, options);
      },
    }) as unknown as ReturnType<WorkflowRunDeps["createExecutionService"]>;

  const events = await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: target.id,
    byId: true,
  }));

  assertEquals(events.at(-1)?.kind, "completed");
  assertEquals(calls.idOrName, target.id);
  assertEquals(captured.options?.byId, true);
});

Deno.test("workflowRun: byId does not fall back to the name-first lookup", async () => {
  const workflow = createTestWorkflow();
  let lookupCalls = 0;
  const deps = createTestDeps(workflow, []);
  await deps.workflowRepo.save(workflow);
  deps.lookupWorkflow = () => {
    lookupCalls++;
    return Promise.resolve(workflow);
  };

  const events = await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: workflow.name,
    byId: true,
  }));

  const last = events.at(-1);
  assertEquals(last?.kind, "error");
  if (last?.kind === "error") {
    assertEquals(last.error.code, "workflow_not_found");
  }
  assertEquals(lookupCalls, 0);
});

Deno.test("workflowRun: without byId uses the name-first lookup and passes no byId", async () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.complete();
  const captured: { options?: Record<string, unknown> } = {};
  const deps = createTestDepsWithCapture(workflow, [
    { kind: "completed", run },
  ], captured);
  const looked: string[] = [];
  deps.lookupWorkflow = (_repo, idOrName) => {
    looked.push(idOrName);
    return Promise.resolve(workflow);
  };

  await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: "test-workflow",
  }));

  assertEquals(looked, ["test-workflow"]);
  assertEquals(captured.options?.byId, undefined);
});

Deno.test("mapWorkflowExecutionEvent: keeps the owning run's id off published step events (swamp-club#2802)", () => {
  const repo = new InMemoryWorkflowRunRepository();
  const domainEvents: WorkflowExecutionEvent[] = [
    {
      kind: "model_resolved",
      runId: "child-run",
      jobId: "main",
      stepId: "a",
      modelName: "fast",
      modelType: "command/shell",
      modelId: "fast-id",
      methodName: "execute",
    },
    {
      kind: "method_executing",
      runId: "child-run",
      jobId: "main",
      stepId: "a",
      modelName: "fast",
      methodName: "execute",
    },
    {
      kind: "step_completed",
      runId: "child-run",
      jobId: "main",
      stepId: "a",
      executor: "loopback",
    },
  ];

  const published = domainEvents.map((e) => mapWorkflowExecutionEvent(e, repo));

  assertEquals(published, [
    {
      kind: "model_resolved",
      jobId: "main",
      stepId: "a",
      modelName: "fast",
      modelType: "command/shell",
      modelId: "fast-id",
      methodName: "execute",
    },
    {
      kind: "method_executing",
      jobId: "main",
      stepId: "a",
      modelName: "fast",
      methodName: "execute",
    },
    {
      kind: "step_completed",
      jobId: "main",
      stepId: "a",
      executor: "loopback",
    },
  ]);
});

Deno.test("workflowRun records a parent step and a concurrent same-named nested step separately (swamp-club#2802)", async () => {
  const workflow = createTestWorkflow();
  const recorded: string[] = [];

  const deps: WorkflowRunDeps = {
    ...createTestDeps(workflow, []),
    createExecutionService: (_wr, _rr, _rd, _cs) =>
      ({
        async *run(): AsyncGenerator<WorkflowExecutionEvent> {
          yield {
            kind: "started",
            runId: "parent-run",
            workflowName: "parent",
            logPath: "/tmp/log",
            jobs: [],
          };
          yield {
            kind: "method_executing",
            runId: "parent-run",
            jobId: "main",
            stepId: "a",
            modelName: "slow",
            methodName: "execute",
          };
          yield {
            kind: "started",
            runId: "child-run",
            parentRunId: "parent-run",
            workflowName: "child",
            logPath: "/tmp/log",
            jobs: [],
          };
          yield {
            kind: "method_executing",
            runId: "child-run",
            jobId: "main",
            stepId: "a",
            modelName: "fast",
            methodName: "ping",
          };
          yield {
            kind: "step_completed",
            runId: "child-run",
            jobId: "main",
            stepId: "a",
          };
          yield {
            kind: "step_completed",
            runId: "parent-run",
            jobId: "main",
            stepId: "a",
          };
        },
        execute(): Promise<WorkflowRun> {
          throw new Error("not implemented");
        },
        // deno-lint-ignore no-explicit-any
      }) as any,
    telemetrySink: {
      parentInvocationId: "parent-invocation",
      recordChildInvocation: (invocation, _startedAt, _completedAt, error) => {
        recorded.push(`${invocation.args[2]}:${error === null}`);
        return Promise.resolve();
      },
    },
  };

  const ctx = createLibSwampContext();
  await collect(workflowRun(ctx, deps, { workflowIdOrName: "test-workflow" }));

  assertEquals(recorded, ["ping:true", "execute:true"]);
});

Deno.test("workflowRun: a --last-evaluated cache that cannot be read is reported as an error, not thrown (swamp-club#3583)", async () => {
  const workflow = createTestWorkflow();
  const captured: { options?: Record<string, unknown> } = {};
  const deps = {
    ...createTestDepsWithCapture(workflow, [], captured),
    supersede: {
      findSuspendedRuns: () => Promise.resolve([]),
      findEvaluatedWorkflow: () => Promise.resolve(null),
      runClaims: unclaimedRuns,
      evaluatedCache: () => Promise.reject(new Error("corrupt cache")),
    },
  };

  const events = await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: workflow.name,
    lastEvaluated: true,
  }));

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
  assertEquals(
    error?.kind === "error" && error.error.message.includes("corrupt cache"),
    true,
  );
  assertEquals(
    events.map((e) => e.kind).includes("evaluating_workflow"),
    false,
  );
  assertEquals(captured.options, undefined);
});

Deno.test("workflowRun: a run cancelled while its suspended runs are read for superseding supersedes none and still goes to the execution service with its signal (swamp-club#4088)", async () => {
  const workflow = createTestWorkflow();
  const captured: { options?: Record<string, unknown> } = {};
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const deps = {
    ...createTestDepsWithCapture(workflow, [], captured),
    supersede: {
      // Cancelled with a reason that is not an AbortError, as a serve
      // shutdown may be, while the read waits for scan permits.
      findSuspendedRuns: (_id: WorkflowId, signal?: AbortSignal) => {
        signals.push(signal);
        controller.abort(new Error("serve is shutting down"));
        return Promise.reject(signal?.reason);
      },
      findEvaluatedWorkflow: () => Promise.resolve(null),
      runClaims: unclaimedRuns,
      evaluatedCache: () => Promise.resolve(null),
    },
  };

  const events = await collect(workflowRun(
    createLibSwampContext({ signal: controller.signal }),
    deps,
    { workflowIdOrName: workflow.name },
  ));

  assertEquals(signals, [controller.signal]);
  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.includes("superseded_runs"), false);
  assertEquals(kinds.includes("error"), false);
  // The execution service records a run cancelled before its first step as
  // cancelled; it is handed the aborted signal to do so.
  assertEquals(captured.options?.signal, controller.signal);
});

Deno.test("toRunData: inputs, a step error and assert text are shown through the run's mask, recorded values and a typed run's sentinels alike (typed-secrets 4.4)", () => {
  const workflow = Workflow.create({
    name: "masked-view",
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({ name: "s", task: StepTask.model("m", "run") }),
        Step.create({
          name: "a",
          task: StepTask.assert("true", "checked ${{ 1 }}"),
        }),
      ],
    })],
  });
  const run = WorkflowRun.create(workflow);
  const values = new RunSensitiveValues(
    undefined,
    new SecretBagRegistry(),
  );
  const sentinel = new VaultSecretBag(values.sentinels).addSecret(
    { vaultName: "v", key: "k" },
    "inputs.token",
  );
  values.addSecret("Pl41n-s3cret", { vaultName: "v", key: "p" });
  run.attachSensitiveValues(values);
  run.captureInputs({ token: `Bearer ${sentinel}`, note: "Pl41n-s3cret" });
  run.start();
  const s = run.getJob("main")!.getStep("s")!;
  s.start();
  s.fail(`rejected ${sentinel}`);
  const a = run.getJob("main")!.getStep("a")!;
  a.start();
  a.recordAssertResult({
    passed: false,
    expr: "true",
    message: `saw ${sentinel}`,
    severity: "high",
  });
  const view = toRunData(run);
  assertEquals(view.inputs, { token: "Bearer ***", note: "***" });
  assertEquals(view.jobs[0].steps[0].error, "rejected ***");
  assertEquals(view.jobs[0].steps[1].assertResult?.message, "saw ***");
  values.addSecret("false", { vaultName: "v", key: "f" });
  const again = toRunData(run).jobs[0].steps[1].assertResult!;
  assertEquals(again.passed, false);
  assertEquals(again.severity, "high");
  assertEquals(again.expr, "true");
  assertEquals(JSON.stringify(view).includes("__SWAMP_VSEC_"), false);
  assertEquals(JSON.stringify(view).includes("Pl41n-s3cret"), false);
  const plain = WorkflowRun.create(workflow);
  plain.captureInputs({ token: "plain" });
  assertEquals(toRunData(plain).inputs, { token: "plain" });
});

function audienceDataRepo(
  getContent: () => Promise<Uint8Array | null>,
): UnifiedDataRepository {
  return {
    namespace: createNamespace("team-a"),
    getContent,
  } as unknown as UnifiedDataRepository;
}

const AUDIENCE_JSON = new TextEncoder().encode(
  JSON.stringify({ audienceId: "aud_123", status: "Building" }),
);

Deno.test("mapWorkflowExecutionEvent: a completed event shows the resolved attributes and outputs it is given", () => {
  const repo = new InMemoryWorkflowRunRepository();
  const event: WorkflowExecutionEvent = {
    kind: "completed",
    run: createModelMethodRun(),
  };

  const withOutputs = mapWorkflowExecutionEvent(
    event,
    repo,
    undefined,
    AUDIENCE_OUTPUTS,
  );
  const without = mapWorkflowExecutionEvent(event, repo);

  if (withOutputs.kind !== "completed" || without.kind !== "completed") {
    throw new Error("expected completed events");
  }
  const step = withOutputs.run.jobs[0].steps[0];
  assertEquals(step.dataArtifacts?.[0].attributes, {
    audienceId: "aud_123",
    status: "Building",
  });
  assertEquals(step.outputs, { audienceId: "aud_123", status: "Building" });
  assertEquals(
    without.run.jobs[0].steps[0].dataArtifacts?.[0].attributes,
    undefined,
  );
  assertEquals(without.run.jobs[0].steps[0].outputs, undefined);
});

Deno.test("mapWorkflowExecutionEvent: a cancelled event ignores resolved outputs", () => {
  const mapped = mapWorkflowExecutionEvent(
    { kind: "cancelled", run: createModelMethodRun(), reason: "stopped" },
    new InMemoryWorkflowRunRepository(),
    undefined,
    AUDIENCE_OUTPUTS,
  );

  if (mapped.kind !== "cancelled") throw new Error("expected cancelled");
  assertEquals(
    mapped.run.jobs[0].steps[0].dataArtifacts?.[0].attributes,
    undefined,
  );
});

Deno.test("toRunData: data attributes and step outputs are shown through the run's mask", () => {
  const run = createModelMethodRun();
  const values = new RunSensitiveValues(undefined, new SecretBagRegistry());
  values.addSecret("aud_123", { vaultName: "v", key: "k" });
  run.attachSensitiveValues(values);

  const step = toRunData(run, undefined, false, AUDIENCE_OUTPUTS).jobs[0]
    .steps[0];

  assertEquals(step.dataArtifacts?.[0].attributes, {
    audienceId: "***",
    status: "Building",
  });
  assertEquals(step.outputs, { audienceId: "***", status: "Building" });
});

Deno.test("deferCompletedForOutputs: resolves the completed run only after the source has ended", async () => {
  const run = createModelMethodRun();
  let saved = false;
  const savedWhenResolved: boolean[] = [];
  async function* source(): AsyncGenerator<WorkflowExecutionEvent> {
    yield { kind: "job_started", jobId: "job1" };
    yield { kind: "completed", run };
    saved = true;
  }

  const seen: string[] = [];
  for await (
    const { event, stepOutputs } of deferCompletedForOutputs(
      source(),
      () => {
        savedWhenResolved.push(saved);
        return Promise.resolve(AUDIENCE_OUTPUTS);
      },
    )
  ) {
    seen.push(event.kind);
    if (event.kind === "job_started") {
      assertEquals(savedWhenResolved, []);
      assertEquals(stepOutputs, undefined);
    } else {
      assertEquals(stepOutputs, AUDIENCE_OUTPUTS);
    }
  }

  assertEquals(seen, ["job_started", "completed"]);
  assertEquals(savedWhenResolved, [true]);
});

Deno.test("deferCompletedForOutputs: a source that throws after completed yields completed first, then the error", async () => {
  const run = createModelMethodRun();
  async function* source(): AsyncGenerator<WorkflowExecutionEvent> {
    yield { kind: "completed", run };
    throw new Error("run stopped");
  }

  const seen: Array<{ kind: string; outputs: boolean }> = [];
  await assertRejects(
    async () => {
      for await (
        const { event, stepOutputs } of deferCompletedForOutputs(
          source(),
          () => Promise.resolve(AUDIENCE_OUTPUTS),
        )
      ) {
        seen.push({ kind: event.kind, outputs: stepOutputs !== undefined });
      }
    },
    Error,
    "run stopped",
  );

  assertEquals(seen, [{ kind: "completed", outputs: true }]);
});

Deno.test("deferCompletedForOutputs: a source that throws before completed never resolves", async () => {
  let resolved = 0;
  // deno-lint-ignore require-yield
  async function* source(): AsyncGenerator<WorkflowExecutionEvent> {
    throw new Error("no run");
  }

  await assertRejects(
    () =>
      Array.fromAsync(deferCompletedForOutputs(source(), () => {
        resolved++;
        return Promise.resolve(undefined);
      })),
    Error,
    "no run",
  );
  assertEquals(resolved, 0);
});

Deno.test("deferCompletedForOutputs: without a resolver the events pass through in order", async () => {
  const run = createModelMethodRun();
  async function* source(): AsyncGenerator<WorkflowExecutionEvent> {
    yield { kind: "completed", run };
    yield { kind: "job_started", jobId: "late" };
  }

  const seen = await Array.fromAsync(deferCompletedForOutputs(source()));

  assertEquals(seen.map((e) => e.event.kind), ["completed", "job_started"]);
  assertEquals(seen.every((e) => e.stepOutputs === undefined), true);
});

Deno.test("resolveCompletedRunOutputs: reads each resource's attributes keyed by its data id", async () => {
  const resolved = await resolveCompletedRunOutputs(
    createModelMethodRun(),
    audienceDataRepo(() => Promise.resolve(AUDIENCE_JSON)),
    new InMemoryWorkflowRunRepository(),
  );

  assertEquals(resolved?.job1.step1.attributesByDataId, {
    "data-audience": { audienceId: "aud_123", status: "Building" },
  });
});

Deno.test("resolveCompletedRunOutputs: a resource that cannot be read is left out", async () => {
  const resolved = await resolveCompletedRunOutputs(
    createModelMethodRun(),
    audienceDataRepo(() => Promise.reject(new Error("datastore offline"))),
    new InMemoryWorkflowRunRepository(),
  );

  assertEquals(resolved?.job1.step1.attributesByDataId, {});
});

Deno.test("resolveCompletedRunOutputs: a record the datastore cannot materialise gives no outputs instead of an error", async () => {
  const resolved = await resolveCompletedRunOutputs(
    createModelMethodRun(),
    audienceDataRepo(() =>
      Promise.reject(
        new UserError("record unreadable", UNREADABLE_CONTENT_CODE),
      )
    ),
    new InMemoryWorkflowRunRepository(),
  );

  assertEquals(resolved, undefined);
});

Deno.test("resolveCompletedRunOutputs: an aborted signal gives no outputs instead of an error", async () => {
  const controller = new AbortController();
  controller.abort();

  const resolved = await resolveCompletedRunOutputs(
    createModelMethodRun(),
    audienceDataRepo(() => Promise.resolve(AUDIENCE_JSON)),
    new InMemoryWorkflowRunRepository(),
    controller.signal,
  );

  assertEquals(resolved, undefined);
});

async function completedRunOf(
  resolveCompletedOutputs: boolean | undefined,
) {
  const run = createModelMethodRun();
  const deps = createTestDeps(createTestWorkflow(), [
    {
      kind: "report_completed",
      reportName: "test-report",
      scope: "workflow",
      markdown: "# Report",
      json: {},
    },
    { kind: "completed", run },
  ]);
  deps.dataRepo = audienceDataRepo(() => Promise.resolve(AUDIENCE_JSON));
  deps.resolveCompletedOutputs = resolveCompletedOutputs;

  const events = await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: "test-workflow",
  }));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") throw new Error("no completed event");
  return completed.run;
}

Deno.test("workflowRun: with resolveCompletedOutputs the completed run carries data attributes and its reports", async () => {
  const run = await completedRunOf(true);

  assertEquals(run.jobs[0].steps[0].dataArtifacts?.[0].attributes, {
    audienceId: "aud_123",
    status: "Building",
  });
  assertEquals(run.reports?.map((r) => r.name), ["test-report"]);
});

Deno.test("workflowRun: without resolveCompletedOutputs the completed run carries no data attributes", async () => {
  const run = await completedRunOf(undefined);

  assertEquals(run.jobs[0].steps[0].dataArtifacts?.[0].attributes, undefined);
  assertEquals(run.reports?.map((r) => r.name), ["test-report"]);
});

Deno.test("resolveCompletedRunOutputs: a resource the read policy refuses is left out of attributes and outputs", async () => {
  const asked: string[] = [];
  const resolved = await resolveCompletedRunOutputs(
    createModelMethodRun(),
    audienceDataRepo(() => Promise.resolve(AUDIENCE_JSON)),
    new InMemoryWorkflowRunRepository(),
    undefined,
    (ref) => {
      asked.push(ref.name);
      return Promise.resolve(false);
    },
  );

  assertEquals(asked.length, 1);
  assertEquals(resolved?.job1.step1.attributesByDataId, {});
  assertEquals(resolved?.job1.step1.outputs, undefined);
});

Deno.test("resolveCompletedRunOutputs: a read policy that throws gives no outputs instead of an error", async () => {
  const resolved = await resolveCompletedRunOutputs(
    createModelMethodRun(),
    audienceDataRepo(() => Promise.resolve(AUDIENCE_JSON)),
    new InMemoryWorkflowRunRepository(),
    undefined,
    () => Promise.reject(new Error("token revoked")),
  );

  assertEquals(resolved, undefined);
});

Deno.test("withRunStepOutputs: adds attributes and outputs as toRunData places and masks them, keeping the view's other fields", () => {
  const run = createModelMethodRun();
  const values = new RunSensitiveValues(undefined, new SecretBagRegistry());
  values.addSecret("aud_123", { vaultName: "v", key: "k" });
  run.attachSensitiveValues(values);
  const view = {
    ...toRunData(run, "/runs/r.yaml"),
    reports: [{ name: "kept", scope: "workflow", success: true }],
  };

  const merged = withRunStepOutputs(view, run, AUDIENCE_OUTPUTS);
  const expected = toRunData(run, "/runs/r.yaml", false, AUDIENCE_OUTPUTS);

  assertEquals(merged.jobs, expected.jobs);
  assertEquals(merged.jobs[0].steps[0].dataArtifacts?.[0].attributes, {
    audienceId: "***",
    status: "Building",
  });
  assertEquals(merged.reports, view.reports);
  assertEquals(view.jobs[0].steps[0].dataArtifacts?.[0].attributes, undefined);
});

Deno.test("workflowRun: onCompletedRun is handed the live run before the completed event is yielded, and only once the source has ended", async () => {
  const run = createModelMethodRun();
  const order: string[] = [];
  const deps = createTestDeps(createTestWorkflow(), [
    { kind: "completed", run },
    { kind: "job_started", jobId: "after" },
  ]);
  deps.onCompletedRun = (live) => {
    order.push(live === run ? "hook:live" : "hook:other");
  };

  for await (
    const event of workflowRun(createLibSwampContext(), deps, {
      workflowIdOrName: "test-workflow",
    })
  ) {
    order.push(event.kind);
  }

  const hook = order.indexOf("hook:live");
  assertEquals(hook >= 0, true);
  assertEquals(order.indexOf("job_started") < hook, true);
  assertEquals(hook < order.indexOf("completed"), true);
});

Deno.test("workflowRun: onCompletedRun alone reads no data attributes", async () => {
  const run = createModelMethodRun();
  let reads = 0;
  const deps = createTestDeps(createTestWorkflow(), [{
    kind: "completed",
    run,
  }]);
  deps.dataRepo = audienceDataRepo(() => {
    reads++;
    return Promise.resolve(AUDIENCE_JSON);
  });
  deps.onCompletedRun = () => {};

  const events = await collect(workflowRun(createLibSwampContext(), deps, {
    workflowIdOrName: "test-workflow",
  }));
  const completed = events.find((e) => e.kind === "completed");

  if (completed?.kind !== "completed") throw new Error("no completed event");
  assertEquals(reads, 0);
  assertEquals(
    completed.run.jobs[0].steps[0].dataArtifacts?.[0].attributes,
    undefined,
  );
});

function createBulkRun(
  contents: string[],
  withSize: boolean,
  recordedSize?: number,
): WorkflowRun {
  const run = WorkflowRun.create(createTestWorkflow());
  run.start();
  const job = run.getJob("job1")!;
  job.start();
  const step = job.getStep("step1")!;
  step.start();
  const records: Record<string, Record<string, unknown>> = {};
  contents.forEach((content, i) => {
    const name = `item-${i}`;
    step.addDataArtifact({ dataId: `data-${i}`, name, version: 1, tags: {} });
    records[name] = {
      id: `data-${i}`,
      name,
      version: 1,
      modelType: "test/model",
      modelId: "model-1",
      contentType: "application/json",
      tags: {},
      attributes: null,
      content: null,
      ...(withSize
        ? { size: recordedSize ?? new TextEncoder().encode(content).length }
        : {}),
    };
  });
  step.succeed({
    type: "model_method",
    model: "test-model",
    method: "run",
    resources: { item: records },
  });
  job.succeed();
  run.complete();
  return run;
}

function bulkDataRepo(
  contents: string[],
  reads: string[],
): UnifiedDataRepository {
  return {
    namespace: createNamespace("team-a"),
    getContent: (_type: unknown, _id: unknown, name: string) => {
      reads.push(name);
      const index = Number(name.slice("item-".length));
      return Promise.resolve(new TextEncoder().encode(contents[index]));
    },
  } as unknown as UnifiedDataRepository;
}

const BULK_ITEM = JSON.stringify({ blob: "x".repeat(40) });
const BULK_CONTENTS = [BULK_ITEM, BULK_ITEM, BULK_ITEM];

Deno.test("resolveCompletedRunOutputs: resources past the attribute budget are never read and are named as omitted", async () => {
  const reads: string[] = [];
  const run = createBulkRun(BULK_CONTENTS, true);
  const resolved = await resolveCompletedRunOutputs(
    run,
    bulkDataRepo(BULK_CONTENTS, reads),
    new InMemoryWorkflowRunRepository(),
    undefined,
    undefined,
    undefined,
    BULK_ITEM.length + 1,
  );

  assertEquals(reads, ["item-0"]);
  assertEquals(Object.keys(resolved!.job1.step1.attributesByDataId), [
    "data-0",
  ]);
  assertEquals(resolved!.job1.step1.attributesOmitted, ["data-1", "data-2"]);

  const view = toRunData(run, undefined, false, resolved);
  const artifacts = view.jobs[0].steps[0].dataArtifacts!;
  assertEquals(artifacts.map((a) => a.attributesOmitted === true), [
    false,
    true,
    true,
  ]);
  assertEquals(artifacts[0].attributes, { blob: "x".repeat(40) });
  assertEquals(artifacts[1].attributes, undefined);
  assertEquals(view.jobs[0].steps[0].outputsPartial, true);
});

Deno.test("resolveCompletedRunOutputs: a record without a stored size is measured after its read", async () => {
  const reads: string[] = [];
  const resolved = await resolveCompletedRunOutputs(
    createBulkRun(BULK_CONTENTS, false),
    bulkDataRepo(BULK_CONTENTS, reads),
    new InMemoryWorkflowRunRepository(),
    undefined,
    undefined,
    undefined,
    BULK_ITEM.length + 1,
  );

  assertEquals(reads, ["item-0", "item-1"]);
  assertEquals(resolved!.job1.step1.attributesOmitted, ["data-1", "data-2"]);
});

Deno.test("resolveCompletedRunOutputs: a run under the attribute budget names nothing as omitted", async () => {
  const resolved = await resolveCompletedRunOutputs(
    createBulkRun(BULK_CONTENTS, true),
    bulkDataRepo(BULK_CONTENTS, []),
    new InMemoryWorkflowRunRepository(),
  );

  assertEquals(Object.keys(resolved!.job1.step1.attributesByDataId).length, 3);
  assertEquals(resolved!.job1.step1.attributesOmitted, undefined);
  const view = toRunData(
    createBulkRun(BULK_CONTENTS, true),
    undefined,
    false,
    resolved,
  );
  assertEquals(view.jobs[0].steps[0].outputsPartial, undefined);
});

Deno.test("resolveCompletedRunOutputs: a recorded size of 0 is measured after the read rather than admitted free", async () => {
  const reads: string[] = [];
  const resolved = await resolveCompletedRunOutputs(
    createBulkRun(BULK_CONTENTS, true, 0),
    bulkDataRepo(BULK_CONTENTS, reads),
    new InMemoryWorkflowRunRepository(),
    undefined,
    undefined,
    undefined,
    BULK_ITEM.length + 1,
  );

  assertEquals(reads, ["item-0", "item-1"]);
  assertEquals(resolved!.job1.step1.attributesOmitted, ["data-1", "data-2"]);
});

function createParentRun(child: WorkflowRun, tailContent: string): WorkflowRun {
  const parent = WorkflowRun.create(Workflow.create({
    name: "parent-workflow",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "tail",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  }));
  parent.start();
  const job = parent.getJob("job1")!;
  job.start();
  const step = job.getStep("step1")!;
  step.start();
  step.succeed({
    type: "workflow",
    workflowId: child.workflowId,
    runId: child.id,
  });
  const tail = job.getStep("tail")!;
  tail.start();
  tail.addDataArtifact({
    dataId: "tail-data",
    name: "tail-item",
    version: 1,
    tags: {},
  });
  tail.succeed({
    type: "model_method",
    model: "test-model",
    method: "run",
    resources: {
      item: {
        "tail-item": {
          id: "tail-data",
          name: "tail-item",
          version: 1,
          modelType: "test/model",
          modelId: "model-1",
          contentType: "application/json",
          tags: {},
          attributes: null,
          content: null,
          size: new TextEncoder().encode(tailContent).length,
        },
      },
    },
  });
  job.succeed();
  parent.complete();
  return parent;
}

function namedDataRepo(
  contents: Record<string, string>,
  reads: string[],
): UnifiedDataRepository {
  return {
    namespace: createNamespace("team-a"),
    getContent: (_type: unknown, _id: unknown, name: string) => {
      reads.push(name);
      return Promise.resolve(new TextEncoder().encode(contents[name]));
    },
  } as unknown as UnifiedDataRepository;
}

const TAIL_ITEM = JSON.stringify({ ok: true });

Deno.test("resolveCompletedRunOutputs: a child run's reads are charged by its merged outputs, so a later step keeps its attributes", async () => {
  const runRepo = new InMemoryWorkflowRunRepository();
  const child = createBulkRun(BULK_CONTENTS, true);
  await runRepo.save(createWorkflowId(child.workflowId), child);
  const parent = createParentRun(child, TAIL_ITEM);
  const reads: string[] = [];

  const resolved = await resolveCompletedRunOutputs(
    parent,
    namedDataRepo({
      "item-0": BULK_ITEM,
      "item-1": BULK_ITEM,
      "item-2": BULK_ITEM,
      "tail-item": TAIL_ITEM,
    }, reads),
    runRepo,
    undefined,
    undefined,
    undefined,
    BULK_ITEM.length * 2,
  );

  assertEquals(reads, ["item-0", "item-1", "item-2", "tail-item"]);
  assertEquals(resolved!.job1.step1.outputs, {
    step1: { blob: "x".repeat(40) },
  });
  assertEquals(resolved!.job1.step1.attributesOmitted, undefined);
  assertEquals(resolved!.job1.tail.attributesByDataId, {
    "tail-data": { ok: true },
  });
  assertEquals(resolved!.job1.tail.attributesOmitted, undefined);
  const view = toRunData(parent, undefined, false, resolved);
  assertEquals(view.jobs[0].steps[0].outputsPartial, undefined);
  assertEquals(view.jobs[0].steps[1].outputsPartial, undefined);
  assertEquals(view.jobs[0].steps[1].dataArtifacts![0].attributes, {
    ok: true,
  });
});

Deno.test("resolveCompletedRunOutputs: a child step whose merged outputs pass the budget is left out with its records omitted", async () => {
  const contents = [
    JSON.stringify({ a: "x".repeat(40) }),
    JSON.stringify({ b: "x".repeat(40) }),
    JSON.stringify({ c: "x".repeat(40) }),
  ];
  const runRepo = new InMemoryWorkflowRunRepository();
  const child = createBulkRun(contents, true);
  await runRepo.save(createWorkflowId(child.workflowId), child);
  const parent = createParentRun(child, TAIL_ITEM);
  const reads: string[] = [];

  const resolved = await resolveCompletedRunOutputs(
    parent,
    namedDataRepo({
      "item-0": contents[0],
      "item-1": contents[1],
      "item-2": contents[2],
      "tail-item": TAIL_ITEM,
    }, reads),
    runRepo,
    undefined,
    undefined,
    undefined,
    contents[0].length * 2,
  );

  assertEquals(reads, ["item-0", "item-1", "item-2"]);
  assertEquals(resolved!.job1.step1.outputs, undefined);
  assertEquals(resolved!.job1.step1.attributesOmitted, [
    "data-0",
    "data-1",
    "data-2",
  ]);
  assertEquals(resolved!.job1.tail.attributesOmitted, ["tail-data"]);
  const view = toRunData(parent, undefined, false, resolved);
  assertEquals(view.jobs[0].steps[0].outputsPartial, true);
  assertEquals(view.jobs[0].steps[1].outputsPartial, true);
});

Deno.test("RunAttributeBudget.resolveChild: a child step too large for one JSON string is refused, not thrown, and a later read is omitted", async () => {
  const mebibyte = "x".repeat(1024 * 1024);
  // about 1 GiB of JSON from shared strings, past V8's string limit
  const huge = { rows: Array.from({ length: 1024 }, () => mebibyte) };
  const budget = new RunAttributeBudget(16 * 1024 * 1024);
  const record = (id: string) => ({
    id,
    name: id,
    version: 1,
    namespace: "",
    modelName: "m",
    tags: {},
    attributes: {},
  });

  const resolved = await budget.resolveChild(() =>
    Promise.resolve({
      outputs: { small: { ok: true }, big: huge },
      attributesByDataId: {},
      sources: [
        { path: ["small"], records: [record("data-small")] },
        { path: ["big"], records: [record("data-big")] },
      ],
    })
  );

  assertEquals(resolved.outputs, { small: { ok: true } });
  assertEquals(resolved.sources?.map((group) => group.path), [["small"]]);
  assertEquals(budget.takeStepOmitted(), ["data-big"]);
  const read = budget.wrap(() => Promise.resolve({ tail: true }));
  assertEquals(
    await read({
      dataId: "tail-data",
      name: "tail-item",
      version: 1,
      modelType: "test/model",
      modelId: "model-1",
      modelName: "",
      specName: "",
      contentType: "application/json",
      tags: {},
      size: 13,
    }),
    undefined,
  );
  assertEquals(budget.takeStepOmitted(), ["tail-data"]);
});

function nestedContent(depth: number): string {
  let tree = "[0,1,2]";
  for (let i = 0; i < depth; i++) tree = `[${tree}]`;
  return `{"i":0,"tree":${tree}}`;
}

Deno.test("resolveCompletedRunOutputs: a child step with deeply nested outputs keeps them, and a later step keeps its attributes", async () => {
  const deep = nestedContent(5_000);
  const runRepo = new InMemoryWorkflowRunRepository();
  const child = createBulkRun([deep], true);
  await runRepo.save(createWorkflowId(child.workflowId), child);
  const parent = createParentRun(child, TAIL_ITEM);

  const resolved = await resolveCompletedRunOutputs(
    parent,
    namedDataRepo({ "item-0": deep, "tail-item": TAIL_ITEM }, []),
    runRepo,
  );

  // compared as text: a deep assertEquals would recurse once per level
  assertEquals(
    JSON.stringify(resolved!.job1.step1.outputs),
    `{"step1":${deep}}`,
  );
  assertEquals(resolved!.job1.step1.attributesOmitted, undefined);
  assertEquals(resolved!.job1.tail.attributesByDataId, {
    "tail-data": { ok: true },
  });
  assertEquals(resolved!.job1.tail.attributesOmitted, undefined);
});

function sourceRecord(id: string) {
  return {
    id,
    name: id,
    version: 1,
    namespace: "",
    modelName: "m",
    tags: {},
    attributes: {},
  };
}

Deno.test("RunAttributeBudget.resolveChild: a child step whose measuring throws RangeError is refused alone with its records omitted", async () => {
  const budget = new RunAttributeBudget(16 * 1024 * 1024);
  const unmeasurable = {
    toJSON: () => {
      throw new RangeError("Maximum call stack size exceeded");
    },
  };

  const resolved = await budget.resolveChild(() =>
    Promise.resolve({
      outputs: { small: { ok: true }, deep: unmeasurable },
      attributesByDataId: {},
      sources: [
        { path: ["small"], records: [sourceRecord("data-small")] },
        { path: ["deep"], records: [sourceRecord("data-deep")] },
      ],
    })
  );

  assertEquals(resolved.outputs, { small: { ok: true } });
  assertEquals(resolved.sources?.map((group) => group.path), [["small"]]);
  assertEquals(budget.takeStepOmitted(), ["data-deep"]);
});

Deno.test("RunAttributeBudget.resolveChild: an error other than RangeError from measuring still rejects", async () => {
  const budget = new RunAttributeBudget(16 * 1024 * 1024);
  const broken = {
    toJSON: () => {
      throw new TypeError("not serialisable");
    },
  };

  await assertRejects(
    () =>
      budget.resolveChild(() =>
        Promise.resolve({
          outputs: { broken },
          attributesByDataId: {},
          sources: [],
        })
      ),
    TypeError,
    "not serialisable",
  );
});
