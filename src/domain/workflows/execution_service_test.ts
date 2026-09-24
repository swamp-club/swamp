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

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { walk } from "@std/fs/walk";
import { hostname } from "node:os";
import {
  DefaultStepExecutor,
  type StepExecutionContext,
  type StepExecutor,
  stepNameFromCompositeKey,
  trackerStatusForRun,
  WorkflowExecutionService,
} from "./execution_service.ts";
import { computeStepsToReset } from "./resume_reset.ts";
import { UserError } from "../errors.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import "../models/models.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
import { reportRegistry } from "../reports/report_registry.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "./workflow_id.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { STRANDED_STEP_ERROR, WorkflowRun } from "./workflow_run.ts";
import type { WorkflowExecutionEvent } from "./execution_events.ts";
import { assessRecoveryForRun } from "./recovery_assessment.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";
import type { RunTrackerRepository } from "../models/run_tracker_repository.ts";
import type { ActiveRun, ActiveRunStatus } from "../models/active_run.ts";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Mock step executor for testing.
 */
class MockStepExecutor implements StepExecutor {
  executedSteps: string[] = [];
  shouldFail: Set<string> = new Set();
  authoredByStep = new Map<string, ReadonlySet<string>>();

  execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
    this.authoredByStep.set(ctx.stepName, ctx.authoredExpressions);

    if (this.shouldFail.has(step.name)) {
      return Promise.reject(new Error(`Step ${step.name} failed`));
    }

    return Promise.resolve({ executed: true, step: step.name });
  }
}

/**
 * In-memory workflow repository for testing.
 */
class InMemoryWorkflowRepository implements WorkflowRepository {
  private workflows = new Map<string, Workflow>();

  findById(id: WorkflowId): Promise<Workflow | null> {
    return Promise.resolve(this.workflows.get(id) ?? null);
  }

  findByName(name: string): Promise<Workflow | null> {
    for (const workflow of this.workflows.values()) {
      if (workflow.name === name) {
        return Promise.resolve(workflow);
      }
    }
    return Promise.resolve(null);
  }

  findAll(): Promise<Workflow[]> {
    return Promise.resolve(Array.from(this.workflows.values()));
  }

  save(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
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

/**
 * In-memory workflow run repository for testing.
 */
class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private runs = new Map<string, WorkflowRun[]>();

  findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    const workflowRuns = this.runs.get(workflowId) ?? [];
    return Promise.resolve(workflowRuns.find((r) => r.id === runId) ?? null);
  }

  findAllByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun[]> {
    return Promise.resolve(this.runs.get(workflowId) ?? []);
  }

  findLatestByWorkflowId(
    workflowId: WorkflowId,
  ): Promise<WorkflowRun | null> {
    const workflowRuns = this.runs.get(workflowId) ?? [];
    return Promise.resolve(workflowRuns[workflowRuns.length - 1] ?? null);
  }

  findAllGlobal(): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
    for (const [workflowId, runs] of this.runs.entries()) {
      for (const run of runs) {
        results.push({ run, workflowId: workflowId as WorkflowId });
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

  save(workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    const existing = this.runs.get(workflowId) ?? [];
    const idx = existing.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      existing[idx] = run;
    } else {
      existing.push(run);
    }
    this.runs.set(workflowId, existing);
    return Promise.resolve();
  }

  nextId(): WorkflowRunId {
    return createWorkflowRunId(crypto.randomUUID());
  }

  getPath(workflowId: WorkflowId, runId: WorkflowRunId): string {
    return `workflows/workflow-${workflowId}/workflow-run-${runId}.yaml`;
  }

  deleteAllByWorkflowId(workflowId: WorkflowId): Promise<number> {
    const runs = this.runs.get(workflowId) ?? [];
    const count = runs.length;
    this.runs.delete(workflowId);
    return Promise.resolve(count);
  }

  deleteOlderThan(
    _cutoff: Date,
    _options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }> {
    return Promise.resolve({ deleted: 0, bytesReclaimed: 0 });
  }
}

function createSimpleWorkflow(): Workflow {
  return Workflow.create({
    name: "simple-workflow",
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

Deno.test("executes simple workflow with one job and one step", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(run.getJob("job1")?.status, "succeeded");
    assertEquals(run.getJob("job1")?.getStep("step1")?.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/step1"]);
  });
});

Deno.test("executes workflow with multiple jobs", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "multi-job",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "compile",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "test",
          steps: [
            Step.create({
              name: "unit",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["build/compile", "test/unit"]);
  });
});

Deno.test("executes workflow with step dependencies", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "step-deps",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "setup",
              task: StepTask.model("test-model", "run"),
            }),
            Step.create({
              name: "compile",
              task: StepTask.model("test-model", "run"),
              dependsOn: [
                {
                  step: "setup",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    // Setup must run before compile
    const setupIdx = executor.executedSteps.indexOf("build/setup");
    const compileIdx = executor.executedSteps.indexOf("build/compile");
    assertEquals(setupIdx < compileIdx, true);
  });
});

Deno.test("marks workflow as failed when step fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("step1");

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "failed");
    assertEquals(run.getJob("job1")?.status, "failed");
    assertEquals(run.getJob("job1")?.getStep("step1")?.status, "failed");
    assertNotEquals(run.getJob("job1")?.getStep("step1")?.error, undefined);
  });
});

Deno.test("skips job when trigger condition not met", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("compile"); // Build fails

    const workflow = Workflow.create({
      name: "conditional",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "compile",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "test",
          steps: [
            Step.create({
              name: "unit",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "failed");
    assertEquals(run.getJob("build")?.status, "failed");
    assertEquals(run.getJob("test")?.status, "skipped");
  });
});

Deno.test("runs job on failure condition", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("compile"); // Build fails

    const workflow = Workflow.create({
      name: "on-failure",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "compile",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "notify",
          steps: [
            Step.create({
              name: "alert",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.failed() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.getJob("build")?.status, "failed");
    assertEquals(run.getJob("notify")?.status, "succeeded");
    assertEquals(executor.executedSteps.includes("notify/alert"), true);
  });
});

Deno.test("throws error for nonexistent workflow", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      undefined,
      undefined,
      catalogStore,
    );

    try {
      await service.execute("nonexistent");
      throw new Error("Expected error");
    } catch (error) {
      assertEquals((error as Error).message.includes("not found"), true);
    }
  });
});

Deno.test("saves workflow run to repository", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    const savedRuns = await runRepo.findAllByWorkflowId(workflow.id);
    assertEquals(savedRuns.length >= 1, true);
    assertEquals(savedRuns[savedRuns.length - 1].id, run.id);
  });
});

Deno.test("run() yields lifecycle events during execution", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: string[] = [];
    for await (const event of service.run(workflow.name)) {
      events.push(event.kind);
    }

    assertEquals(events.includes("started"), true);
    assertEquals(events.includes("job_started"), true);
    assertEquals(events.includes("step_started"), true);
    assertEquals(events.includes("step_completed"), true);
    assertEquals(events.includes("job_completed"), true);
    assertEquals(events.includes("completed"), true);
  });
});

/**
 * Mock step executor that tracks concurrent execution for parallel testing.
 */
class ConcurrencyTrackingExecutor implements StepExecutor {
  executedSteps: string[] = [];
  concurrentExecutions: number[] = [];
  private currentConcurrency = 0;
  private maxConcurrency = 0;
  private delay: number;

  constructor(delayMs: number = 50) {
    this.delay = delayMs;
  }

  async execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    // Track that we started
    this.currentConcurrency++;
    this.concurrentExecutions.push(this.currentConcurrency);
    if (this.currentConcurrency > this.maxConcurrency) {
      this.maxConcurrency = this.currentConcurrency;
    }

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, this.delay));

    this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);

    // Track that we finished
    this.currentConcurrency--;

    return { executed: true, step: step.name };
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }
}

Deno.test("executes independent jobs in parallel", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ConcurrencyTrackingExecutor(50);

    // Create workflow with 3 independent jobs (no dependencies)
    const workflow = Workflow.create({
      name: "parallel-jobs",
      jobs: [
        Job.create({
          name: "job-a",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "job-b",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "job-c",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 3);

    // `getMaxConcurrency() === 3` is the actual proof of parallelism —
    // the executor saw 3 simultaneous in-flight invocations. A sequential
    // run would never exceed 1.
    assertEquals(executor.getMaxConcurrency(), 3);
  });
});

Deno.test("executes dependent jobs sequentially across levels", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ConcurrencyTrackingExecutor(30);

    // Create workflow with diamond dependency pattern:
    // job-a and job-b have no deps (level 1, parallel)
    // job-c depends on job-a (level 2)
    // job-d depends on both job-a and job-b (level 3)
    const workflow = Workflow.create({
      name: "diamond-deps",
      jobs: [
        Job.create({
          name: "job-a",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "job-b",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "job-c",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "job-a", condition: TriggerCondition.succeeded() },
          ],
        }),
        Job.create({
          name: "job-d",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "job-a", condition: TriggerCondition.succeeded() },
            { job: "job-b", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: string[] = [];
    let run: WorkflowRun | undefined;
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "job_started") {
        events.push(`start:${event.jobId}`);
      } else if (event.kind === "job_completed") {
        events.push(`complete:${event.jobId}`);
      } else if (event.kind === "completed") {
        run = event.run;
      }
    }
    if (!run) throw new Error("Expected run");

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 4);

    // Verify job-a and job-b both start before either completes (parallel in level 1)
    const aStartIdx = events.indexOf("start:job-a");
    const bStartIdx = events.indexOf("start:job-b");
    const aCompleteIdx = events.indexOf("complete:job-a");
    const bCompleteIdx = events.indexOf("complete:job-b");

    // Both should start before both complete (proves parallel execution)
    assertEquals(aStartIdx < aCompleteIdx, true);
    assertEquals(bStartIdx < bCompleteIdx, true);
    assertEquals(aStartIdx < bCompleteIdx, true);
    assertEquals(bStartIdx < aCompleteIdx, true);

    // job-c should start only after job-a completes
    const cStartIdx = events.indexOf("start:job-c");
    assertEquals(cStartIdx > aCompleteIdx, true);

    // job-d should start only after both job-a and job-b complete
    const dStartIdx = events.indexOf("start:job-d");
    assertEquals(dStartIdx > aCompleteIdx, true);
    assertEquals(dStartIdx > bCompleteIdx, true);
  });
});

Deno.test("executes independent steps within a job in parallel", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ConcurrencyTrackingExecutor(50);

    // Create workflow with one job that has 3 independent steps
    const workflow = Workflow.create({
      name: "parallel-steps",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step-a",
              task: StepTask.model("test-model", "run"),
            }),
            Step.create({
              name: "step-b",
              task: StepTask.model("test-model", "run"),
            }),
            Step.create({
              name: "step-c",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 3);

    // `getMaxConcurrency() === 3` is the actual proof of parallelism —
    // the executor saw 3 simultaneous in-flight invocations. A sequential
    // run would never exceed 1.
    assertEquals(executor.getMaxConcurrency(), 3);
  });
});

/**
 * Mock step executor that captures the expression context each step receives,
 * mutates it (simulating executeModelMethod), and yields to the event loop
 * so parallel steps interleave.
 */
class ContextCapturingExecutor implements StepExecutor {
  executedSteps: string[] = [];
  capturedContexts = new Map<string, {
    selfName: string | undefined;
    inputs: Record<string, unknown> | undefined;
  }>();

  async execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    const stepName = ctx.stepName;
    const exprCtx = ctx.expressionContext;

    // Simulate executeModelMethod: mutate self and inputs
    if (exprCtx) {
      exprCtx.self = {
        id: `id-${stepName}`,
        name: `model-for-${stepName}`,
        version: 1,
        tags: {},
        globalArguments: {},
      };
    }

    // Yield to the event loop so other parallel steps can interleave
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (exprCtx) {
      exprCtx.inputs = {
        ...(exprCtx.inputs ?? {}),
        [`private-${stepName}`]: `secret-${stepName}`,
      };
    }

    // Capture what this step sees AFTER the yield — if contexts are shared,
    // self may have been overwritten by a sibling step during the await.
    this.capturedContexts.set(stepName, {
      selfName: exprCtx?.self?.name as string | undefined,
      inputs: exprCtx?.inputs ? { ...exprCtx.inputs } : undefined,
    });

    this.executedSteps.push(`${ctx.jobName}/${stepName}`);
    return { executed: true, step: step.name };
  }
}

Deno.test("parallel steps get isolated expression contexts", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ContextCapturingExecutor();

    const workflow = Workflow.create({
      name: "context-isolation",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step-a",
              task: StepTask.model("test-model-a", "run", {
                label: "from-a",
              }),
            }),
            Step.create({
              name: "step-b",
              task: StepTask.model("test-model-b", "run", {
                label: "from-b",
              }),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 2);

    const ctxA = executor.capturedContexts.get("step-a");
    const ctxB = executor.capturedContexts.get("step-b");

    // Each step should see its OWN self.name, not a sibling's
    assertEquals(ctxA?.selfName, "model-for-step-a");
    assertEquals(ctxB?.selfName, "model-for-step-b");

    // Step A's private inputs should NOT leak into step B and vice versa
    assertEquals(ctxA?.inputs?.["private-step-a"], "secret-step-a");
    assertEquals(ctxA?.inputs?.["private-step-b"], undefined);
    assertEquals(ctxB?.inputs?.["private-step-b"], "secret-step-b");
    assertEquals(ctxB?.inputs?.["private-step-a"], undefined);
  });
});

/**
 * Mock step executor that simulates model method execution with data artifacts.
 * Used to test that data context is refreshed between workflow steps.
 */
class ModelMethodMockExecutor implements StepExecutor {
  executedSteps: string[] = [];
  /** Maps step name to the model output it should return */
  stepOutputs: Map<string, {
    model: string;
    resources?: Record<string, {
      id: string;
      name: string;
      version: number;
      createdAt: string;
      attributes: Record<string, unknown>;
      tags: Record<string, string>;
    }>;
    files?: Record<string, {
      id: string;
      version: number;
      createdAt: string;
      path: string;
      size: number;
      contentType: string;
    }>;
  }> = new Map();
  /** Captures the expression context at each step for verification */
  capturedContexts: Map<string, Record<string, unknown>> = new Map();

  execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);

    // Capture the expression context for this step
    if (ctx.expressionContext) {
      this.capturedContexts.set(
        ctx.stepName,
        JSON.parse(JSON.stringify(ctx.expressionContext.model)),
      );
    }

    // Return configured output for this step, or a default
    const output = this.stepOutputs.get(step.name);
    if (output) {
      return Promise.resolve({
        type: "model_method",
        method: "test",
        ...output,
      });
    }

    return Promise.resolve({ executed: true, step: step.name });
  }
}

Deno.test("updates data context between workflow steps", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ModelMethodMockExecutor();

    // Configure step1 to produce resource data that step2 should be able to see
    executor.stepOutputs.set("step1", {
      model: "auth-model",
      resources: {
        "auth": {
          id: "auth-data-123",
          name: "auth",
          version: 1,
          createdAt: "2024-01-01T00:00:00Z",
          attributes: { token: "secret-token", expiresAt: "2024-01-01" },
          tags: { type: "resource" },
        },
      },
    });

    // step2 depends on step1, should see the data written by step1
    executor.stepOutputs.set("step2", {
      model: "list-model",
      resources: {
        "list": {
          id: "list-resource-456",
          name: "list",
          version: 1,
          createdAt: "2024-01-01T00:00:00Z",
          attributes: { items: ["a", "b", "c"] },
          tags: { type: "resource" },
        },
      },
    });

    const workflow = Workflow.create({
      name: "data-context-refresh",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("auth-model", "authenticate"),
            }),
            Step.create({
              name: "step2",
              task: StepTask.model("list-model", "list"),
              dependsOn: [
                {
                  step: "step1",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/step1", "job1/step2"]);

    // Verify step2 saw the resource context updated from step1
    const step2Context = executor.capturedContexts.get("step2");
    const authModelData = step2Context?.["auth-model"] as {
      resource?: Record<
        string,
        { id: string; attributes: Record<string, unknown> }
      >;
    };

    // The resource data should be available in the context when step2 runs
    // Resources are keyed by specName
    assertEquals(authModelData?.resource?.["auth"]?.id, "auth-data-123");
    assertEquals(
      authModelData?.resource?.["auth"]?.attributes?.token,
      "secret-token",
    );
    assertEquals(
      authModelData?.resource?.["auth"]?.attributes?.expiresAt,
      "2024-01-01",
    );
  });
});

Deno.test("updates both resource and file context when step produces both", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ModelMethodMockExecutor();

    // Configure step1 to produce both resource and file
    executor.stepOutputs.set("step1", {
      model: "sync-model",
      resources: {
        "sync-status": {
          id: "resource-123",
          name: "sync-status",
          version: 1,
          createdAt: "2024-01-01T00:00:00Z",
          attributes: {
            status: "synced",
            lastSyncTime: "2024-01-01T00:00:00Z",
          },
          tags: { type: "resource" },
        },
      },
      files: {
        "sync-log": {
          id: "file-456",
          version: 1,
          createdAt: "2024-01-01T00:00:00Z",
          path: "/tmp/sync.log",
          size: 1024,
          contentType: "text/plain",
        },
      },
    });

    executor.stepOutputs.set("step2", {
      model: "report-model",
    });

    const workflow = Workflow.create({
      name: "resource-and-file-context",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("sync-model", "sync"),
            }),
            Step.create({
              name: "step2",
              task: StepTask.model("report-model", "generate"),
              dependsOn: [
                {
                  step: "step1",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");

    // Verify step2 saw both resource and file context from step1
    const step2Context = executor.capturedContexts.get("step2");
    const syncModelData = step2Context?.["sync-model"] as {
      resource?: Record<
        string,
        { id: string; attributes: Record<string, unknown> }
      >;
      file?: Record<
        string,
        { id: string; path: string; size: number; contentType: string }
      >;
    };

    // Resource should be in context (keyed by specName)
    assertEquals(syncModelData?.resource?.["sync-status"]?.id, "resource-123");
    assertEquals(
      syncModelData?.resource?.["sync-status"]?.attributes?.status,
      "synced",
    );

    // File should also be in context (keyed by specName)
    assertEquals(syncModelData?.file?.["sync-log"]?.id, "file-456");
    assertEquals(syncModelData?.file?.["sync-log"]?.path, "/tmp/sync.log");
    assertEquals(syncModelData?.file?.["sync-log"]?.size, 1024);
    assertEquals(syncModelData?.file?.["sync-log"]?.contentType, "text/plain");
  });
});

Deno.test("executes linear chain where multiple steps reference same model", async () => {
  // Regression: the old implicit dependency system would create false cycles
  // when multiple steps referenced the same model (last-writer-wins in modelToStep map).
  // With explicit-only deps, this linear chain should execute correctly.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "linear-chain",
      jobs: [
        Job.create({
          name: "shutdown",
          steps: [
            Step.create({
              name: "auth",
              task: StepTask.model("proxmox-auth", "run"),
            }),
            Step.create({
              name: "lookup",
              task: StepTask.model("fleet", "read"),
              dependsOn: [
                { step: "auth", condition: TriggerCondition.succeeded() },
              ],
            }),
            Step.create({
              name: "warn-players",
              task: StepTask.model("minecraft", "warn"),
              dependsOn: [
                { step: "lookup", condition: TriggerCondition.succeeded() },
              ],
            }),
            Step.create({
              name: "stop-minecraft",
              task: StepTask.model("minecraft", "stop"),
              dependsOn: [
                {
                  step: "warn-players",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
            Step.create({
              name: "stop-vm",
              task: StepTask.model("fleet", "stop"),
              dependsOn: [
                {
                  step: "stop-minecraft",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, [
      "shutdown/auth",
      "shutdown/lookup",
      "shutdown/warn-players",
      "shutdown/stop-minecraft",
      "shutdown/stop-vm",
    ]);
  });
});

Deno.test("run() event stream includes all expected event types", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const eventTypes: string[] = [];
    for await (const event of service.run(workflow.name)) {
      eventTypes.push(event.kind);
    }

    // Must include these event types in order
    assertEquals(eventTypes[0], "started");
    assertEquals(eventTypes[eventTypes.length - 1], "completed");
    assertEquals(eventTypes.includes("job_started"), true);
    assertEquals(eventTypes.includes("step_started"), true);
    assertEquals(eventTypes.includes("step_completed"), true);
    assertEquals(eventTypes.includes("job_completed"), true);
  });
});

// --- Workflow nesting and cycle detection tests ---

Deno.test("workflow step fails when nesting depth exceeded", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Parent workflow with a step that calls a child workflow
    const workflow = Workflow.create({
      name: "parent-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "nested-step",
              task: StepTask.workflow("child-workflow"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      undefined,
      undefined,
      catalogStore,
    );

    const events: { kind: string; error?: string }[] = [];
    for await (
      const event of service.run(workflow.name, {
        workflowNestingDepth: 10,
      })
    ) {
      if (event.kind === "step_failed") {
        events.push({ kind: event.kind, error: event.error });
      }
    }

    assertEquals(events.length, 1);
    assertEquals(
      events[0].error?.includes("Maximum workflow nesting depth (10) exceeded"),
      true,
    );
  });
});

Deno.test("workflow step fails on direct cycle detection", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Workflow that tries to call itself
    const workflow = Workflow.create({
      name: "self-calling",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "recursive-step",
              task: StepTask.workflow("self-calling"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      undefined,
      undefined,
      catalogStore,
    );

    const events: { kind: string; error?: string }[] = [];
    for await (
      const event of service.run(workflow.name, {
        ancestorWorkflowIds: new Set(["self-calling"]),
      })
    ) {
      if (event.kind === "step_failed") {
        events.push({ kind: event.kind, error: event.error });
      }
    }

    assertEquals(events.length, 1);
    assertEquals(
      events[0].error?.includes("Workflow cycle detected"),
      true,
    );
  });
});

Deno.test("workflow step propagates cycle error from mutually recursive workflows", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const cycleA = Workflow.create({
      name: "cycle-a",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "call-b",
              task: StepTask.workflow("cycle-b"),
            }),
          ],
        }),
      ],
    });

    const cycleB = Workflow.create({
      name: "cycle-b",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "call-a",
              task: StepTask.workflow("cycle-a"),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(cycleA);
    await workflowRepo.save(cycleB);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      undefined,
      undefined,
      catalogStore,
    );

    let completedRun: import("./workflow_run.ts").WorkflowRun | undefined;
    for await (const event of service.run("cycle-a")) {
      if (event.kind === "completed") {
        completedRun = event.run;
      }
    }

    assert(completedRun, "expected a completed run");
    assertEquals(completedRun.status, "failed");
    const stepError = completedRun.jobs[0].steps[0].error ?? "";
    assertStringIncludes(
      stepError.toLowerCase(),
      "workflow cycle detected",
    );
  });
});

Deno.test("DefaultStepExecutor rejects workflow task type", async () => {
  const executor = new DefaultStepExecutor();

  const step = Step.create({
    name: "nested-step",
    task: StepTask.workflow("child-workflow"),
  });

  const catalogStore = new CatalogStore(join("/tmp", "_catalog.db"));
  const ctx: StepExecutionContext = {
    workflowId: createWorkflowId("parent-id"),
    workflowRunId: "run-123",
    workflowName: "parent-workflow",
    jobName: "job1",
    stepName: "nested-step",
    repoDir: "/tmp",
    signal: new AbortController().signal,
    catalogStore,
    authoredExpressions: new Set(),
  };

  await assertRejects(
    () => executor.execute(step, ctx),
    Error,
    "Unsupported task type for step executor",
  );
});

Deno.test("workflow step applies child workflow's input defaults", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    // Child workflow declares "verbose" with a default of false
    const childWorkflow = Workflow.create({
      name: "child-workflow",
      inputs: {
        properties: {
          name: { type: "string" },
          verbose: { type: "boolean", default: false },
        },
        required: ["name"],
      },
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.modelMethod("some-model", "run", {
                name: "${{ inputs.name }}",
                verbose: "${{ inputs.verbose }}",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    // Parent invokes the child WITHOUT passing "verbose"
    const parentWorkflow = Workflow.create({
      name: "parent-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "call-child",
              task: StepTask.workflow("child-workflow", {
                name: "test-value",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: { kind: string; error?: string }[] = [];
    for await (const event of service.run(parentWorkflow.name)) {
      if (event.kind === "step_failed") {
        events.push({ kind: event.kind, error: event.error });
      }
    }

    const failures = events.filter((e) => e.kind === "step_failed");
    assertEquals(
      failures.length,
      0,
      `Child step should not fail — input defaults should be applied. Failures: ${
        JSON.stringify(failures)
      }`,
    );
    assertEquals(executor.executedSteps.includes("job1/child-step"), true);
  });
});

Deno.test("workflow step carries parent-authored runtime expressions into the child's provenance", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const childWorkflow = Workflow.create({
      name: "child-workflow",
      inputs: { properties: { home: { type: "string" } } },
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.modelMethod("some-model", "run", {
                home: "${{ inputs.home }}",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    // The parent author writes a runtime expression as a child input. It
    // survives the parent's evaluation unresolved and must be admitted in
    // the child, while data content shaped like an expression must not be.
    const parentWorkflow = Workflow.create({
      name: "parent-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "call-child",
              task: StepTask.workflow("child-workflow", {
                home: "${{ env.HOME }}",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const failures: string[] = [];
    for await (const event of service.run(parentWorkflow.name)) {
      if (event.kind === "step_failed") failures.push(event.error);
    }
    assertEquals(failures, []);

    const childAuthored = executor.authoredByStep.get("child-step");
    const childRun = (await runRepo.findAllByWorkflowId(childWorkflow.id))[0];
    assertEquals(childRun.deferredExpressions[0].expression, "${{ env.HOME }}");
    assertEquals(childAuthored?.has(String(childRun.inputs.home)), true);
    assertEquals(childAuthored?.has("${{ inputs.home }}"), true);
    assertEquals(childAuthored?.has("${{ vault.get('injected') }}"), false);
  });
});

Deno.test("resuming a child run directly keeps the parent-authored expression provenance", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    // The child gates on approval so the parent's run leaves it suspended
    // with `${{ env.HOME }}` still unresolved in its captured inputs.
    const childWorkflow = Workflow.create({
      name: "child-workflow",
      inputs: { properties: { home: { type: "string" } } },
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
            Step.create({
              name: "child-step",
              task: StepTask.modelMethod("some-model", "run", {
                home: "${{ inputs.home }}",
              }),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    const parentWorkflow = Workflow.create({
      name: "parent-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "call-child",
              task: StepTask.workflow("child-workflow", {
                home: "${{ env.HOME }}",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (const _ of service.run(parentWorkflow.name)) { /* drain */ }

    const childRuns = await runRepo.findAllByWorkflowId(childWorkflow.id);
    assertEquals(childRuns.length, 1);
    const suspended = childRuns[0];
    assertEquals(suspended.status, "suspended");
    assertEquals(
      suspended.deferredExpressions[0].expression,
      "${{ env.HOME }}",
    );
    assertEquals(
      suspended.inheritedExpressions.includes(String(suspended.inputs.home)),
      true,
    );
    // Only what the parent passed in is persisted; the child's own source
    // is re-collected on resume.
    assertEquals(
      suspended.inheritedExpressions.includes("${{ inputs.home }}"),
      false,
    );
    const parentRun = (await runRepo.findAllByWorkflowId(parentWorkflow.id))[0];
    assertEquals(parentRun.inheritedExpressions, []);

    const waiting = suspended.findWaitingApprovalStep()!;
    suspended.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(childWorkflow.id, suspended);

    for await (
      const _ of service.resume(childWorkflow.name, suspended.id)
    ) { /* drain */ }

    const childAuthored = executor.authoredByStep.get("child-step");
    const childRun = (await runRepo.findAllByWorkflowId(childWorkflow.id))[0];
    assertEquals(childRun.deferredExpressions[0].expression, "${{ env.HOME }}");
    assertEquals(childAuthored?.has(String(childRun.inputs.home)), true);
    assertEquals(childAuthored?.has("${{ inputs.home }}"), true);
  });
});

Deno.test("workflow step applies child defaults when parent passes no inputs", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    // Child workflow where ALL inputs have defaults (none required)
    const childWorkflow = Workflow.create({
      name: "child-workflow",
      inputs: {
        properties: {
          verbose: { type: "boolean", default: false },
        },
        required: [],
      },
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.modelMethod("some-model", "run", {
                verbose: "${{ inputs.verbose }}",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    // Parent invokes the child with NO inputs field at all
    const parentWorkflow = Workflow.create({
      name: "parent-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "call-child",
              task: StepTask.workflow("child-workflow"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: { kind: string; error?: string }[] = [];
    for await (const event of service.run(parentWorkflow.name)) {
      if (event.kind === "step_failed") {
        events.push({ kind: event.kind, error: event.error });
      }
    }

    const failures = events.filter((e) => e.kind === "step_failed");
    assertEquals(
      failures.length,
      0,
      `Child step should not fail when parent passes no inputs — defaults should apply. Failures: ${
        JSON.stringify(failures)
      }`,
    );
    assertEquals(executor.executedSteps.includes("job1/child-step"), true);
  });
});

Deno.test("evaluateWorkflow skips task.inputs with step-output dependencies", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ModelMethodMockExecutor();

    // Configure step1 to produce resource data
    executor.stepOutputs.set("create-vpc", {
      model: "vpc-model",
      resources: {
        "vpc": {
          id: "vpc-123",
          name: "vpc",
          version: 1,
          createdAt: "2024-01-01T00:00:00Z",
          attributes: { vpc_id: "vpc-abc123" },
          tags: { type: "resource" },
        },
      },
    });

    executor.stepOutputs.set("create-subnet", {
      model: "subnet-model",
    });

    // Create workflow where step2's task.inputs references step1's resource output
    const workflow = Workflow.create({
      name: "resource-in-task-inputs",
      jobs: [
        Job.create({
          name: "infra",
          steps: [
            Step.create({
              name: "create-vpc",
              task: StepTask.model("vpc-model", "create"),
            }),
            Step.create({
              name: "create-subnet",
              task: StepTask.model("subnet-model", "create", {
                vpc_id: "${{ model.vpc-model.resource.vpc.attributes.vpc_id }}",
              }),
              dependsOn: [
                {
                  step: "create-vpc",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    // This should NOT crash during evaluateWorkflow - the resource expression
    // in task.inputs should be skipped and evaluated at step execution time
    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, [
      "infra/create-vpc",
      "infra/create-subnet",
    ]);
  });
});

Deno.test("step executor receives correct workflow context", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Create a mock executor that captures context
    class ContextCapturingExecutor implements StepExecutor {
      capturedContexts: StepExecutionContext[] = [];
      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new ContextCapturingExecutor();

    const workflow = Workflow.create({
      name: "parent-workflow",
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
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    await service.execute(workflow.name);

    // Verify the context was propagated to the step executor
    assertEquals(executor.capturedContexts.length, 1);
    assertEquals(executor.capturedContexts[0].workflowName, "parent-workflow");
    assertEquals(executor.capturedContexts[0].jobName, "job1");
    assertEquals(executor.capturedContexts[0].stepName, "step1");
  });
});

// Regression test for issue #499: task.inputs matching definition input keys
// must be forwarded to the step executor, not filtered out.
Deno.test("task.inputs matching definition input keys are forwarded to step executor", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Executor that captures both the step and its context
    class InputCapturingExecutor implements StepExecutor {
      capturedSteps: Array<{ step: Step; ctx: StepExecutionContext }> = [];
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.capturedSteps.push({ step, ctx });
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new InputCapturingExecutor();

    // Create a workflow where step task.inputs include keys that would
    // typically match definition-level inputs.properties (e.g., "region",
    // "instance_type"). Before the fix, these were filtered out by
    // DefaultStepExecutor and never forwarded as method arguments.
    const workflow = Workflow.create({
      name: "input-forwarding-test",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "run-deploy",
              task: StepTask.model("my-model", "deploy", {
                region: "us-east-1",
                instance_type: "t3.micro",
                count: 3,
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.capturedSteps.length, 1);

    // Verify the step executor receives the task with all inputs intact
    const captured = executor.capturedSteps[0];
    const taskData = captured.step.task.data;
    assertEquals(taskData.type, "model_method");
    if (taskData.type === "model_method") {
      assertEquals(taskData.inputs, {
        region: "us-east-1",
        instance_type: "t3.micro",
        count: 3,
      });
    }

    // Verify the inputs are also available in the expression context
    // (WorkflowExecutionService merges workflow-level inputs; step-level
    // inputs are merged by DefaultStepExecutor at execution time)
    const exprCtx = captured.ctx.expressionContext;
    assertEquals(exprCtx !== undefined, true);
  });
});

// Regression test for issue #537 Bug A: workflow expressions must be evaluated
// before reaching the step executor.
Deno.test("workflow expressions are evaluated before step execution (Bug A)", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Executor that captures the step task data to verify expression resolution
    class TaskCapturingExecutor implements StepExecutor {
      capturedSteps: Array<{ step: Step; ctx: StepExecutionContext }> = [];
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.capturedSteps.push({ step, ctx });
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new TaskCapturingExecutor();

    // Create a workflow with an expression in the model name.
    // The expression ${{ inputs.deviceModel }} should be resolved
    // to the actual value before execution.
    const workflow = Workflow.create({
      name: "expression-eval-test",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "run-model",
              task: StepTask.model(
                "${{ inputs.deviceModel }}",
                "create",
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: { deviceModel: "my-device" },
    });

    assertEquals(run.status, "succeeded");
    assertEquals(executor.capturedSteps.length, 1);

    // The step executor should receive the resolved model name,
    // not the raw expression string.
    const captured = executor.capturedSteps[0];
    const taskData = captured.step.task.data;
    assertEquals(taskData.type, "model_method");
    if (taskData.type === "model_method") {
      assertEquals(taskData.modelIdOrName, "my-device");
      assertNotEquals(taskData.modelIdOrName, "${{ inputs.deviceModel }}");
    }
  });
});

// Regression test for issue #537 Bug B: --last-evaluated must still forward
// task.inputs and provide an expression context.
Deno.test("lastEvaluated mode carries task.inputs and expressionContext (Bug B)", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Executor that captures context for verification
    class ContextCapturingExecutor implements StepExecutor {
      capturedSteps: Array<{ step: Step; ctx: StepExecutionContext }> = [];
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.capturedSteps.push({ step, ctx });
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new ContextCapturingExecutor();

    // Create a workflow with task.inputs (values already resolved since
    // this simulates a pre-evaluated workflow)
    const workflow = Workflow.create({
      name: "last-evaluated-inputs-test",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "run-model",
              task: StepTask.model("my-model", "create", {
                region: "us-west-2",
                instance_type: "t3.large",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    // Pre-save the evaluated workflow so --last-evaluated can find it
    const { YamlEvaluatedWorkflowRepository } = await import(
      "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts"
    );
    const evalWorkflowRepo = new YamlEvaluatedWorkflowRepository(tempDir);
    await evalWorkflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      lastEvaluated: true,
    });

    assertEquals(run.status, "succeeded");
    assertEquals(executor.capturedSteps.length, 1);

    const captured = executor.capturedSteps[0];

    // The expression context should be provided even with --last-evaluated
    assertEquals(captured.ctx.expressionContext !== undefined, true);
    assertEquals(
      typeof captured.ctx.expressionContext?.model,
      "object",
    );
    assertEquals(
      typeof captured.ctx.expressionContext?.env,
      "object",
    );

    // task.inputs should be present on the step
    const taskData = captured.step.task.data;
    assertEquals(taskData.type, "model_method");
    if (taskData.type === "model_method") {
      assertEquals(taskData.inputs, {
        region: "us-west-2",
        instance_type: "t3.large",
      });
    }
  });
});

// allowFailure tests

Deno.test("step with allowFailure true fails but job still succeeds", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("optional-step");

    const workflow = Workflow.create({
      name: "allow-failure-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "optional-step",
              task: StepTask.model("test-model", "run"),
              allowFailure: true,
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(run.getJob("job1")?.status, "succeeded");
    const stepRun = run.getJob("job1")?.getStep("optional-step");
    assertEquals(stepRun?.status, "failed");
    assertEquals(stepRun?.allowedFailure, true);
  });
});

Deno.test("step with allowFailure true fails but workflow still succeeds", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("optional-step");

    const workflow = Workflow.create({
      name: "allow-failure-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "optional-step",
              task: StepTask.model("test-model", "run"),
              allowFailure: true,
            }),
            Step.create({
              name: "normal-step",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(
      run.getJob("job1")?.getStep("optional-step")?.status,
      "failed",
    );
    assertEquals(
      run.getJob("job1")?.getStep("optional-step")?.allowedFailure,
      true,
    );
    assertEquals(
      run.getJob("job1")?.getStep("normal-step")?.status,
      "succeeded",
    );
  });
});

Deno.test("downstream step with dependsOn succeeded skips when allowFailure step fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("optional-step");

    const workflow = Workflow.create({
      name: "allow-failure-skip-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "optional-step",
              task: StepTask.model("test-model", "run"),
              allowFailure: true,
            }),
            Step.create({
              name: "depends-on-success",
              task: StepTask.model("test-model", "run"),
              dependsOn: [
                {
                  step: "optional-step",
                  condition: TriggerCondition.succeeded(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(
      run.getJob("job1")?.getStep("optional-step")?.status,
      "failed",
    );
    assertEquals(
      run.getJob("job1")?.getStep("depends-on-success")?.status,
      "skipped",
    );
  });
});

Deno.test("downstream step with dependsOn completed runs when allowFailure step fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("optional-step");

    const workflow = Workflow.create({
      name: "allow-failure-completed-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "optional-step",
              task: StepTask.model("test-model", "run"),
              allowFailure: true,
            }),
            Step.create({
              name: "depends-on-completed",
              task: StepTask.model("test-model", "run"),
              dependsOn: [
                {
                  step: "optional-step",
                  condition: TriggerCondition.completed(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(
      run.getJob("job1")?.getStep("optional-step")?.status,
      "failed",
    );
    assertEquals(
      run.getJob("job1")?.getStep("depends-on-completed")?.status,
      "succeeded",
    );
  });
});

Deno.test("mix of allowFailure and regular failing steps causes job failure", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("optional-step");
    executor.shouldFail.add("required-step");

    const workflow = Workflow.create({
      name: "mixed-failure-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "optional-step",
              task: StepTask.model("test-model", "run"),
              allowFailure: true,
            }),
            Step.create({
              name: "required-step",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "failed");
    assertEquals(run.getJob("job1")?.status, "failed");
    assertEquals(
      run.getJob("job1")?.getStep("optional-step")?.allowedFailure,
      true,
    );
    assertEquals(
      run.getJob("job1")?.getStep("required-step")?.status,
      "failed",
    );
    assertEquals(
      run.getJob("job1")?.getStep("required-step")?.allowedFailure,
      false,
    );
  });
});

// allowFailure tests for workflow-type task steps (issue #1061)

Deno.test("workflow-task step with allowFailure true: child fails, step marked allowedFailure, job succeeds", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("child-step");

    const childWorkflow = Workflow.create({
      name: "child-that-fails",
      jobs: [
        Job.create({
          name: "child-job",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    const parentWorkflow = Workflow.create({
      name: "parent-allow-failure",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "optional-workflow-step",
              task: StepTask.workflow("child-that-fails"),
              allowFailure: true,
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(parentWorkflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(run.getJob("job1")?.status, "succeeded");
    const stepRun = run.getJob("job1")?.getStep("optional-workflow-step");
    assertEquals(stepRun?.status, "failed");
    assertEquals(stepRun?.allowedFailure, true);
  });
});

Deno.test("workflow-task step with allowFailure true: downstream completed dep runs after child fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("child-step");

    const childWorkflow = Workflow.create({
      name: "child-that-fails",
      jobs: [
        Job.create({
          name: "child-job",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    const parentWorkflow = Workflow.create({
      name: "parent-completed-dep",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "first",
              task: StepTask.workflow("child-that-fails"),
              allowFailure: true,
            }),
            Step.create({
              name: "second",
              task: StepTask.model("test-model", "run"),
              dependsOn: [{
                step: "first",
                condition: TriggerCondition.completed(),
              }],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(parentWorkflow.name);

    assertEquals(run.status, "succeeded");
    const firstStep = run.getJob("job1")?.getStep("first");
    assertEquals(firstStep?.status, "failed");
    assertEquals(firstStep?.allowedFailure, true);
    const secondStep = run.getJob("job1")?.getStep("second");
    assertEquals(secondStep?.status, "succeeded");
  });
});

Deno.test("workflow-task step without allowFailure: child fails, job fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("child-step");

    const childWorkflow = Workflow.create({
      name: "child-that-fails",
      jobs: [
        Job.create({
          name: "child-job",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    const parentWorkflow = Workflow.create({
      name: "parent-no-allow-failure",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "workflow-step",
              task: StepTask.workflow("child-that-fails"),
            }),
            Step.create({
              name: "second",
              task: StepTask.model("test-model", "run"),
              dependsOn: [{
                step: "workflow-step",
                condition: TriggerCondition.completed(),
              }],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(parentWorkflow.name);

    assertEquals(run.status, "failed");
    assertEquals(run.getJob("job1")?.status, "failed");
    const stepRun = run.getJob("job1")?.getStep("workflow-step");
    assertEquals(stepRun?.status, "failed");
    assertEquals(stepRun?.allowedFailure, false);
    assertEquals(run.getJob("job1")?.getStep("second")?.status, "succeeded");
  });
});

// Issue #947: Check skip options and swampSha propagation through StepExecutionContext
Deno.test("check skip options and swampSha are threaded to step context", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class ContextCapturingExecutor implements StepExecutor {
      capturedContexts: StepExecutionContext[] = [];
      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new ContextCapturingExecutor();

    const workflow = Workflow.create({
      name: "skip-options-test",
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
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (
      const _event of service.run(workflow.name, {
        skipCheckNames: ["policy-check"],
        skipCheckLabels: ["live"],
        skipAllChecks: false,
        swampSha: "abc123",
      })
    ) {
      // Drain events
    }

    assertEquals(executor.capturedContexts.length, 1);
    const ctx = executor.capturedContexts[0];
    assertEquals(ctx.skipCheckNames, ["policy-check"]);
    assertEquals(ctx.skipCheckLabels, ["live"]);
    assertEquals(ctx.skipAllChecks, false);
    assertEquals(ctx.swampSha, "abc123");
  });
});

// --- report execution without CLI report flags (swamp-club#640) ---
//
// Callers that don't thread reportFilterOptions (workflow resume, embedded
// runs) must still execute reports — before #640 the absent options object
// silently skipped all workflow-scope and step-scope reports.

Deno.test("run() executes workflow-scope required reports when reportFilterOptions is not supplied", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const reportName = "@test640/wf-required";
    if (!reportRegistry.get(reportName)) {
      reportRegistry.register(reportName, {
        description: "issue 640 regression report",
        scope: "workflow",
        execute: () =>
          Promise.resolve({ markdown: "# 640", json: { ok: true } }),
      });
    }

    const workflow = Workflow.create({
      name: "issue-640-require-test",
      reports: { require: [reportName] },
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
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const completedReports: string[] = [];
    // No reportFilterOptions passed — reports must still run.
    for await (const event of service.run(workflow.name, {})) {
      if (event.kind === "report_completed") {
        completedReports.push(event.reportName);
      }
    }

    assertEquals(completedReports.includes(reportName), true);
  });
});

Deno.test("run() defaults reportFilterOptions in step context when not supplied", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class ContextCapturingExecutor implements StepExecutor {
      capturedContexts: StepExecutionContext[] = [];
      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new ContextCapturingExecutor();

    const workflow = Workflow.create({
      name: "issue-640-default-filter-test",
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
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (const _event of service.run(workflow.name, {})) {
      // Drain events
    }

    assertEquals(executor.capturedContexts.length, 1);
    assertEquals(executor.capturedContexts[0].reportFilterOptions, {});
  });
});

// --- forEach step name expansion regression tests (Issue #976 / PR #973) ---

Deno.test("expandForEachSteps: multi-expression step name produces unique names for items sharing a field", async () => {
  // Regression: before PR #973, only the first ${{ }} was resolved which caused
  // duplicate step names when items shared the first field but differed in the second.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "multi-expr-foreach",
      jobs: [
        Job.create({
          name: "process",
          steps: [
            Step.create({
              name: "${{ self.ep.show }}-${{ self.ep.title }}",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "ep",
                in: "${{ inputs.episodes }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: {
        episodes: [
          { show: "Trek", title: "Pilot" },
          { show: "Trek", title: "Finale" },
          { show: "Wars", title: "Pilot" },
        ],
      },
    });

    assertEquals(run.status, "succeeded");

    // All three expanded step names must be unique and fully resolved
    const stepNames = executor.executedSteps.map((s) => s.split("/")[1]);
    assertEquals(stepNames.length, 3);
    assertEquals(stepNames.includes("Trek-Pilot"), true);
    assertEquals(stepNames.includes("Trek-Finale"), true);
    assertEquals(stepNames.includes("Wars-Pilot"), true);

    // Verify uniqueness — the set size equals the array length
    assertEquals(new Set(stepNames).size, stepNames.length);
  });
});

Deno.test("expandForEachSteps: single-expression step name resolves correctly", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "single-expr-foreach",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "deploy-${{ self.env }}",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "env",
                in: "${{ inputs.environments }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: {
        environments: ["dev", "staging", "prod"],
      },
    });

    assertEquals(run.status, "succeeded");

    const stepNames = executor.executedSteps.map((s) => s.split("/")[1]);
    assertEquals(stepNames.length, 3);
    assertEquals(stepNames.includes("deploy-dev"), true);
    assertEquals(stepNames.includes("deploy-staging"), true);
    assertEquals(stepNames.includes("deploy-prod"), true);
  });
});

Deno.test("expandForEachSteps: step name without expressions appends item value", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "no-expr-foreach",
      jobs: [
        Job.create({
          name: "process",
          steps: [
            Step.create({
              name: "step",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "val",
                in: "${{ inputs.items }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: {
        items: ["alpha", "beta"],
      },
    });

    assertEquals(run.status, "succeeded");

    // Without expression templates, the step name is appended with the item value
    const stepNames = executor.executedSteps.map((s) => s.split("/")[1]);
    assertEquals(stepNames.length, 2);
    assertEquals(stepNames.includes("step-alpha"), true);
    assertEquals(stepNames.includes("step-beta"), true);
  });
});

Deno.test("expandForEachSteps: object iteration with multi-expression step name", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "obj-foreach",
      jobs: [
        Job.create({
          name: "configure",
          steps: [
            Step.create({
              name: "${{ self.svc.key }}-${{ self.svc.value }}",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "svc",
                in: "${{ inputs.services }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: {
        services: { web: 8080, api: 3000, db: 5432 },
      },
    });

    assertEquals(run.status, "succeeded");

    const stepNames = executor.executedSteps.map((s) => s.split("/")[1]);
    assertEquals(stepNames.length, 3);
    assertEquals(stepNames.includes("web-8080"), true);
    assertEquals(stepNames.includes("api-3000"), true);
    assertEquals(stepNames.includes("db-5432"), true);

    // Verify uniqueness
    assertEquals(new Set(stepNames).size, stepNames.length);
  });
});

// Regression test for issue #975: forEach expression evaluation failure should
// append index to prevent duplicate step names.
Deno.test("expandForEachSteps: appends index when array item expression evaluation fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    // Create workflow where forEach iterates an array, and the step name
    // references a property that doesn't exist on the items.
    // Both items will fail expression evaluation, but the index suffix
    // should prevent duplicate names.
    const workflow = Workflow.create({
      name: "foreach-eval-fail-array",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "process-${{ self.item.missingField }}",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "item",
                in: "${{ inputs.items }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: { items: [{ a: 1 }, { a: 2 }] },
    });

    assertEquals(run.status, "succeeded");
    // Each expanded step should have a unique name with index suffix
    assertEquals(executor.executedSteps.length, 2);
    assertEquals(
      executor.executedSteps.includes(
        "job1/process-${{ self.item.missingField }}-0",
      ),
      true,
    );
    assertEquals(
      executor.executedSteps.includes(
        "job1/process-${{ self.item.missingField }}-1",
      ),
      true,
    );
  });
});

// Regression test for issue #975: forEach expression evaluation failure over
// object iteration should append key to prevent duplicate step names.
Deno.test("expandForEachSteps: appends key when object item expression evaluation fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    // Create workflow where forEach iterates an object, and the step name
    // references a property that doesn't exist on the items.
    const workflow = Workflow.create({
      name: "foreach-eval-fail-object",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "process-${{ self.entry.missingField }}",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "entry",
                in: "${{ inputs.items }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: { items: { alpha: "one", beta: "two" } },
    });

    assertEquals(run.status, "succeeded");
    // Each expanded step should have a unique name with key suffix
    assertEquals(executor.executedSteps.length, 2);
    assertEquals(
      executor.executedSteps.includes(
        "job1/process-${{ self.entry.missingField }}-alpha",
      ),
      true,
    );
    assertEquals(
      executor.executedSteps.includes(
        "job1/process-${{ self.entry.missingField }}-beta",
      ),
      true,
    );
  });
});

// Verify that forEach with successful expression evaluation still works without
// appending index/key suffix.
Deno.test("expandForEachSteps: does not append index when expression evaluates successfully", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "foreach-eval-success",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "process-${{ self.item.name }}",
              task: StepTask.model("test-model", "run"),
              forEach: {
                item: "item",
                in: "${{ inputs.items }}",
              },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: { items: [{ name: "foo" }, { name: "bar" }] },
    });

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 2);
    // Names should be resolved without index suffix
    assertEquals(
      executor.executedSteps.includes("job1/process-foo"),
      true,
    );
    assertEquals(
      executor.executedSteps.includes("job1/process-bar"),
      true,
    );
  });
});

// Regression test for lab issue #35: workflow-path MethodContext must carry
// dataQueryService (and therefore a derived queryData) so extension methods
// invoked as workflow steps can call context.queryData. Guards the factory
// call site in DefaultStepExecutor.executeModelMethod.
Deno.test("DefaultStepExecutor wires dataQueryService into MethodContext", async () => {
  const { z } = await import("zod");
  const { ModelType } = await import("../models/model_type.ts");
  const { modelRegistry } = await import("../models/model.ts");
  const { Definition } = await import("../definitions/definition.ts");
  const { YamlDefinitionRepository } = await import(
    "../../infrastructure/persistence/yaml_definition_repository.ts"
  );
  const { initializeLogging } = await import(
    "../../infrastructure/logging/logger.ts"
  );
  await initializeLogging({});

  await withTempDir(async (tempDir) => {
    const typeName = `@test-issue35/capture-${crypto.randomUUID().slice(0, 8)}`;
    const modelType = ModelType.create(typeName);
    let capturedDataQueryService: unknown;
    let capturedQueryData: unknown;

    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {
        run: {
          description: "captures context for regression assertions",
          arguments: z.object({}),
          execute: (_args, context) => {
            capturedDataQueryService = context.dataQueryService;
            capturedQueryData = context.queryData;
            return Promise.resolve({});
          },
        },
      },
    });

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      const definitionRepo = new YamlDefinitionRepository(tempDir);
      const instance = Definition.create({
        name: "capture-instance",
        type: modelType.normalized,
      });
      await definitionRepo.save(modelType, instance);

      const step = Step.create({
        name: "capture-step",
        task: StepTask.model("capture-instance", "run"),
      });
      const ctx: StepExecutionContext = {
        workflowId: createWorkflowId("00000000-0000-0000-0000-000000000000"),
        workflowRunId: "00000000-0000-0000-0000-000000000000",
        workflowName: "regression",
        jobName: "job1",
        stepName: "capture-step",
        repoDir: tempDir,
        signal: new AbortController().signal,
        step,
        catalogStore,
        authoredExpressions: new Set(),
      };

      const executor = new DefaultStepExecutor();
      await executor.execute(step, ctx);

      assertNotEquals(capturedDataQueryService, undefined);
      assertNotEquals(capturedQueryData, undefined);
      assertEquals(typeof capturedQueryData, "function");
    } finally {
      catalogStore.close();
    }
  });
});

// swamp-club#2397 / #2455: a step runs a model whose own definition holds the
// expressions. Records the arguments each method actually receives.
async function runDefinitionStep(
  definitionProps: Parameters<typeof Definition.create>[0],
  methodName: string,
  stepInputs: Record<string, unknown> | undefined,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const { z } = await import("zod");
  const { modelRegistry } = await import("../models/model.ts");
  const { initializeLogging } = await import(
    "../../infrastructure/logging/logger.ts"
  );
  await initializeLogging({});

  const received: Record<string, unknown>[] = [];
  await withTempDir(async (tempDir) => {
    const modelType = ModelType.create(
      `@test-2397/capture-${crypto.randomUUID().slice(0, 8)}`,
    );
    const method = {
      description: "records its arguments",
      arguments: z.object({ value: z.string() }),
      execute: (args: { value: string }) => {
        received.push(args);
        return Promise.resolve({});
      },
    };
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        cidr: z.string().optional(),
        target: z.string().optional(),
      }),
      resources: {},
      methods: { execute: method, delete: method },
    });

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      const definition = Definition.create({
        ...definitionProps,
        type: modelType.normalized,
      });
      await new YamlDefinitionRepository(tempDir).save(modelType, definition);

      const step = Step.create({
        name: "step",
        task: StepTask.model(definition.name, methodName, stepInputs),
      });
      await new DefaultStepExecutor().execute(step, {
        workflowId: createWorkflowId(crypto.randomUUID()),
        workflowRunId: crypto.randomUUID(),
        workflowName: "wf",
        jobName: "job",
        stepName: "step",
        repoDir: tempDir,
        signal: new AbortController().signal,
        step,
        catalogStore,
        authoredExpressions: new Set(),
        expressionContext: { model: {}, env: {}, inputs },
      });
    } finally {
      catalogStore.close();
    }
  });
  return received;
}

Deno.test({
  name:
    "DefaultStepExecutor: fails the step with the CEL error when the method's own argument failed to evaluate (swamp-club#2397)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const error = await assertRejects(() =>
      runDefinitionStep(
        {
          name: "consumer",
          inputs: { properties: { cfg: { type: "object" } } },
          methods: {
            execute: { arguments: { value: "${{ inputs.cfg.nope }}" } },
          },
        },
        "execute",
        undefined,
        { cfg: {} },
      )
    );
    assertStringIncludes(
      (error as Error).message,
      "Expression in methods.execute.arguments.value could not be evaluated",
    );
    assertStringIncludes((error as Error).message, "No such key: nope");
  },
});

Deno.test({
  name:
    "DefaultStepExecutor: a step input replacing the failed argument lets the method run",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const received = await runDefinitionStep(
      {
        name: "consumer",
        inputs: { properties: { cfg: { type: "object" } } },
        methods: {
          execute: { arguments: { value: "${{ inputs.cfg.nope }}" } },
        },
      },
      "execute",
      { value: "overridden" },
      { cfg: {} },
    );
    assertEquals(received, [{ value: "overridden" }]);
  },
});

Deno.test({
  name:
    "DefaultStepExecutor: a delete step still runs when create-time inputs are absent (#653)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const received = await runDefinitionStep(
      {
        name: "subnet",
        globalArguments: { cidr: "${{ inputs.cidrBlock }}" },
        methods: {
          execute: { arguments: { value: "${{ inputs.cidrBlock }}" } },
          delete: { arguments: { value: "${{ inputs.instanceName }}" } },
        },
      },
      "delete",
      undefined,
      { instanceName: "public-a" },
    );
    assertEquals(received, [{ value: "public-a" }]);
  },
});

Deno.test({
  name:
    "DefaultStepExecutor: self.globalArguments in a method argument sees the evaluated global argument (swamp-club#2455)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const received = await runDefinitionStep(
      {
        name: "web",
        globalArguments: { target: "${{ 'web-' + inputs.host }}" },
        methods: {
          execute: {
            arguments: { value: "${{ self.globalArguments.target }}" },
          },
        },
      },
      "execute",
      undefined,
      { host: "a" },
    );
    assertEquals(received, [{ value: "web-a" }]);
  },
});

Deno.test({
  name:
    "DefaultStepExecutor: another service's template syntax reaches the method unchanged (swamp-club#2424)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const received = await runDefinitionStep(
      {
        name: "dd-monitor",
        globalArguments: { target: "bitbison crashed on {{host.name}}" },
        methods: {
          execute: {
            arguments: {
              value: "{{#is_alert}}crashed on {{host.name}}{{/is_alert}}",
            },
          },
        },
      },
      "execute",
      undefined,
      {},
    );
    assertEquals(received, [{
      value: "{{#is_alert}}crashed on {{host.name}}{{/is_alert}}",
    }]);
  },
});

Deno.test({
  name:
    "DefaultStepExecutor: a dropped $ on a swamp expression still fails the step",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const error = await assertRejects(() =>
      runDefinitionStep(
        {
          name: "dd-monitor",
          methods: { execute: { arguments: { value: "{{self.name}}" } } },
        },
        "execute",
        undefined,
        {},
      )
    );
    assertStringIncludes(
      (error as Error).message,
      'Model validation failed for "dd-monitor"',
    );
    assertStringIncludes((error as Error).message, "{{self.name}}");
  },
});

// --- forEach.in async helper resolution (Issue #88) ---

Deno.test({
  name: "expandForEachSteps: awaits async data helpers like data.findBySpec",
  // CatalogStore opens WAL files internally; these are still held by the
  // time the test returns so resource sanitization is disabled.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withTempDir(async (tempDir) => {
      const workflowRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryWorkflowRunRepository();
      const executor = new MockStepExecutor();

      const workflow = Workflow.create({
        name: "async-foreach",
        jobs: [
          Job.create({
            name: "download",
            steps: [
              Step.create({
                name: "process-${{ self.ep.name }}",
                task: StepTask.model("test-model", "run"),
                forEach: {
                  item: "ep",
                  in: '${{ data.findBySpec("producer", "result") }}',
                },
              }),
            ],
          }),
        ],
      });
      await workflowRepo.save(workflow);

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      try {
        const service = new WorkflowExecutionService(
          workflowRepo,
          runRepo,
          tempDir,
          executor,
          undefined,
          catalogStore,
        );

        // data.findBySpec returns a Promise; expandForEachSteps awaits it
        // via CelEvaluator.evaluateAsync. With no seeded data the result
        // is an empty array, the forEach expands to zero steps, and the
        // job completes without producing the old "unresolved Promise"
        // error that this test previously asserted.
        await service.execute(workflow.name);
      } finally {
        catalogStore.close();
      }
    });
  },
});

// =============================================================================
// CONTRACT TESTS — pin behavioural invariants of WorkflowExecutionService
// across the planned execution_service.ts refactor.
//
// These tests are framed as "CONTRACT:" rather than "tests of behaviour" so
// future contributors know they exist to detect *behavioural drift* across
// refactor commits, not to characterise a single feature. Failure means a
// later commit changed an observable property the system depended on.
//
// Pairs with the integration-level harness at /tmp/swamp-verification/, which
// pins contracts that require real filesystem repos (vault redaction, report
// failure isolation, --last-evaluated parity).
// =============================================================================

/**
 * Decorates a WorkflowRunRepository to record every `save` call. Used to
 * pin the order of run-state persistence relative to workflow lifecycle.
 */
class TrackingRunRepository implements WorkflowRunRepository {
  private readonly inner = new InMemoryWorkflowRunRepository();
  readonly saves: Array<{ runId: string; status: string }> = [];

  findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    return this.inner.findById(workflowId, runId);
  }

  findAllByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun[]> {
    return this.inner.findAllByWorkflowId(workflowId);
  }

  findLatestByWorkflowId(
    workflowId: WorkflowId,
  ): Promise<WorkflowRun | null> {
    return this.inner.findLatestByWorkflowId(workflowId);
  }

  findAllGlobal(): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    return this.inner.findAllGlobal();
  }

  findAllGlobalSince(
    cutoff: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    return this.inner.findAllGlobalSince(cutoff);
  }

  findGlobalByStatus(
    status: string | string[],
    since?: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    return this.inner.findGlobalByStatus(status, since);
  }

  save(workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    this.saves.push({ runId: run.id, status: run.status });
    return this.inner.save(workflowId, run);
  }

  nextId(): WorkflowRunId {
    return this.inner.nextId();
  }

  getPath(workflowId: WorkflowId, runId: WorkflowRunId): string {
    return this.inner.getPath(workflowId, runId);
  }

  deleteAllByWorkflowId(workflowId: WorkflowId): Promise<number> {
    return this.inner.deleteAllByWorkflowId(workflowId);
  }

  deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }> {
    return this.inner.deleteOlderThan(cutoff, options);
  }
}

Deno.test("CONTRACT: success run emits events in exact order", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: string[] = [];
    for await (const event of service.run(workflow.name)) {
      events.push(event.kind);
    }

    assertEquals(events, [
      "started",
      "job_started",
      "step_started",
      "step_completed",
      "job_completed",
      // Workflow-scope reports run even without reportFilterOptions
      // (swamp-club#640) — builtin workflow reports emit here.
      "report_started",
      "report_completed",
      "completed",
    ]);
  });
});

Deno.test("CONTRACT: step failure emits events in exact order", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("step1");

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: string[] = [];
    let finalRun: WorkflowRun | undefined;
    for await (const event of service.run(workflow.name)) {
      events.push(event.kind);
      if (event.kind === "completed") finalRun = event.run;
    }

    assertEquals(events, [
      "started",
      "job_started",
      "step_started",
      "step_failed",
      "job_completed",
      // Workflow-scope reports run even without reportFilterOptions
      // (swamp-club#640) — builtin workflow reports emit here.
      "report_started",
      "report_completed",
      "completed",
    ]);
    // The workflow itself must reflect failure even though the lifecycle
    // emits "completed" rather than a separate "failed" terminal event.
    assertEquals(finalRun?.status, "failed");
  });
});

Deno.test("CONTRACT: run is persisted at start, after each level, and at completion", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new TrackingRunRepository();
    const executor = new MockStepExecutor();

    // Two-level workflow: level 1 = "build", level 2 = "test" (depends on build).
    const workflow = Workflow.create({
      name: "two-level-pin",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "compile",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "test",
          steps: [
            Step.create({
              name: "unit",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    await service.execute(workflow.name);

    // Persistence contract for two-level workflow: 6 saves —
    //   1. After run.start() (status: running, before any level)
    //   2. After step "compile" completes (per-step checkpoint)
    //   3. After level 1 completes (level backstop)
    //   4. After step "unit" completes (per-step checkpoint)
    //   5. After level 2 completes (level backstop)
    //   6. After run.complete() (status: succeeded)
    assertEquals(
      runRepo.saves.length,
      6,
      `expected 6 saves, got ${runRepo.saves.length}: ${
        JSON.stringify(runRepo.saves)
      }`,
    );
    assertEquals(runRepo.saves[0].status, "running");
    assertEquals(runRepo.saves[runRepo.saves.length - 1].status, "succeeded");
    // All saves reference the same run id.
    const ids = new Set(runRepo.saves.map((s) => s.runId));
    assertEquals(ids.size, 1);
  });
});

Deno.test("CONTRACT: dataArtifacts attached to thrown error are preserved on the failed step run", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Custom executor that throws an error carrying dataArtifacts, mimicking
    // DefaultStepExecutor's behaviour when a model writes data then fails
    // (e.g. verdict=FAIL after data persistence).
    const partialArtifacts = [
      {
        dataId: crypto.randomUUID(),
        name: "partial-result",
        version: 1,
        tags: { source: "test" },
      },
    ];
    const failingExecutor: StepExecutor = {
      execute(_step: Step, _ctx: StepExecutionContext): Promise<unknown> {
        const err = new Error("step failed after writing partial data") as
          & Error
          & { dataArtifacts?: typeof partialArtifacts };
        err.dataArtifacts = partialArtifacts;
        return Promise.reject(err);
      },
    };

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      failingExecutor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    const stepRun = run.getJob("job1")?.getStep("step1");
    assertEquals(stepRun?.status, "failed");
    // The whole point: artifacts written before the throw must survive on
    // the StepRun so they appear in `swamp data get --workflow` later.
    assertEquals(stepRun?.dataArtifacts.length, 1);
    assertEquals(stepRun?.dataArtifacts[0].name, "partial-result");
    assertEquals(stepRun?.dataArtifacts[0].dataId, partialArtifacts[0].dataId);
  });
});

// --- forEach self.* in modelIdOrName resolution (Issue #294) ---

Deno.test({
  name:
    "DefaultStepExecutor resolves self.* expressions in modelIdOrName before model lookup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { z } = await import("zod");
    const { ModelType } = await import("../models/model_type.ts");
    const { modelRegistry } = await import("../models/model.ts");
    const { Definition } = await import("../definitions/definition.ts");
    const { YamlDefinitionRepository } = await import(
      "../../infrastructure/persistence/yaml_definition_repository.ts"
    );
    const { initializeLogging } = await import(
      "../../infrastructure/logging/logger.ts"
    );
    const { buildEnvContext } = await import(
      "../expressions/model_resolver.ts"
    );
    await initializeLogging({});

    await withTempDir(async (tempDir) => {
      const typeName = `@test-issue294/foreach-${
        crypto.randomUUID().slice(0, 8)
      }`;
      const modelType = ModelType.create(typeName);
      let methodExecuted = false;

      modelRegistry.register({
        type: modelType,
        version: "2026.01.01.1",
        globalArguments: z.object({}),
        resources: {},
        methods: {
          run: {
            description: "confirms model was found and method executed",
            arguments: z.object({}),
            execute: () => {
              methodExecuted = true;
              return Promise.resolve({});
            },
          },
        },
      });

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      try {
        const definitionRepo = new YamlDefinitionRepository(tempDir);
        const instance = Definition.create({
          name: "test-us-east-1",
          type: modelType.normalized,
        });
        await definitionRepo.save(modelType, instance);

        const step = Step.create({
          name: "run-us-east-1",
          task: StepTask.model(
            "test-${{ self.region }}",
            "run",
          ),
        });
        const ctx: StepExecutionContext = {
          workflowId: createWorkflowId(
            "00000000-0000-0000-0000-000000000000",
          ),
          workflowRunId: "00000000-0000-0000-0000-000000000000",
          workflowName: "foreach-test",
          jobName: "job1",
          stepName: "run-us-east-1",
          repoDir: tempDir,
          signal: new AbortController().signal,
          step,
          expressionContext: {
            model: {},
            env: buildEnvContext(),
            self: {
              id: "",
              name: "",
              version: 1,
              tags: {},
              globalArguments: {},
              region: "us-east-1",
            },
          },
          authoredExpressions: new Set(["${{ self.region }}"]),
          forEachVariable: { name: "region", value: "us-east-1" },
          catalogStore,
        };

        const executor = new DefaultStepExecutor();
        await executor.execute(step, ctx);

        assertEquals(methodExecuted, true);
      } finally {
        catalogStore.close();
      }
    });
  },
});

// ---------------------------------------------------------------------------
// run.* namespace in CEL expressions
// ---------------------------------------------------------------------------

Deno.test("run.id expression in step inputs resolves to the workflow run UUID", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const capturedContexts: StepExecutionContext[] = [];
    const capturingExecutor: StepExecutor = {
      execute(
        _step: Step,
        ctx: StepExecutionContext,
      ): Promise<unknown> {
        capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "run-id-test",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "s",
              task: StepTask.model("test-model", "run", {
                scopedKey: "result-${{ run.id }}",
                wfName: "${{ run.workflowName }}",
              }),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      capturingExecutor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(capturedContexts.length, 1);

    const ctx = capturedContexts[0];
    assertNotEquals(ctx.expressionContext?.run, undefined);
    assertEquals(ctx.expressionContext?.run?.id, run.id);
    assertEquals(ctx.expressionContext?.run?.workflowName, "run-id-test");
    assertNotEquals(ctx.expressionContext?.run?.startedAt, undefined);
  });
});

Deno.test("resume: run.id expression in step inputs resolves after suspend+resume", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const capturedContexts: StepExecutionContext[] = [];
    const capturingExecutor: StepExecutor = {
      execute(
        _step: Step,
        ctx: StepExecutionContext,
      ): Promise<unknown> {
        capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "run-id-resume-test",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
            Step.create({
              name: "s",
              task: StepTask.model("test-model", "run", {
                scopedKey: "result-${{ run.id }}",
                wfName: "${{ run.workflowName }}",
              }),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      capturingExecutor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");
    assertEquals(capturedContexts.length, 0);

    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    let resumedRun: WorkflowRun | undefined;
    for await (
      const event of service.resume(workflow.name, suspended.id)
    ) {
      if (event.kind === "completed") resumedRun = event.run;
    }

    assertEquals(resumedRun?.status, "succeeded");
    assertEquals(capturedContexts.length, 1);

    const ctx = capturedContexts[0];
    assertNotEquals(ctx.expressionContext?.run, undefined);
    assertEquals(ctx.expressionContext?.run?.id, suspended.id);
    assertEquals(
      ctx.expressionContext?.run?.workflowName,
      "run-id-resume-test",
    );
    assertNotEquals(ctx.expressionContext?.run?.startedAt, undefined);
  });
});

Deno.test("resume: workflowRunId expression resolves after suspend+resume", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const capturedContexts: StepExecutionContext[] = [];
    const capturingExecutor: StepExecutor = {
      execute(
        _step: Step,
        ctx: StepExecutionContext,
      ): Promise<unknown> {
        capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "wfrunid-resume-test",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
            Step.create({
              name: "s",
              task: StepTask.model("test-model", "run", {
                runRef: "${{ workflowRunId }}",
              }),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      capturingExecutor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");

    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    let resumedRun: WorkflowRun | undefined;
    for await (
      const event of service.resume(workflow.name, suspended.id)
    ) {
      if (event.kind === "completed") resumedRun = event.run;
    }

    assertEquals(resumedRun?.status, "succeeded");
    assertEquals(capturedContexts.length, 1);

    const ctx = capturedContexts[0];
    assertEquals(
      ctx.expressionContext?.workflowRunId,
      suspended.id,
    );
  });
});

Deno.test(
  "stepNameFromCompositeKey: preserves colons in the step name segment",
  () => {
    const cases: Array<[string, string]> = [
      ["job1:step1", "step1"],
      ["job1:docker:build", "docker:build"],
      ["job1:a:b:c", "a:b:c"],
      ["jobOnly", ""],
      ["", ""],
    ];
    for (const [key, expected] of cases) {
      assertEquals(stepNameFromCompositeKey(key), expected, `key=${key}`);
    }
  },
);

// Issue #467: resume --input merges override inputs over the inputs captured
// when the run suspended.
Deno.test("resume merges override inputs over the suspended run's inputs", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    // Captures the expression context seen by the post-gate step.
    class ContextCapturingExecutor implements StepExecutor {
      captured: Array<{ step: Step; ctx: StepExecutionContext }> = [];
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.captured.push({ step, ctx });
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new ContextCapturingExecutor();

    // Gate suspends the run; the deploy step after it consumes inputs.* once
    // resumed.
    const workflow = Workflow.create({
      name: "deploy-with-gate",
      jobs: [
        Job.create({
          name: "rollout",
          steps: [
            Step.create({
              name: "verify",
              task: StepTask.manualApproval("Verify SSH before harden"),
            }),
            Step.create({
              name: "harden",
              task: StepTask.model("harden-model", "run", {
                // Both inputs are declared at the original run (strict
                // evaluation requires referenced inputs to exist). Resume
                // supplies updated values that the merge applies.
                region: "${{ inputs.region }}",
                authKey: "${{ inputs.authKey }}",
              }),
              dependsOn: [
                { step: "verify", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    // Original run declares all referenced inputs; authKey starts as a
    // placeholder whose real value is only minted during the gate.
    const suspended = await service.execute(workflow.name, {
      inputs: { region: "us-east", env: "prod", authKey: "PENDING" },
    });

    assertEquals(suspended.status, "suspended");
    // Effective inputs are captured at suspend so they survive to resume.
    assertEquals(suspended.inputs, {
      region: "us-east",
      env: "prod",
      authKey: "PENDING",
    });
    assertEquals(suspended.resumeInputs, []);
    // The gate has not reached the executor.
    assertEquals(executor.captured.length, 0);

    // Approve: mark the gate step succeeded so resume can proceed.
    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    // Resume with the freshly minted auth key and a region override.
    let resumedRun: WorkflowRun | undefined;
    for await (
      const event of service.resume(workflow.name, suspended.id, {
        inputs: { region: "us-west", authKey: "tskey-abc123" },
      })
    ) {
      if (event.kind === "completed") resumedRun = event.run;
    }

    assertEquals(resumedRun?.status, "succeeded");

    // The harden step ran and saw the merged inputs: resume overrides win on
    // `region` and `authKey`, while the original `env` is preserved.
    assertEquals(executor.captured.length, 1);
    assertEquals(executor.captured[0].step.name, "harden");
    assertEquals(executor.captured[0].ctx.expressionContext?.inputs, {
      region: "us-west",
      env: "prod",
      authKey: "tskey-abc123",
    });

    // The overrides propagate into the resolved task inputs forwarded to the
    // step: both `region` and `authKey` resolved to the resume values.
    const hardenTask = executor.captured[0].step.task.data;
    if (hardenTask.type === "model_method") {
      const inputs = hardenTask.inputs as Record<string, unknown> | undefined;
      assertEquals(inputs?.region, "us-west");
      assertEquals(inputs?.authKey, "tskey-abc123");
    }

    // Audit records only the resume-time KEY NAMES, never the secret values.
    const persisted = await runRepo.findById(workflow.id, suspended.id);
    assertEquals([...persisted!.resumeInputs].sort(), ["authKey", "region"]);
    assertEquals(
      JSON.stringify(persisted!.resumeInputs).includes("tskey-abc123"),
      false,
    );
  });
});

// Regression for #1118: the per-run workflow log file is opened by
// runFileSink.register() and must be released even when a streaming consumer
// abandons the event generator early (e.g. a WebSocket client that disconnects
// mid-run, breaking the `for await` loop). The cleanup lives in a `finally`, so
// generator.return() unwinds it. Asserting on runFileSink.activeCount rather
// than raw OS file descriptors keeps the test portable across platforms; a
// before/after delta (not an absolute count) tolerates handles registered by
// other tests sharing the process-wide singleton.
Deno.test("run() releases the log file sink when the consumer abandons the stream early", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const baseline = runFileSink.activeCount;
    let sinkOpenAtStarted = false;
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "started") {
        // register() runs before the "started" event, so the log sink is open.
        sinkOpenAtStarted = runFileSink.activeCount === baseline + 1;
        break; // abandon the generator mid-run (mirrors a client disconnect)
      }
    }

    assertEquals(sinkOpenAtStarted, true);
    // The finally must have unregistered the handle despite the early break.
    assertEquals(runFileSink.activeCount, baseline);
  });
});

// Regression for #1118: resume() has the same log-sink lifecycle as run(). Its
// try/finally must open before the "started" yield so that a consumer which
// disconnects right after "started" still releases the sink.
Deno.test("resume() releases the log file sink when the consumer abandons the stream early", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class NoopExecutor implements StepExecutor {
      execute(_step: Step, _ctx: StepExecutionContext): Promise<unknown> {
        return Promise.resolve({ executed: true });
      }
    }

    // A manual-approval gate suspends the run so it can be resumed.
    const workflow = Workflow.create({
      name: "gated-workflow",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve before continuing"),
            }),
            Step.create({
              name: "after",
              task: StepTask.model("test-model", "run"),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      new NoopExecutor(),
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");

    // Approve the gate so resume() proceeds past it.
    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    const baseline = runFileSink.activeCount;
    let sinkOpenAtStarted = false;
    for await (const event of service.resume(workflow.name, suspended.id)) {
      if (event.kind === "started") {
        sinkOpenAtStarted = runFileSink.activeCount === baseline + 1;
        break; // abandon the generator right after "started"
      }
    }

    assertEquals(sinkOpenAtStarted, true);
    assertEquals(runFileSink.activeCount, baseline);
  });
});

Deno.test("manual_approval suspension does not mark job span as ERROR", async () => {
  const {
    BasicTracerProvider,
    SimpleSpanProcessor,
  } = await import("@opentelemetry/sdk-trace-base");
  const { ExportResultCode } = await import("@opentelemetry/core");
  const otelApi = await import("@opentelemetry/api");

  // A synchronous in-memory span exporter. OTel's own InMemorySpanExporter
  // defers its result callback via setTimeout(0) and never clears it
  // (forceFlush/shutdown are no-ops), so one timer per exported span leaks and
  // Deno's resource sanitizer fails the test. This exporter resolves the
  // callback inline, so no timer is queued. See swamp-club#1121.
  class SyncInMemorySpanExporter implements SpanExporter {
    readonly finishedSpans: ReadableSpan[] = [];
    export(
      spans: ReadableSpan[],
      resultCallback: (result: ExportResult) => void,
    ): void {
      this.finishedSpans.push(...spans);
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
    forceFlush(): Promise<void> {
      return Promise.resolve();
    }
  }

  const exporter = new SyncInMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();

  try {
    await withTempDir(async (tempDir) => {
      const workflowRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryWorkflowRunRepository();
      const executor = new MockStepExecutor();

      const workflow = Workflow.create({
        name: "approval-span-test",
        jobs: [
          Job.create({
            name: "gated-job",
            steps: [
              Step.create({
                name: "gate",
                task: StepTask.manualApproval("Approve deployment"),
              }),
              Step.create({
                name: "deploy",
                task: StepTask.model("deploy-model", "run"),
                dependsOn: [
                  { step: "gate", condition: TriggerCondition.succeeded() },
                ],
              }),
            ],
          }),
        ],
      });
      await workflowRepo.save(workflow);

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        undefined,
        catalogStore,
      );

      const run = await service.execute(workflow.name);
      assertEquals(run.status, "suspended");

      const jobSpans = exporter.finishedSpans.filter((s) =>
        s.name === "swamp.workflow.job"
      );
      assertEquals(jobSpans.length, 1);
      assertNotEquals(
        jobSpans[0].status.code,
        otelApi.SpanStatusCode.ERROR,
        "Job span should not be ERROR when workflow suspends at manual_approval",
      );
    });
  } finally {
    await provider.shutdown();
    otelApi.trace.disable();
  }
});

// guard tests

Deno.test("guard: step without guard executes normally", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "no-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "unguarded",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/unguarded"]);
  });
});

Deno.test("guard: step with falsy guard expression executes", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "falsy-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "guarded-falsy",
              task: StepTask.model("test-model", "run"),
              guard: "${{ false }}",
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/guarded-falsy"]);
  });
});

Deno.test("guard: step with truthy guard expression is skipped", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "truthy-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "guarded-truthy",
              task: StepTask.model("test-model", "run"),
              guard: "${{ true }}",
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: Array<{ kind: string; reason?: string }> = [];
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "step_skipped") {
        events.push({ kind: event.kind, reason: event.reason });
      }
    }

    assertEquals(executor.executedSteps, []);
    assertEquals(events.length, 1);
    assertEquals(events[0].reason, "guarded");
  });
});

Deno.test("guard: a guarded skip persists its reason and expression on the run", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "guard-reason-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "guarded-truthy",
              task: StepTask.model("test-model", "run"),
              guard: "${{ true }}",
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (const _ of service.run(workflow.name)) { /* drain */ }

    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    const step = runs[0].getJob("job1")?.getStep("guarded-truthy");
    assertEquals(step?.status, "skipped");
    const reason = step?.skipReason;
    assertEquals(reason?.kind, "guarded");
    // The recorded expression is the evaluated CEL, so an attestation can
    // name which guard excluded the step rather than only that one did.
    assertEquals(
      reason?.kind === "guarded" ? reason.expression : undefined,
      "true",
    );
  });
});

Deno.test("guard: guarded-skip triggers downstream with skipped condition", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "guard-downstream-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "guarded-step",
              task: StepTask.model("test-model", "run"),
              guard: "${{ true }}",
            }),
            Step.create({
              name: "downstream-on-skip",
              task: StepTask.model("test-model", "run"),
              dependsOn: [
                {
                  step: "guarded-step",
                  condition: TriggerCondition.skipped(),
                },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/downstream-on-skip"]);
  });
});

Deno.test("guard: invalid guard expression (not wrapped in ${{ }}) fails the step", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "invalid-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "bad-guard",
              task: StepTask.model("test-model", "run"),
              guard: "not a cel expression",
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    await assertRejects(
      () => service.execute(workflow.name),
      Error,
      "guard must be a ${{ }} expression",
    );
  });
});

Deno.test("guard: CEL runtime error in guard fails the step", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "runtime-error-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "error-guard",
              task: StepTask.model("test-model", "run"),
              guard: "${{ undefined_var.field }}",
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: Array<{ kind: string; error?: string }> = [];
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "step_failed") {
        events.push({ kind: event.kind, error: event.error });
      }
    }

    assertEquals(executor.executedSteps, []);
    assertEquals(events.length, 1);
    assertStringIncludes(events[0].error!, "Guard expression failed");
  });
});

Deno.test("guard: value comparison guard expression", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "comparison-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "matching",
              task: StepTask.model("test-model", "run"),
              guard: "${{ 1 == 1 }}",
            }),
            Step.create({
              name: "not-matching",
              task: StepTask.model("test-model", "run"),
              guard: "${{ 1 == 2 }}",
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/not-matching"]);
  });
});

Deno.test("guard: model.method() guard skips step when method returns truthy", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class TruthyMethodExecutor implements StepExecutor {
      executedSteps: string[] = [];
      guardAuthored: ReadonlySet<string> | undefined;

      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
        if (ctx.stepName.startsWith("__guard_")) {
          this.guardAuthored = ctx.authoredExpressions;
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new TruthyMethodExecutor();

    const workflow = Workflow.create({
      name: "model-method-guard-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "check-infra",
              task: StepTask.model("infra", "create"),
              guard: '${{ model.method("infra", "exists") }}',
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: Array<{ kind: string; reason?: string }> = [];
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "step_skipped") {
        events.push({ kind: event.kind, reason: event.reason });
      }
    }

    assertEquals(
      executor.executedSteps,
      ["job1/__guard_check-infra"],
    );
    assertEquals(events.length, 1);
    assertEquals(events[0].reason, "guarded");
    // The guard's model.method() call runs with the workflow's provenance, so
    // authored expressions in its inputs resolve instead of arriving literal.
    assertEquals(
      executor.guardAuthored?.has('${{ model.method("infra", "exists") }}'),
      true,
    );
  });
});

Deno.test("guard: model.method() guard executes step when method returns falsy", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class FalsyMethodExecutor implements StepExecutor {
      executedSteps: string[] = [];

      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
        if (ctx.stepName.startsWith("__guard_")) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new FalsyMethodExecutor();

    const workflow = Workflow.create({
      name: "model-method-guard-falsy-wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "create-infra",
              task: StepTask.model("infra", "create"),
              guard: '${{ model.method("infra", "exists") }}',
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");
    assertEquals(
      executor.executedSteps,
      ["job1/__guard_create-infra", "job1/create-infra"],
    );
  });
});

Deno.test("assert: model.method() in expr passes when method returns truthy", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class TruthyAssertMethodExecutor implements StepExecutor {
      executedSteps: string[] = [];

      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
        if (ctx.stepName.startsWith("__assert_")) {
          return Promise.resolve({ running: true });
        }
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new TruthyAssertMethodExecutor();

    const workflow = Workflow.create({
      name: "assert-model-method-pass",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "verify-status",
              task: StepTask.assert(
                'model.method("infra", "check-status").running',
                "Instance is not running",
                "high",
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: Array<{
      kind: string;
      passed?: boolean;
      message?: string;
    }> = [];
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "assert_result") {
        const e = event as { kind: string; passed: boolean; message: string };
        events.push({ kind: e.kind, passed: e.passed, message: e.message });
      }
    }

    assertEquals(
      executor.executedSteps,
      ["job1/__assert_verify-status"],
    );
    assertEquals(events.length, 1);
    assertEquals(events[0].passed, true);
  });
});

Deno.test("assert: model.method() in expr fails when method returns falsy", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    class FalsyAssertMethodExecutor implements StepExecutor {
      executedSteps: string[] = [];

      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
        if (ctx.stepName.startsWith("__assert_")) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ executed: true });
      }
    }
    const executor = new FalsyAssertMethodExecutor();

    const workflow = Workflow.create({
      name: "assert-model-method-fail",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "verify-status",
              task: StepTask.assert(
                'model.method("infra", "check-status")',
                "Instance check failed",
                "high",
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const events: Array<{
      kind: string;
      passed?: boolean;
      message?: string;
    }> = [];
    for await (const event of service.run(workflow.name)) {
      if (event.kind === "assert_result") {
        const e = event as { kind: string; passed: boolean; message: string };
        events.push({ kind: e.kind, passed: e.passed, message: e.message });
      }
    }

    assertEquals(
      executor.executedSteps,
      ["job1/__assert_verify-status"],
    );
    assertEquals(events.length, 1);
    assertEquals(events[0].passed, false);
    assertEquals(events[0].message, "Instance check failed");
  });
});

// ---------------------------------------------------------------------------
// Drain-before-suspend: parallel sibling steps complete before suspension
// ---------------------------------------------------------------------------

Deno.test("suspend: parallel sibling steps complete before suspension is persisted", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ConcurrencyTrackingExecutor(50);

    // deploy → (gate + cleanup) where gate is manual_approval and cleanup
    // is a model_method. Both depend on deploy (same level, parallel).
    const workflow = Workflow.create({
      name: "drain-suspend",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "build",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "gate",
          steps: [
            Step.create({
              name: "production-gate",
              task: StepTask.manualApproval("Approve?"),
            }),
          ],
          dependsOn: [
            { job: "deploy", condition: TriggerCondition.succeeded() },
          ],
        }),
        Job.create({
          name: "cleanup",
          steps: [
            Step.create({
              name: "gc",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "deploy", condition: TriggerCondition.completed() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);

    assertEquals(suspended.status, "suspended");

    // The cleanup job's step must be succeeded — not stuck at running.
    const cleanupJob = suspended.getJob("cleanup")!;
    assertEquals(cleanupJob.status, "succeeded");
    assertEquals(cleanupJob.getStep("gc")!.status, "succeeded");

    // The gate job stays running with the approval step waiting.
    const gateJob = suspended.getJob("gate")!;
    assertEquals(gateJob.status, "running");
    assertEquals(
      gateJob.getStep("production-gate")!.status,
      "waiting_approval",
    );

    // The deploy job completed normally.
    assertEquals(suspended.getJob("deploy")!.status, "succeeded");

    // The executor ran the deploy step and the cleanup step (not the gate).
    assert(executor.executedSteps.includes("deploy/build"));
    assert(executor.executedSteps.includes("cleanup/gc"));
  });
});

Deno.test("suspend: resumed run skips completed sibling steps", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "resume-skip",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "build",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "gate",
          steps: [
            Step.create({
              name: "approval",
              task: StepTask.manualApproval("Go?"),
            }),
          ],
          dependsOn: [
            { job: "deploy", condition: TriggerCondition.succeeded() },
          ],
        }),
        Job.create({
          name: "cleanup",
          steps: [
            Step.create({
              name: "gc",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "deploy", condition: TriggerCondition.completed() },
          ],
        }),
        Job.create({
          name: "post-gate",
          steps: [
            Step.create({
              name: "release",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "gate", condition: TriggerCondition.succeeded() },
            { job: "cleanup", condition: TriggerCondition.succeeded() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");

    // Approve the gate step.
    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    toApprove!.getJob("gate")!.getStep("approval")!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    // Clear executor tracking and resume.
    executor.executedSteps = [];

    let resumedRun: WorkflowRun | undefined;
    for await (const event of service.resume(workflow.name, suspended.id)) {
      if (event.kind === "completed") resumedRun = event.run;
    }

    assertEquals(resumedRun?.status, "succeeded");

    // Only post-gate/release should execute on resume — cleanup/gc was
    // already completed during the initial run and must NOT re-execute.
    assertEquals(executor.executedSteps, ["post-gate/release"]);
  });
});

Deno.test("suspend: sibling step failure is recorded during drain", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("gc");

    const workflow = Workflow.create({
      name: "drain-fail",
      jobs: [
        Job.create({
          name: "deploy",
          steps: [
            Step.create({
              name: "build",
              task: StepTask.model("test-model", "run"),
            }),
          ],
        }),
        Job.create({
          name: "gate",
          steps: [
            Step.create({
              name: "approval",
              task: StepTask.manualApproval("Ready?"),
            }),
          ],
          dependsOn: [
            { job: "deploy", condition: TriggerCondition.succeeded() },
          ],
        }),
        Job.create({
          name: "cleanup",
          steps: [
            Step.create({
              name: "gc",
              task: StepTask.model("test-model", "run"),
            }),
          ],
          dependsOn: [
            { job: "deploy", condition: TriggerCondition.completed() },
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");

    // The cleanup job's step failed — properly recorded, not stuck running.
    const cleanupJob = suspended.getJob("cleanup")!;
    assertEquals(cleanupJob.status, "failed");
    assertEquals(cleanupJob.getStep("gc")!.status, "failed");
  });
});

Deno.test("step output stored on WorkflowRun has stripped content and attributes (swamp-club#1673)", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ModelMethodMockExecutor();

    // Use the real nested structure: specName → instanceName → DataRecord
    // The executor spreads output into the returned object, so we bypass
    // the mock's type constraint with a direct set on the execute method.
    const largePayload = "x".repeat(10000);
    const originalExecute = executor.execute.bind(executor);
    executor.execute = (step: Step, ctx: StepExecutionContext) => {
      if (step.name === "step1") {
        executor.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
        if (ctx.expressionContext) {
          executor.capturedContexts.set(
            ctx.stepName,
            JSON.parse(JSON.stringify(ctx.expressionContext.model)),
          );
        }
        return Promise.resolve({
          type: "model_method",
          method: "generate",
          model: "data-model",
          resources: {
            result: {
              "default": {
                id: "data-123",
                name: "result",
                version: 1,
                createdAt: "2024-01-01T00:00:00Z",
                attributes: { largePayload },
                content: { largePayload },
                tags: { type: "resource" },
                modelName: "data-model",
                modelId: "model-id-1",
                modelType: "data-generator",
                specName: "result",
                dataType: "resource",
                contentType: "application/json",
                lifetime: "infinite",
                ownerType: "model-method",
                streaming: false,
                size: 10000,
                isLatest: true,
                namespace: "",
                ownerRef: "",
                workflowRunId: "",
                workflowName: "",
                jobName: "",
                stepName: "",
                source: "",
              },
            },
          },
          dataHandles: [
            {
              name: "default",
              specName: "result",
              kind: "resource",
              dataId: "data-123",
              version: 1,
              size: 10000,
              tags: { type: "resource" },
              metadata: {},
              attributes: { largePayload },
            },
          ],
        });
      }
      if (step.name === "step2") {
        executor.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);
        if (ctx.expressionContext) {
          executor.capturedContexts.set(
            ctx.stepName,
            JSON.parse(JSON.stringify(ctx.expressionContext.model)),
          );
        }
        return Promise.resolve({ executed: true, step: step.name });
      }
      return originalExecute(step, ctx);
    };

    const workflow = Workflow.create({
      name: "strip-content-test",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("data-model", "generate"),
            }),
            Step.create({
              name: "step2",
              task: StepTask.model("consumer-model", "consume"),
              dependsOn: [
                { step: "step1", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");

    // Expression context should still have full content for downstream steps
    const step2Context = executor.capturedContexts.get("step2");
    const dataModel = step2Context?.["data-model"] as {
      resource?: Record<
        string,
        Record<string, { attributes: Record<string, unknown> }>
      >;
    };
    assertEquals(
      dataModel?.resource?.["result"]?.["default"]?.attributes?.largePayload,
      "x".repeat(10000),
    );

    // Step run output should have stripped content and attributes
    const step1Run = run.getJob("job1")!.getStep("step1")!;
    const step1Output = step1Run.toData().output as {
      resources?: Record<
        string,
        Record<
          string,
          {
            content: unknown;
            attributes: unknown;
            id: string;
            name: string;
            version: number;
          }
        >
      >;
    };
    assertEquals(
      step1Output?.resources?.["result"]?.["default"]?.content,
      null,
    );
    assertEquals(
      step1Output?.resources?.["result"]?.["default"]?.attributes,
      null,
    );

    // Metadata should still be present
    const record = step1Output?.resources?.["result"]?.["default"];
    assertEquals(record?.id, "data-123");
    assertEquals(record?.name, "result");
    assertEquals(record?.version, 1);

    // DataHandle attributes should also be stripped
    const step1Handles = (step1Run.toData().output as {
      dataHandles?: Array<{ attributes: unknown; name: string }>;
    })?.dataHandles;
    assert(step1Handles);
    assertEquals(step1Handles.length, 1);
    assertEquals(step1Handles[0].name, "default");
    assertEquals(step1Handles[0].attributes, null);
  });
});

// ---------------------------------------------------------------------------
// computeStepsToReset
// ---------------------------------------------------------------------------

function makeWorkflowWithForEach(
  templateName: string,
  opts?: { extraSteps?: Step[] },
): Workflow {
  const forEachStep = Step.create({
    name: templateName,
    task: StepTask.model("m", "run"),
    forEach: { item: "env", in: '${{ ["dev", "qa"] }}' },
  });
  return Workflow.create({
    name: "test-wf",
    jobs: [
      Job.create({
        name: "deploy",
        steps: [
          ...(opts?.extraSteps ?? []),
          forEachStep,
        ],
      }),
    ],
  });
}

function makeRunWithExpandedSteps(
  workflow: Workflow,
  expandedSteps: { name: string; forEachTemplate?: string }[],
): WorkflowRun {
  const wfId = workflow.id;
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: wfId,
    workflowName: workflow.name,
    status: "failed",
    jobs: [{
      jobName: "deploy",
      status: "failed",
      steps: expandedSteps.map((s) => ({
        stepName: s.name,
        status: s.name.endsWith("-qa") ? "failed" : "succeeded",
        forEachTemplate: s.forEachTemplate,
      })),
    }],
  });
}

Deno.test("computeStepsToReset: matches expression-containing template via forEachTemplate", () => {
  const tmpl = "deploy-${{ self.env }}";
  const workflow = makeWorkflowWithForEach(tmpl);
  const run = makeRunWithExpandedSteps(workflow, [
    { name: "deploy-dev", forEachTemplate: tmpl },
    { name: "deploy-qa", forEachTemplate: tmpl },
  ]);

  const result = computeStepsToReset(workflow, run, tmpl);
  assertEquals(result, new Set(["deploy-dev", "deploy-qa"]));
});

Deno.test("computeStepsToReset: matches plain template via prefix (non-regression)", () => {
  const tmpl = "deploy";
  const workflow = makeWorkflowWithForEach(tmpl);
  const run = makeRunWithExpandedSteps(workflow, [
    { name: "deploy-dev", forEachTemplate: tmpl },
    { name: "deploy-qa", forEachTemplate: tmpl },
  ]);

  const result = computeStepsToReset(workflow, run, tmpl);
  assertEquals(result, new Set(["deploy-dev", "deploy-qa"]));
});

Deno.test("computeStepsToReset: falls back to prefix when forEachTemplate absent (backward compat)", () => {
  const tmpl = "deploy";
  const workflow = makeWorkflowWithForEach(tmpl);
  const run = makeRunWithExpandedSteps(workflow, [
    { name: "deploy-dev" },
    { name: "deploy-qa" },
  ]);

  const result = computeStepsToReset(workflow, run, tmpl);
  assertEquals(result, new Set(["deploy-dev", "deploy-qa"]));
});

Deno.test("computeStepsToReset: throws when --from resolves to zero steps", () => {
  const tmpl = "deploy-${{ self.env }}";
  const workflow = makeWorkflowWithForEach(tmpl);
  // Simulate a run where the forEach step was never reached
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "failed",
    jobs: [{
      jobName: "deploy",
      status: "failed",
      steps: [],
    }],
  });

  assertThrows(
    () => computeStepsToReset(workflow, run, tmpl),
    Error,
    "matched zero persisted steps",
  );
});

Deno.test("computeStepsToReset: throws for unknown step name", () => {
  const workflow = makeWorkflowWithForEach("deploy");
  const run = makeRunWithExpandedSteps(workflow, [
    { name: "deploy-dev", forEachTemplate: "deploy" },
  ]);

  assertThrows(
    () => computeStepsToReset(workflow, run, "nonexistent"),
    Error,
    'Step "nonexistent" not found',
  );
});

// --- Post-failure cleanup: always/completed step conditions (swamp-club#1785) ---

Deno.test(
  "step with always condition runs after dependency failure (swamp-club#1785)",
  async () => {
    await withTempDir(async (tempDir) => {
      const workflowRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryWorkflowRunRepository();
      const executor = new MockStepExecutor();
      executor.shouldFail.add("build");

      const workflow = Workflow.create({
        name: "always-after-failure",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "build",
                task: StepTask.model("test-model", "run"),
              }),
              Step.create({
                name: "cleanup",
                task: StepTask.model("test-model", "run"),
                dependsOn: [
                  { step: "build", condition: TriggerCondition.always() },
                ],
              }),
            ],
          }),
        ],
      });

      await workflowRepo.save(workflow);

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        undefined,
        catalogStore,
      );

      const run = await service.execute(workflow.name);

      assertEquals(run.getJob("main")?.getStep("build")?.status, "failed");
      assertEquals(run.getJob("main")?.getStep("cleanup")?.status, "succeeded");
      assert(
        executor.executedSteps.includes("main/cleanup"),
        "cleanup step should have been executed",
      );
    });
  },
);

Deno.test(
  "step with completed condition runs after dependency failure (swamp-club#1785)",
  async () => {
    await withTempDir(async (tempDir) => {
      const workflowRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryWorkflowRunRepository();
      const executor = new MockStepExecutor();
      executor.shouldFail.add("build");

      const workflow = Workflow.create({
        name: "completed-after-failure",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "build",
                task: StepTask.model("test-model", "run"),
              }),
              Step.create({
                name: "notify",
                task: StepTask.model("test-model", "run"),
                dependsOn: [
                  { step: "build", condition: TriggerCondition.completed() },
                ],
              }),
            ],
          }),
        ],
      });

      await workflowRepo.save(workflow);

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        undefined,
        catalogStore,
      );

      const run = await service.execute(workflow.name);

      assertEquals(run.getJob("main")?.getStep("build")?.status, "failed");
      assertEquals(run.getJob("main")?.getStep("notify")?.status, "succeeded");
      assert(
        executor.executedSteps.includes("main/notify"),
        "notify step should have been executed",
      );
    });
  },
);

Deno.test(
  "step with succeeded condition is skipped after dependency failure (swamp-club#1785)",
  async () => {
    await withTempDir(async (tempDir) => {
      const workflowRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryWorkflowRunRepository();
      const executor = new MockStepExecutor();
      executor.shouldFail.add("build");

      const workflow = Workflow.create({
        name: "succeeded-after-failure",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "build",
                task: StepTask.model("test-model", "run"),
              }),
              Step.create({
                name: "deploy",
                task: StepTask.model("test-model", "run"),
                dependsOn: [
                  { step: "build", condition: TriggerCondition.succeeded() },
                ],
              }),
              Step.create({
                name: "cleanup",
                task: StepTask.model("test-model", "run"),
                dependsOn: [
                  { step: "build", condition: TriggerCondition.always() },
                ],
              }),
            ],
          }),
        ],
      });

      await workflowRepo.save(workflow);

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        undefined,
        catalogStore,
      );

      const run = await service.execute(workflow.name);

      assertEquals(run.getJob("main")?.getStep("build")?.status, "failed");
      assertEquals(run.getJob("main")?.getStep("deploy")?.status, "skipped");
      assertEquals(
        run.getJob("main")?.getStep("cleanup")?.status,
        "succeeded",
      );
      assertEquals(
        executor.executedSteps.includes("main/deploy"),
        false,
        "deploy should NOT have been executed",
      );
      assert(
        executor.executedSteps.includes("main/cleanup"),
        "cleanup should have been executed",
      );
    });
  },
);

Deno.test({
  name:
    "cancellation runs cleanup steps with always condition (swamp-club#1785)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (tempDir) => {
      const workflowRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryWorkflowRunRepository();
      const executor = new MockStepExecutor();

      // Make the first step slow so the signal fires while it's running
      const originalExecute = executor.execute.bind(executor);
      executor.execute = async (step: Step, ctx: StepExecutionContext) => {
        if (step.name === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          // Check if signal was aborted
          if (ctx.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
        }
        return originalExecute(step, ctx);
      };

      const workflow = Workflow.create({
        name: "cancel-with-cleanup",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "slow",
                task: StepTask.model("test-model", "run"),
              }),
              Step.create({
                name: "cleanup",
                task: StepTask.model("test-model", "run"),
                dependsOn: [
                  { step: "slow", condition: TriggerCondition.always() },
                ],
              }),
            ],
          }),
        ],
      });

      await workflowRepo.save(workflow);

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        undefined,
        catalogStore,
      );

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);

      const events = [];
      for await (
        const event of service.run(workflow.name, {
          signal: controller.signal,
        })
      ) {
        events.push(event);
      }

      const cancelledEvent = events.find((e) => e.kind === "cancelled");
      assert(cancelledEvent !== undefined, "expected cancelled event");
      const run = cancelledEvent!.run;

      assertEquals(run.getJob("main")?.getStep("slow")?.status, "failed");
      assertEquals(
        run.getJob("main")?.getStep("cleanup")?.status,
        "succeeded",
      );
      assert(
        executor.executedSteps.includes("main/cleanup"),
        "cleanup step should have been executed after cancellation",
      );
    });
  },
});

Deno.test({
  name:
    "DefaultStepExecutor: hydrateFile hook fires when step reads lazy-hydrated resource",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { z } = await import("zod");
    const { ModelType } = await import("../models/model_type.ts");
    const { modelRegistry } = await import("../models/model.ts");
    const { Definition } = await import("../definitions/definition.ts");
    const { YamlDefinitionRepository } = await import(
      "../../infrastructure/persistence/yaml_definition_repository.ts"
    );
    const { FileSystemUnifiedDataRepository } = await import(
      "../../infrastructure/persistence/unified_data_repository.ts"
    );
    const { Data } = await import("../data/data.ts");
    const { initializeLogging } = await import(
      "../../infrastructure/logging/logger.ts"
    );
    await initializeLogging({});

    await withTempDir(async (tempDir) => {
      const typeName = `@test-issue1984/hydrate-${
        crypto.randomUUID().slice(0, 8)
      }`;
      const modelType = ModelType.create(typeName);
      let readResult: Record<string, unknown> | null = null;

      modelRegistry.register({
        type: modelType,
        version: "2026.01.01.1",
        globalArguments: z.object({}),
        resources: {
          cursor: {
            description: "cursor state",
            schema: z.object({ lastSeen: z.number() }),
            lifetime: "infinite",
            garbageCollection: 5,
          },
        },
        methods: {
          run: {
            description: "reads a resource to test hydration",
            arguments: z.object({}),
            execute: async (_args, context) => {
              readResult = await context.readResource!("cursor");
              return {};
            },
          },
        },
      });

      const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
      try {
        const definitionRepo = new YamlDefinitionRepository(tempDir);
        const instance = Definition.create({
          name: "hydrate-instance",
          type: modelType.normalized,
        });
        await definitionRepo.save(modelType, instance);

        const setupRepo = new FileSystemUnifiedDataRepository(
          tempDir,
          undefined,
          catalogStore,
        );
        const cursorData = { lastSeen: 42 };
        const content = new TextEncoder().encode(JSON.stringify(cursorData));
        const data = Data.create({
          name: "cursor",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 5,
          tags: { type: "resource" },
          ownerDefinition: {
            ownerType: "model-method" as const,
            ownerRef: instance.id,
          },
        });
        await setupRepo.save(modelType, instance.id, data, content);

        const contentPath = setupRepo.getContentPath(
          modelType,
          instance.id,
          "cursor",
          1,
        );
        await Deno.remove(contentPath);

        let hookCalled = false;
        const hydrateFile = async (absPath: string): Promise<boolean> => {
          hookCalled = true;
          await Deno.mkdir(join(absPath, ".."), { recursive: true });
          await Deno.writeFile(absPath, content);
          return true;
        };

        const executor = new DefaultStepExecutor(
          undefined,
          undefined,
          undefined,
          undefined,
          hydrateFile,
        );

        const step = Step.create({
          name: "hydrate-step",
          task: StepTask.model("hydrate-instance", "run"),
        });
        const ctx: StepExecutionContext = {
          workflowId: createWorkflowId(
            "00000000-0000-0000-0000-000000000000",
          ),
          workflowRunId: "00000000-0000-0000-0000-000000000000",
          workflowName: "hydration-test",
          jobName: "job1",
          stepName: "hydrate-step",
          repoDir: tempDir,
          signal: new AbortController().signal,
          step,
          catalogStore,
          authoredExpressions: new Set(),
        };

        await executor.execute(step, ctx);

        assert(hookCalled, "hydrateFile hook should have been called");
        assertExists(readResult, "readResource should return data");
        assertEquals(
          (readResult as Record<string, unknown>).lastSeen,
          42,
        );
      } finally {
        catalogStore.close();
      }
    });
  },
});

const STEP_OUTPUT_MODEL_TYPE = "test/step-outputs";

/**
 * A model_method step output in the shape the real step executor returns:
 * resource records keyed by spec then instance, each still carrying the
 * attributes loaded when the step ran.
 */
function modelMethodStepOutput(
  model: string,
  method: string,
  resources: Array<{
    name: string;
    modelId: string;
    attributes: Record<string, unknown>;
  }>,
): Record<string, unknown> {
  const records: Record<string, Record<string, unknown>> = {};
  for (const r of resources) {
    records[r.name] = {
      id: `data-${r.name}`,
      name: r.name,
      version: 1,
      isLatest: true,
      modelName: model,
      modelId: r.modelId,
      modelType: STEP_OUTPUT_MODEL_TYPE,
      specName: "result",
      contentType: "application/json",
      tags: {},
      attributes: r.attributes,
      content: r.attributes,
    };
  }
  return {
    type: "model_method",
    model,
    method,
    resources: { result: records },
    files: {},
    dataArtifacts: [],
    dataHandles: [],
  };
}

/** Writes a resource's content where the service's data repository reads it. */
async function writeStepResource(
  tempDir: string,
  catalogStore: CatalogStore,
  modelId: string,
  name: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const repo = new FileSystemUnifiedDataRepository(
    tempDir,
    undefined,
    catalogStore,
  );
  const path = repo.getContentPath(
    ModelType.create(STEP_OUTPUT_MODEL_TYPE),
    modelId,
    name,
    1,
  );
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(attributes));
}

Deno.test("steps context: downstream step sees upstream step outputs", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const capturedContexts: Map<string, StepExecutionContext> = new Map();
    const executor: StepExecutor = {
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        capturedContexts.set(ctx.stepName, ctx);
        if (step.name === "create") {
          // No datastore content: a live run must not need to read it.
          return Promise.resolve(
            modelMethodStepOutput("test-model", "create", [{
              name: "audience",
              modelId: "model-create",
              attributes: { audienceId: "aud_123", status: "Building" },
            }]),
          );
        }
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "steps-context-test",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "create",
              task: StepTask.model("test-model", "create"),
            }),
            Step.create({
              name: "use-output",
              task: StepTask.model("test-model", "check"),
              dependsOn: [
                { step: "create", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");

    const useOutputCtx = capturedContexts.get("use-output");
    assertExists(useOutputCtx?.expressionContext?.steps);
    const createStep = useOutputCtx!.expressionContext!.steps!["create"];
    assertExists(createStep);
    assertEquals(createStep.status, "succeeded");
    assertExists(createStep.outputs);
    assertEquals(createStep.outputs!.audienceId, "aud_123");
    assertEquals(createStep.outputs!.status, "Building");
  });
});

Deno.test("steps context: first step sees empty steps map", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const stepsSnapshots: Map<string, Record<string, unknown>> = new Map();
    const executor: StepExecutor = {
      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        if (ctx.expressionContext?.steps) {
          stepsSnapshots.set(
            ctx.stepName,
            JSON.parse(JSON.stringify(ctx.expressionContext.steps)),
          );
        }
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "no-pending-steps-test",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "first",
              task: StepTask.model("m", "run"),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    await service.execute(workflow.name);

    const firstSnapshot = stepsSnapshots.get("first");
    assertExists(firstSnapshot);
    assertEquals(Object.keys(firstSnapshot!).length, 0);
  });
});

Deno.test("steps context: pre-populated from completed jobs on resume", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    let callCount = 0;
    const capturedContexts: Map<string, StepExecutionContext> = new Map();
    const executor: StepExecutor = {
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        callCount++;
        capturedContexts.set(ctx.stepName, ctx);
        if (step.name === "compile") {
          return Promise.resolve(
            modelMethodStepOutput("build-model", "build", [{
              name: "artifact",
              modelId: "model-build",
              attributes: { artifactId: "art_abc" },
            }]),
          );
        }
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "cross-job-resume-test",
      jobs: [
        Job.create({
          name: "build",
          steps: [
            Step.create({
              name: "compile",
              task: StepTask.model("build-model", "build"),
            }),
          ],
        }),
        Job.create({
          name: "deploy",
          dependsOn: [
            { job: "build", condition: TriggerCondition.succeeded() },
          ],
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve deploy"),
            }),
            Step.create({
              name: "push",
              task: StepTask.model("deploy-model", "push"),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    // The resumed run reads compile's outputs back from the datastore.
    await writeStepResource(
      tempDir,
      catalogStore,
      "model-build",
      "artifact",
      { artifactId: "art_abc" },
    );
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");
    assertEquals(callCount, 1);

    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!
      .recordApprovalDecision({
        approved: true,
        decidedBy: "user:test",
        decidedAt: new Date().toISOString(),
      });
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    let resumedRun: WorkflowRun | undefined;
    for await (const event of service.resume(workflow.name, suspended.id)) {
      if (event.kind === "completed") resumedRun = event.run;
    }

    assertEquals(resumedRun?.status, "succeeded");

    const pushCtx = capturedContexts.get("push");
    assertExists(pushCtx?.expressionContext?.steps);
    const compileStep = pushCtx!.expressionContext!.steps!["compile"];
    assertExists(compileStep);
    assertEquals(compileStep.status, "succeeded");
    assertExists(compileStep.outputs);
    assertEquals(compileStep.outputs!.artifactId, "art_abc");
  });
});

Deno.test("steps context: a downstream step sees a child workflow's outputs by child step", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const capturedContexts: Map<string, StepExecutionContext> = new Map();
    const executor: StepExecutor = {
      execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
        capturedContexts.set(ctx.stepName, ctx);
        if (step.name === "write") {
          return Promise.resolve(
            modelMethodStepOutput("writer", "execute", [{
              name: "record",
              modelId: "model-writer",
              attributes: { stdout: "hello" },
            }]),
          );
        }
        return Promise.resolve({ executed: true });
      },
    };

    const child = Workflow.create({
      name: "child-wf",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "write",
              task: StepTask.model("writer", "execute"),
            }),
          ],
        }),
      ],
    });
    const parent = Workflow.create({
      name: "parent-wf",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "child",
              task: StepTask.workflow("child-wf"),
            }),
            Step.create({
              name: "use",
              task: StepTask.model("reader", "execute"),
              dependsOn: [
                { step: "child", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(child);
    await workflowRepo.save(parent);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    // The child run's step outputs are stripped by the time the parent
    // resolves them, so they are read from the datastore.
    await writeStepResource(
      tempDir,
      catalogStore,
      "model-writer",
      "record",
      { stdout: "hello" },
    );
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(parent.name);
    assertEquals(run.status, "succeeded");

    const childStep = capturedContexts.get("use")!.expressionContext!.steps!
      .child;
    assertEquals(childStep.status, "succeeded");
    assertEquals(childStep.outputs, { write: { stdout: "hello" } });
  });
});

Deno.test("steps context: the run record keeps no step output values", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const executor: StepExecutor = {
      execute(step: Step): Promise<unknown> {
        if (step.name === "write") {
          return Promise.resolve(
            modelMethodStepOutput("writer", "execute", [{
              name: "record",
              modelId: "model-writer",
              attributes: { stdout: "hello" },
            }]),
          );
        }
        return Promise.resolve({ executed: true });
      },
    };

    const child = Workflow.create({
      name: "child-wf",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "write",
              task: StepTask.model("writer", "execute"),
            }),
          ],
        }),
      ],
    });
    const parent = Workflow.create({
      name: "parent-wf",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "child",
              task: StepTask.workflow("child-wf"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(child);
    await workflowRepo.save(parent);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    await writeStepResource(
      tempDir,
      catalogStore,
      "model-writer",
      "record",
      { stdout: "hello" },
    );
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const run = await service.execute(parent.name);
    assertEquals(run.status, "succeeded");

    // The parent step records how to find the child run, not its outputs.
    const parentOutput = run.getJob("main")!.getStep("child")!.output as Record<
      string,
      unknown
    >;
    assertEquals(parentOutput.workflowId, child.id);
    assertEquals("outputs" in parentOutput, false);

    const childRun = await runRepo.findById(
      child.id,
      createWorkflowRunId(parentOutput.runId as string),
    );
    const childOutput = childRun!.getJob("main")!.getStep("write")!
      .output as Record<string, unknown>;
    const record = (childOutput.resources as Record<
      string,
      Record<string, Record<string, unknown>>
    >).result.record;
    assertEquals(record.attributes, null);
    assertEquals(record.content, null);
    assertEquals(JSON.stringify(childRun!.toData()).includes("hello"), false);
  });
});

Deno.test("run context: includes initiatedBy and inputs", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();

    const capturedContexts: StepExecutionContext[] = [];
    const executor: StepExecutor = {
      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        capturedContexts.push(ctx);
        return Promise.resolve({ executed: true });
      },
    };

    const workflow = Workflow.create({
      name: "run-context-test",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "s",
              task: StepTask.model("m", "run"),
            }),
          ],
        }),
      ],
    });

    await workflowRepo.save(workflow);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    let completedRun: WorkflowRun | undefined;
    for await (
      const event of service.run(workflow.name, {
        initiatedBy: "user:paul",
        inputs: { env: "production", count: 5 },
      })
    ) {
      if (event.kind === "completed") completedRun = event.run;
    }

    assertExists(completedRun);
    assertEquals(completedRun!.status, "succeeded");
    assertEquals(capturedContexts.length, 1);

    const ctx = capturedContexts[0];
    assertEquals(ctx.expressionContext?.run?.initiatedBy, "user:paul");
    assertExists(ctx.expressionContext?.run?.inputs);
    assertEquals(ctx.expressionContext!.run!.inputs!.env, "production");
    assertEquals(ctx.expressionContext!.run!.inputs!.count, 5);
  });
});

// --- Report assembly resolves definitions within the step's own model type ---
//
// `model_resolved` carries the resolved definition's own name AND type, so
// report assembly can scope its lookup to that type instead of walking every
// definition in the repository once per step.
//
// The discriminator here is deterministic rather than walk-order dependent:
// findByNameGlobal always searches the primary models dir before the secondary
// auto-definitions dir, so a same-named definition in each means the global
// walk necessarily returns the PRIMARY one. A type-scoped lookup for the
// secondary definition's type necessarily returns the SECONDARY one. This is
// also the real shape of the auto-created-model case.
Deno.test("report assembly resolves step definitions within the step's own model type", async () => {
  const { ModelType } = await import("../models/model_type.ts");
  const { Definition } = await import("../definitions/definition.ts");
  const { YamlDefinitionRepository } = await import(
    "../../infrastructure/persistence/yaml_definition_repository.ts"
  );
  const { swampPath, SWAMP_SUBDIRS } = await import(
    "../../infrastructure/persistence/paths.ts"
  );

  await withTempDir(async (tempDir) => {
    const primaryType = ModelType.create("command/shell");
    const secondaryType = ModelType.create("swamp/echo");
    const sharedName = "shared-model-name";

    const primaryRepo = new YamlDefinitionRepository(tempDir);
    const primaryDef = Definition.create({
      name: sharedName,
      globalArguments: { origin: "primary" },
    });
    await primaryRepo.save(primaryType, primaryDef);

    const secondaryRepo = new YamlDefinitionRepository(
      tempDir,
      undefined,
      swampPath(tempDir, SWAMP_SUBDIRS.autoDefinitions),
      false,
    );
    const secondaryDef = Definition.create({
      name: sharedName,
      globalArguments: { origin: "secondary" },
    });
    await secondaryRepo.save(secondaryType, secondaryDef);

    // The global walk returns the primary definition — this is what report
    // assembly used to get, regardless of which type the step actually ran.
    const globalLookup = await primaryRepo.findByNameGlobal(sharedName);
    assertEquals(globalLookup?.definition.id, primaryDef.id);

    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      new MockStepExecutor(),
      undefined,
      catalogStore,
    );
    const run = await service.execute(workflow.name);

    // Capture what report assembly hands to the report runner.
    let captured: { modelId: string; globalArgs: Record<string, unknown> }[] =
      [];
    (service as unknown as {
      workflowReportRunner: {
        runFor: (args: {
          stepExecutions: {
            modelId: string;
            globalArgs: Record<string, unknown>;
          }[];
        }) => Promise<unknown[]>;
      };
    }).workflowReportRunner = {
      runFor: (args) => {
        captured = args.stepExecutions;
        return Promise.resolve([]);
      },
    };

    const modelInfoByStep = new Map([[
      "job1:step1",
      {
        modelName: sharedName,
        modelType: secondaryType.normalized,
        modelId: secondaryDef.id,
        methodName: "run",
      },
    ]]);
    const stepStatuses = new Map<
      string,
      "succeeded" | "failed" | "skipped"
    >([["job1:step1", "succeeded"]]);

    const reports = (service as unknown as {
      runWorkflowReports: (
        workflow: Workflow,
        run: WorkflowRun,
        infoByStep: typeof modelInfoByStep,
        statuses: typeof stepStatuses,
        dataHandlesByStep: Map<string, unknown[]>,
        reportFilterOptions: undefined,
      ) => AsyncGenerator<unknown>;
    }).runWorkflowReports(
      workflow,
      run,
      modelInfoByStep,
      stepStatuses,
      new Map(),
      undefined,
    );
    for await (const _ of reports) { /* drain */ }

    assertEquals(captured.length, 1);
    // The step ran a model of the SECONDARY type, so its args must come from
    // that definition — not from the same-named primary one the global walk
    // would have returned.
    assertEquals(captured[0].globalArgs, { origin: "secondary" });
    // And the modelId still comes from step execution time, never the lookup.
    assertEquals(captured[0].modelId, secondaryDef.id);
  });
});

// A source definition's YAML `type` field wins over the directory it sits in,
// so a hand-placed definition can live outside its type-derived directory. A
// step that fails before its evaluated definition is saved falls back to the
// source repository, where only the global search can find such a file.
Deno.test("report assembly finds a step definition stored outside its type directory", async () => {
  const { ModelType } = await import("../models/model_type.ts");
  const { Definition } = await import("../definitions/definition.ts");
  const { ensureDir } = await import("@std/fs");
  const { stringify: stringifyYaml } = await import("@std/yaml");

  await withTempDir(async (tempDir) => {
    const modelType = ModelType.create("command/shell");
    const definition = Definition.create({
      name: "offbeat-model",
      globalArguments: { origin: "noncanonical" },
    });
    const data = definition.toData();
    data.type = modelType.normalized;
    // Not models/command/shell/ — the type comes from the YAML, not the path.
    const offbeatDir = join(tempDir, "models", "misc");
    await ensureDir(offbeatDir);
    await Deno.writeTextFile(
      join(offbeatDir, "offbeat.yaml"),
      stringifyYaml(JSON.parse(JSON.stringify(data))),
    );

    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      new MockStepExecutor(),
      undefined,
      catalogStore,
    );
    const run = await service.execute(workflow.name);

    let captured: { modelId: string; globalArgs: Record<string, unknown> }[] =
      [];
    (service as unknown as {
      workflowReportRunner: {
        runFor: (args: {
          stepExecutions: {
            modelId: string;
            globalArgs: Record<string, unknown>;
          }[];
        }) => Promise<unknown[]>;
      };
    }).workflowReportRunner = {
      runFor: (args) => {
        captured = args.stepExecutions;
        return Promise.resolve([]);
      },
    };

    const modelInfoByStep = new Map([[
      "job1:step1",
      {
        modelName: definition.name,
        modelType: modelType.normalized,
        modelId: definition.id,
        methodName: "run",
      },
    ]]);
    // Failed before an evaluated definition could be saved, so report assembly
    // has only the source repository to go on.
    const stepStatuses = new Map<
      string,
      "succeeded" | "failed" | "skipped"
    >([["job1:step1", "failed"]]);

    const reports = (service as unknown as {
      runWorkflowReports: (
        workflow: Workflow,
        run: WorkflowRun,
        infoByStep: typeof modelInfoByStep,
        statuses: typeof stepStatuses,
        dataHandlesByStep: Map<string, unknown[]>,
        reportFilterOptions: undefined,
      ) => AsyncGenerator<unknown>;
    }).runWorkflowReports(
      workflow,
      run,
      modelInfoByStep,
      stepStatuses,
      new Map(),
      undefined,
    );
    for await (const _ of reports) { /* drain */ }

    assertEquals(captured.length, 1);
    assertEquals(captured[0].globalArgs, { origin: "noncanonical" });
  });
});

// ============================================================================
// Run context selection (swamp-club#2123)
// ============================================================================

/** Captures the expression context each step was given. */
class RunContextCapturingExecutor implements StepExecutor {
  contexts: (Record<string, unknown> | undefined)[] = [];

  execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.contexts.push(
      ctx.expressionContext as unknown as Record<string, unknown> | undefined,
    );
    return Promise.resolve({ executed: true });
  }
}

function modelNamespaceKeys(
  context: Record<string, unknown> | undefined,
): string[] {
  const models = context?.["model"] as Record<string, unknown> | undefined;
  return models ? Object.keys(models) : [];
}

async function runWithCapturedContext(
  tempDir: string,
  workflow: Workflow,
  definitions: Definition[],
): Promise<RunContextCapturingExecutor> {
  const definitionRepo = new YamlDefinitionRepository(tempDir);
  const type = ModelType.create("command/shell");
  for (const definition of definitions) {
    await definitionRepo.save(type, definition);
  }

  const workflowRepo = new InMemoryWorkflowRepository();
  await workflowRepo.save(workflow);
  const executor = new RunContextCapturingExecutor();
  const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
  const service = new WorkflowExecutionService(
    workflowRepo,
    new InMemoryWorkflowRunRepository(),
    tempDir,
    executor,
    undefined,
    catalogStore,
  );

  const run = await service.execute(workflow.name);
  assertEquals(run.status, "succeeded");
  return executor;
}

Deno.test("run builds a light context when no expression needs the model namespace", async () => {
  await withTempDir(async (tempDir) => {
    const definition = Definition.create({
      name: "inputs-only",
      methods: { execute: { arguments: { run: "echo ${{ inputs.msg }}" } } },
    });
    const workflow = Workflow.create({
      name: "light-context",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("inputs-only", "execute"),
            }),
          ],
        }),
      ],
    });

    const executor = await runWithCapturedContext(tempDir, workflow, [
      definition,
    ]);

    assertEquals(modelNamespaceKeys(executor.contexts[0]), []);
  });
});

Deno.test("run builds a full context when a step definition reads the model namespace", async () => {
  await withTempDir(async (tempDir) => {
    const source = Definition.create({
      name: "source",
      globalArguments: { region: "us-east-1" },
    });
    const consumer = Definition.create({
      name: "consumer",
      methods: {
        execute: {
          arguments: {
            run: "echo ${{ model.source.definition.globalArguments.region }}",
          },
        },
      },
    });
    const workflow = Workflow.create({
      name: "full-context",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("consumer", "execute"),
            }),
          ],
        }),
      ],
    });

    const executor = await runWithCapturedContext(tempDir, workflow, [
      source,
      consumer,
    ]);

    const keys = modelNamespaceKeys(executor.contexts[0]);
    assert(keys.includes("source"));
    assert(keys.includes("consumer"));
  });
});

Deno.test("run builds a full context when the workflow itself reads the model namespace", async () => {
  await withTempDir(async (tempDir) => {
    const definition = Definition.create({
      name: "plain",
      globalArguments: { region: "us-east-1" },
    });
    const workflow = Workflow.create({
      name: "yaml-model-ref",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("plain", "execute", {
                region: "${{ model.plain.definition.globalArguments.region }}",
              }),
            }),
          ],
        }),
      ],
    });

    const executor = await runWithCapturedContext(tempDir, workflow, [
      definition,
    ]);

    assert(modelNamespaceKeys(executor.contexts[0]).includes("plain"));
  });
});

Deno.test("resume builds a full context when a step definition reads the model namespace", async () => {
  await withTempDir(async (tempDir) => {
    const definitionRepo = new YamlDefinitionRepository(tempDir);
    const type = ModelType.create("command/shell");
    await definitionRepo.save(
      type,
      Definition.create({
        name: "source",
        globalArguments: { region: "us-east-1" },
      }),
    );
    await definitionRepo.save(
      type,
      Definition.create({
        name: "consumer",
        methods: {
          execute: {
            arguments: {
              run: "echo ${{ model.source.definition.globalArguments.region }}",
            },
          },
        },
      }),
    );

    const workflow = Workflow.create({
      name: "resume-context",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
            Step.create({
              name: "step1",
              task: StepTask.model("consumer", "execute"),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    const workflowRepo = new InMemoryWorkflowRepository();
    await workflowRepo.save(workflow);
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new RunContextCapturingExecutor();
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");

    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    const gate = toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!;
    gate.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    gate.succeed();
    await runRepo.save(workflow.id, toApprove!);

    let resumedRun: WorkflowRun | undefined;
    for await (const event of service.resume(workflow.name, suspended.id)) {
      if (event.kind === "completed") resumedRun = event.run;
    }
    assertEquals(resumedRun?.status, "succeeded");

    // Only step1 ran, and it ran under resume() — the gate suspended before
    // any step reached the executor, so this is resume's own context.
    assertEquals(executor.contexts.length, 1);
    // The resumed step's definition reads model.source, so resume must have
    // taken the same full-context decision that run() takes.
    assert(modelNamespaceKeys(executor.contexts[0]).includes("source"));
  });
});
// Resume-time inputs are audited by key only; a resumed parent that calls a
// child with a runtime expression must not snapshot their values into the
// child's persisted deferred bindings.
Deno.test("resume: resume-only inputs are excluded from the child's deferred bindings", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const childWorkflow = Workflow.create({
      name: "child-of-resumed",
      inputs: { properties: { home: { type: "string" } } },
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "child-step",
              task: StepTask.modelMethod("some-model", "run", {
                home: "${{ inputs.home }}",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(childWorkflow);

    const parentWorkflow = Workflow.create({
      name: "parent-with-gate",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Mint the token first"),
            }),
            // Iterates a resume-time input, so self.item carries its value.
            Step.create({
              name: "call-child",
              forEach: { item: "item", in: "${{ inputs.items }}" },
              task: StepTask.workflow("child-of-resumed", {
                home: "${{ env.HOME }}",
              }),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(parentWorkflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(parentWorkflow.name, {
      inputs: { region: "us-east", items: [] },
    });
    assertEquals(suspended.status, "suspended");

    const toApprove = await runRepo.findById(parentWorkflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(parentWorkflow.id, toApprove!);

    const secret = `resume-secret-${crypto.randomUUID()}`;
    let resumedRun: WorkflowRun | undefined;
    for await (
      const event of service.resume(parentWorkflow.name, suspended.id, {
        inputs: { token: secret, items: [{ token: secret }] },
      })
    ) {
      if (event.kind === "completed") resumedRun = event.run;
    }
    assertEquals(resumedRun?.status, "succeeded");

    const childRun = (await runRepo.findAllByWorkflowId(childWorkflow.id))[0];
    const [record] = childRun.deferredExpressions;
    assertEquals(record.expression, "${{ env.HOME }}");
    // The suspend-time inputs are still in scope; the resume-only ones and
    // the forEach item iterated out of one are not.
    assertEquals(record.bindings.inputs, { region: "us-east" });
    assertEquals("item" in (record.bindings.self ?? {}), false);
    assertEquals(JSON.stringify(childRun.toData()).includes(secret), false);
  });
});

for (const target of ["name", "id", "direct"]) {
  for (
    const dependency of [
      "env",
      "model",
      "file",
      "missing-cache",
      "dynamic",
      "missing-source",
      ...(target === "direct" ? ["dynamic-type", "invalid-type"] : []),
    ]
  ) {
    Deno.test(`buildRunContext: cached ${target} target with ${dependency} selects the required namespaces`, async () => {
      await withTempDir(async (tempDir) => {
        const { YamlEvaluatedDefinitionRepository } = await import(
          "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts"
        );
        const { YamlEvaluatedWorkflowRepository } = await import(
          "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts"
        );
        const type = ModelType.create("command/shell");
        const definitionRepo = new YamlDefinitionRepository(tempDir);
        const source = Definition.create({ name: "consumer" });
        if (dependency !== "missing-source") {
          await definitionRepo.save(type, source);
        }
        await definitionRepo.save(
          type,
          Definition.create({
            name: "producer",
            globalArguments: { prefix: "from-source" },
          }),
        );
        if (dependency !== "missing-cache") {
          const cached = Definition.fromData(source.toData());
          cached.setMethodArgument(
            "execute",
            "run",
            dependency === "model"
              ? '${{ env["HOME"] + model.producer.input.globalArguments.prefix }}'
              : dependency === "file"
              ? '${{ env["HOME"] + file.contents("producer", "notes") }}'
              : '${{ env["HOME"] }}',
          );
          await new YamlEvaluatedDefinitionRepository(tempDir).save(
            type,
            cached,
          );
        }
        const reference = dependency === "dynamic"
          ? '${{ env["MODEL"] }}'
          : target === "id"
          ? source.id
          : source.name;
        const task = target === "direct"
          ? StepTask.directExecution(
            dependency === "invalid-type"
              ? "/"
              : dependency === "dynamic-type"
              ? '${{ env["TYPE"] }}'
              : type.normalized,
            reference,
            "execute",
          )
          : StepTask.model(reference, "execute");
        const workflow = Workflow.create({
          name: "cached-context",
          jobs: [
            Job.create({
              name: "main",
              steps: [Step.create({ name: "capture", task })],
            }),
          ],
        });
        const workflowRepo = new InMemoryWorkflowRepository();
        await workflowRepo.save(workflow);
        await new YamlEvaluatedWorkflowRepository(tempDir).save(workflow);
        const executor = new RunContextCapturingExecutor();
        const catalog = new CatalogStore(join(tempDir, "_catalog.db"));
        try {
          const service = new WorkflowExecutionService(
            workflowRepo,
            new InMemoryWorkflowRunRepository(),
            tempDir,
            executor,
            undefined,
            catalog,
          );
          const run = await service.execute(workflow.name, {
            lastEvaluated: true,
            inputs: { suffix: "replayed" },
          });
          assertEquals(run.status, "succeeded");
          const needsFullContext = dependency !== "env" &&
            !(dependency === "missing-source" && target === "direct");
          assertEquals(
            modelNamespaceKeys(executor.contexts[0]).includes("producer"),
            needsFullContext,
          );
          assertEquals(executor.contexts[0]?.inputs, { suffix: "replayed" });
          if (dependency === "file") assertExists(executor.contexts[0]?.file);
        } finally {
          catalog.close();
        }
      });
    });
  }
}

/**
 * Records every tracker call so a test can assert the status the workflow
 * reported. Only the methods the execution service reaches are implemented.
 */
class RecordingRunTracker implements RunTrackerRepository {
  readonly completions: { runId: string; status: ActiveRunStatus }[] = [];

  register(_run: ActiveRun): void {}

  heartbeat(_runId: string): void {}

  complete(runId: string, status: ActiveRunStatus, _reason?: string): void {
    this.completions.push({ runId, status });
  }

  readonly reactivations: { runId: string; pid: number; hostname: string }[] =
    [];

  reactivate(runId: string, pid: number, hostname: string): void {
    this.reactivations.push({ runId, pid, hostname });
  }

  findById(_runId: string): ActiveRun | null {
    return null;
  }

  findAllRunning(): ActiveRun[] {
    return [];
  }

  findStaleRuns(_ttlMs: number): ActiveRun[] {
    return [];
  }

  findAll(): ActiveRun[] {
    return [];
  }

  findRecent(_hours?: number): ActiveRun[] {
    return [];
  }

  reapStaleRuns(_ttlMs: number, _instanceId?: string): ActiveRun[] {
    return [];
  }

  close(): void {}
}

function serviceWithTracker(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  tempDir: string,
  executor: StepExecutor,
  catalogStore: CatalogStore,
  tracker: RunTrackerRepository,
): WorkflowExecutionService {
  return new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    tempDir,
    executor,
    undefined,
    catalogStore,
    undefined,
    undefined,
    undefined,
    undefined,
    tracker,
  );
}

Deno.test("run tracker records failed when a workflow step fails", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("step1");
    const tracker = new RecordingRunTracker();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = serviceWithTracker(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      catalogStore,
      tracker,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "failed");
    assertEquals(tracker.completions, [{ runId: run.id, status: "failed" }]);
  });
});

Deno.test("run tracker records completed when the workflow succeeds", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    const tracker = new RecordingRunTracker();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = serviceWithTracker(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      catalogStore,
      tracker,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(tracker.completions, [{ runId: run.id, status: "completed" }]);
  });
});

Deno.test("resume: run tracker records failed when a step fails after approval", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    executor.shouldFail.add("after-gate");
    const tracker = new RecordingRunTracker();

    const workflow = Workflow.create({
      name: "resume-failure",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
            Step.create({
              name: "after-gate",
              task: StepTask.model("test-model", "run"),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = serviceWithTracker(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      catalogStore,
      tracker,
    );

    const suspended = await service.execute(workflow.name);
    assertEquals(suspended.status, "suspended");

    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    let resumedRun: WorkflowRun | undefined;
    for await (const event of service.resume(workflow.name, suspended.id)) {
      if (event.kind === "completed") resumedRun = event.run;
    }

    assertEquals(resumedRun?.status, "failed");
    assertEquals(tracker.completions, [
      { runId: suspended.id, status: "suspended" },
      { runId: suspended.id, status: "failed" },
    ]);
  });
});

Deno.test("trackerStatusForRun: maps every aggregate status to the tracker vocabulary", () => {
  const cases: [WorkflowRun["status"], ActiveRunStatus][] = [
    ["pending", "completed"],
    ["running", "completed"],
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["interrupted", "interrupted"],
    ["suspended", "suspended"],
  ];

  for (const [aggregate, expected] of cases) {
    assertEquals(trackerStatusForRun(aggregate), expected);
  }
});

// ---------------------------------------------------------------------------
// Task target deferral (swamp-club#2304)
//
// A guarded step never runs, but its task target used to be evaluated at run
// start anyway. A target resolving to an empty string then failed StepTask
// validation while the evaluated workflow was rebuilt, killing the whole run
// before any step executed — and recording no run at all, so there was nothing
// to inspect afterwards.
// ---------------------------------------------------------------------------

/** Builds a two-job workflow whose second step is optionally guarded. */
function targetWorkflow(opts: {
  name: string;
  target: string;
  guard?: string;
}): Workflow {
  return Workflow.create({
    name: opts.name,
    inputs: {
      type: "object",
      properties: { target: { type: "string", default: "" } },
    },
    jobs: [
      Job.create({
        name: "writer",
        steps: [
          Step.create({ name: "write", task: StepTask.model("writer", "run") }),
        ],
      }),
      Job.create({
        name: "consumer",
        dependsOn: [{ job: "writer", condition: TriggerCondition.succeeded() }],
        steps: [
          Step.create({
            name: "consume",
            guard: opts.guard,
            task: StepTask.model(opts.target, "run"),
          }),
        ],
      }),
    ],
  });
}

Deno.test("task target: a guarded step with a valid dynamic target still executes when its guard is false", async () => {
  // The ordinary case, and the one the widening actually risks: every guarded
  // step in the repo's own verification workflow names a run-id-based model.
  // This must pass before and after the change.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = targetWorkflow({
      name: "valid-dynamic-target",
      target: "${{ inputs.target }}",
      guard: "${{ false }}",
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (
      const _ of service.run(workflow.name, { inputs: { target: "writer" } })
    ) { /* drain */ }

    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    assertEquals(
      runs[0].getJob("consumer")?.getStep("consume")?.status,
      "succeeded",
    );
  });
});

Deno.test("task target: a guarded step whose target resolves to empty skips instead of killing the run", async () => {
  // The reported defect. The target is a plain inputs reference with no
  // step-output dependency, so only the guard condition defers it.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = targetWorkflow({
      name: "guarded-empty-target",
      target: "${{ inputs.target }}",
      guard: "${{ true }}",
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (
      const _ of service.run(workflow.name, { inputs: { target: "" } })
    ) { /* drain */ }

    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    assertEquals(runs.length, 1);
    assertEquals(runs[0].status, "succeeded");
    assertEquals(
      runs[0].getJob("writer")?.getStep("write")?.status,
      "succeeded",
    );
    assertEquals(
      runs[0].getJob("consumer")?.getStep("consume")?.status,
      "skipped",
    );
  });
});

Deno.test("task target: an unguarded step with an empty target still fails at run start", async () => {
  // Fail-fast is deliberately preserved. Deferral buys nothing for a step that
  // is going to run, and a mistyped target should surface before any work.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = targetWorkflow({
      name: "unguarded-empty-target",
      target: "${{ inputs.target }}",
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    let error: string | undefined;
    try {
      for await (
        const _ of service.run(workflow.name, { inputs: { target: "" } })
      ) { /* drain */ }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    assertStringIncludes(
      error ?? "",
      "requires either modelIdOrName or modelType",
    );
    assertEquals(executor.executedSteps, []);
  });
});

Deno.test("task target: a guarded forEach step resolves its deferred target per expansion", async () => {
  // The only place in this change where one deferred expression yields several
  // values: the target is a single raw string shared by every expansion and
  // resolved against each expansion's own self context.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "guarded-foreach-target",
      inputs: {
        type: "object",
        properties: { targets: { type: "array" } },
      },
      jobs: [
        Job.create({
          name: "fan-out",
          steps: [
            Step.create({
              name: "run-${{ self.t }}",
              guard: "${{ false }}",
              task: StepTask.model("${{ self.t }}", "run"),
              forEach: { item: "t", in: "${{ inputs.targets }}" },
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (
      const _ of service.run(workflow.name, {
        inputs: { targets: ["alpha", "beta"] },
      })
    ) { /* drain */ }

    // Each expansion executed against its own target, not a shared one.
    assertEquals(executor.executedSteps.sort(), [
      "fan-out/run-alpha",
      "fan-out/run-beta",
    ]);
  });
});

Deno.test("task target: a deferred target survives --last-evaluated and resolves from cache", async () => {
  // A deferred target is persisted raw in the evaluated workflow. On a
  // --last-evaluated run, evaluation is skipped entirely, so the raw target has
  // to survive to step time and resolve there.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = targetWorkflow({
      name: "last-evaluated-target",
      target: "${{ inputs.target }}",
      guard: "${{ false }}",
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    for await (
      const _ of service.run(workflow.name, { inputs: { target: "writer" } })
    ) { /* drain */ }
    for await (
      const _ of service.run(workflow.name, {
        inputs: { target: "writer" },
        lastEvaluated: true,
      })
    ) { /* drain */ }

    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    assertEquals(runs.length, 2);
    for (const run of runs) {
      assertEquals(
        run.getJob("consumer")?.getStep("consume")?.status,
        "succeeded",
      );
    }
  });
});

Deno.test("task target: a deferred target resolves after suspend and resume", async () => {
  // Resume re-establishes expression provenance from persisted state rather
  // than re-deriving it at run start, and a deferred target is exactly the kind
  // of raw expression that path has to carry. Every other route by which a
  // target survives as a raw expression is covered; this is the last.
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = Workflow.create({
      name: "suspend-resume-target",
      inputs: {
        type: "object",
        properties: { target: { type: "string", default: "" } },
      },
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
            Step.create({
              name: "consume",
              guard: "${{ false }}",
              task: StepTask.model("${{ inputs.target }}", "run"),
              dependsOn: [
                { step: "gate", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
      undefined,
      catalogStore,
    );

    const suspended = await service.execute(workflow.name, {
      inputs: { target: "writer" },
    });
    assertEquals(suspended.status, "suspended");

    const toApprove = await runRepo.findById(workflow.id, suspended.id);
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await runRepo.save(workflow.id, toApprove!);

    let resumed: WorkflowRun | undefined;
    for await (const event of service.resume(workflow.name, suspended.id)) {
      if (event.kind === "completed") resumed = event.run;
    }

    assertEquals(resumed?.status, "succeeded");
    assertEquals(resumed?.getJob("j")?.getStep("consume")?.status, "succeeded");
    assertEquals(executor.executedSteps, ["j/consume"]);
  });
});

// ---------------------------------------------------------------------------
// Nested workflow targets and the steps namespace (swamp-club#2351)
//
// A nested workflow step's workflowIdOrName is a task target too: deferred
// past run start when it reads step output or its step carries a guard, and
// resolved in runWorkflowStep after the guard has decided. A steps.* reference
// used to fail the whole run at start with "Unknown variable: steps".
// ---------------------------------------------------------------------------

/** A one-step child workflow whose single step names the child. */
function childWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name,
        steps: [
          Step.create({ name: "announce", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
}

/** Runs `workflow` (and the saved children) and returns the recorded run. */
async function runWithChildren(
  tempDir: string,
  workflow: Workflow,
  inputs: Record<string, unknown> = {},
) {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new MockStepExecutor();
  for (const name of ["child-a", "child-b"]) {
    await workflowRepo.save(childWorkflow(name));
  }
  await workflowRepo.save(workflow);

  const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    tempDir,
    executor,
    undefined,
    catalogStore,
  );
  const run = await service.execute(workflow.name, { inputs });
  return { run, executor };
}

Deno.test("workflow target: a guarded nested workflow step resolves its deferred target at step time", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = Workflow.create({
      name: "guarded-workflow-target",
      inputs: {
        type: "object",
        properties: { child: { type: "string", default: "" } },
      },
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "dispatch",
              guard: "${{ false }}",
              task: StepTask.workflow("${{ inputs.child }}"),
            }),
          ],
        }),
      ],
    });

    const { run, executor } = await runWithChildren(tempDir, workflow, {
      child: "child-b",
    });

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["child-b/announce"]);
  });
});

Deno.test("workflow target: a guarded nested workflow step with an empty target skips instead of killing the run", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = Workflow.create({
      name: "guarded-empty-workflow-target",
      inputs: {
        type: "object",
        properties: { child: { type: "string", default: "" } },
      },
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({
              name: "dispatch",
              guard: "${{ true }}",
              task: StepTask.workflow("${{ inputs.child }}"),
            }),
          ],
        }),
      ],
    });

    const { run, executor } = await runWithChildren(tempDir, workflow, {
      child: "",
    });

    assertEquals(run.status, "succeeded");
    assertEquals(run.getJob("j")?.getStep("dispatch")?.status, "skipped");
    assertEquals(executor.executedSteps, []);
  });
});

Deno.test("steps namespace: steps.* in task.inputs and a workflow target resolves at step time", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = Workflow.create({
      name: "steps-namespace-target",
      jobs: [
        Job.create({
          name: "j",
          steps: [
            Step.create({ name: "write", task: StepTask.model("m", "run") }),
            Step.create({
              name: "consume",
              task: StepTask.model("m", "run", {
                status: "${{ steps.write.status }}",
              }),
              dependsOn: [
                { step: "write", condition: TriggerCondition.succeeded() },
              ],
            }),
            Step.create({
              name: "dispatch",
              task: StepTask.workflow(
                "${{ steps.write.status == 'succeeded' ? 'child-b' : 'child-a' }}",
              ),
              dependsOn: [
                { step: "write", condition: TriggerCondition.succeeded() },
              ],
            }),
          ],
        }),
      ],
    });

    const { run, executor } = await runWithChildren(tempDir, workflow);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.includes("j/consume"), true);
    assertEquals(executor.executedSteps.includes("child-b/announce"), true);
    assertEquals(executor.executedSteps.includes("child-a/announce"), false);
  });
});

// ---------------------------------------------------------------------------
// Retry: resume a failed run without --from (swamp-club#2409)
// ---------------------------------------------------------------------------

/** Counts calls per `job/step` and fails the steps named in `failing`. */
class CountingStepExecutor implements StepExecutor {
  readonly calls = new Map<string, number>();
  readonly failing = new Set<string>();

  execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    const key = `${ctx.jobName}/${ctx.stepName}`;
    const attempt = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, attempt);
    if (this.failing.has(ctx.stepName)) {
      return Promise.reject(new Error(`${ctx.stepName} failed`));
    }
    return Promise.resolve({ step: ctx.stepName, attempt });
  }

  count(key: string): number {
    return this.calls.get(key) ?? 0;
  }
}

/** Counts saves, and can fail every save after the first `allowSaves`. */
class SpyWorkflowRunRepository extends InMemoryWorkflowRunRepository {
  saves = 0;
  allowSaves = Infinity;

  override save(workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    this.saves++;
    if (this.saves > this.allowSaves) {
      return Promise.reject(new Error("datastore unavailable"));
    }
    return super.save(workflowId, run);
  }
}

function modelStep(
  name: string,
  opts: {
    dependsOn?: { step: string; condition: TriggerCondition }[];
    inputs?: Record<string, unknown>;
    guard?: string;
  } = {},
): Step {
  return Step.create({
    name,
    task: StepTask.model("test-model", "run", opts.inputs),
    dependsOn: opts.dependsOn,
    guard: opts.guard,
  });
}

/**
 * build: compile → test, plus a cleanup that runs once compile completes;
 * deploy depends on build; docs is independent.
 */
function createRetryWorkflow(): Workflow {
  return Workflow.create({
    name: "retry-wf",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          modelStep("compile"),
          modelStep("test", {
            dependsOn: [{
              step: "compile",
              condition: TriggerCondition.succeeded(),
            }],
          }),
          modelStep("cleanup", {
            dependsOn: [{
              step: "compile",
              condition: TriggerCondition.completed(),
            }],
          }),
        ],
      }),
      Job.create({
        name: "deploy",
        dependsOn: [{ job: "build", condition: TriggerCondition.succeeded() }],
        steps: [modelStep("push")],
      }),
      Job.create({ name: "docs", steps: [modelStep("publish")] }),
    ],
  });
}

async function setupRetry(
  tempDir: string,
  workflow: Workflow,
  tracker?: RunTrackerRepository,
) {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new SpyWorkflowRunRepository();
  const executor = new CountingStepExecutor();
  await workflowRepo.save(workflow);
  const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    tempDir,
    executor,
    undefined,
    catalogStore,
    undefined,
    undefined,
    undefined,
    undefined,
    tracker,
  );
  return { workflowRepo, runRepo, executor, service };
}

async function drainResume(
  service: WorkflowExecutionService,
  workflowName: string,
  runId: string,
  options?: Parameters<WorkflowExecutionService["resume"]>[2],
): Promise<WorkflowRun | undefined> {
  let completed: WorkflowRun | undefined;
  for await (const event of service.resume(workflowName, runId, options)) {
    if (event.kind === "completed") completed = event.run;
  }
  return completed;
}

Deno.test("resume: retries the failed steps of a failed run without fromStep", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createRetryWorkflow();
    const { runRepo, executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("compile");

    const failed = await service.execute(workflow.name);
    assertEquals(failed.status, "failed");
    const build = failed.getJob("build")!;
    assertEquals(build.getStep("test")!.status, "skipped");
    assertEquals(build.getStep("cleanup")!.status, "succeeded");
    assertEquals(failed.getJob("deploy")!.status, "skipped");
    assertEquals(failed.getJob("docs")!.status, "succeeded");
    const startedAt = failed.startedAt!.toISOString();
    const publishOutput = failed.getJob("docs")!.getStep("publish")!.toData();

    executor.failing.clear();
    const retried = await drainResume(service, workflow.name, failed.id);

    assertEquals(retried?.id, failed.id);
    assertEquals(retried?.status, "succeeded");
    assertEquals(retried?.startedAt?.toISOString(), startedAt);
    assertEquals(executor.count("build/compile"), 2);
    assertEquals(executor.count("build/test"), 1);
    // A successful cleanup that depends on the failed step runs again.
    assertEquals(executor.count("build/cleanup"), 2);
    assertEquals(executor.count("deploy/push"), 1);
    // Independent successful work is not repeated and keeps its result.
    assertEquals(executor.count("docs/publish"), 1);
    const stored = await runRepo.findById(workflow.id, failed.id);
    assertEquals(stored?.status, "succeeded");
    assertEquals(
      stored?.getJob("docs")?.getStep("publish")?.toData(),
      publishOutput,
    );
  });
});

Deno.test("resume: retries parallel failures in several jobs in one resume", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = Workflow.create({
      name: "parallel-wf",
      jobs: [
        Job.create({ name: "a", steps: [modelStep("step-a")] }),
        Job.create({ name: "b", steps: [modelStep("step-b")] }),
        Job.create({ name: "c", steps: [modelStep("step-c")] }),
      ],
    });
    const { executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("step-a");
    executor.failing.add("step-b");

    const failed = await service.execute(workflow.name);
    assertEquals(failed.status, "failed");

    executor.failing.clear();
    const retried = await drainResume(service, workflow.name, failed.id);

    assertEquals(retried?.status, "succeeded");
    assertEquals(executor.count("a/step-a"), 2);
    assertEquals(executor.count("b/step-b"), 2);
    assertEquals(executor.count("c/step-c"), 1);
  });
});

Deno.test("resume: retry re-runs every iteration of a failed forEach template", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = Workflow.create({
      name: "each-wf",
      jobs: [
        Job.create({
          name: "plates",
          steps: [
            Step.create({
              name: "read-${{ self.plate }}",
              task: StepTask.model("test-model", "run"),
              forEach: { item: "plate", in: "${{ inputs.plates }}" },
            }),
          ],
        }),
      ],
    });
    const { executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("read-b");

    const failed = await service.execute(workflow.name, {
      inputs: { plates: ["a", "b", "c"] },
    });
    assertEquals(failed.status, "failed");

    executor.failing.clear();
    const retried = await drainResume(service, workflow.name, failed.id);

    assertEquals(retried?.status, "succeeded");
    assertEquals(executor.count("plates/read-a"), 2);
    assertEquals(executor.count("plates/read-b"), 2);
    assertEquals(executor.count("plates/read-c"), 2);
  });
});

Deno.test("resume: a guard still decides whether a reset step runs on retry", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = Workflow.create({
      name: "guard-retry-wf",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            modelStep("compile"),
            modelStep("announce", {
              dependsOn: [{
                step: "compile",
                condition: TriggerCondition.completed(),
              }],
              guard: "${{ inputs.quiet == true }}",
            }),
          ],
        }),
      ],
    });
    const { executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("compile");

    const failed = await service.execute(workflow.name, {
      inputs: { quiet: false },
    });
    assertEquals(failed.status, "failed");
    assertEquals(
      failed.getJob("main")!.getStep("announce")!.status,
      "succeeded",
    );

    executor.failing.clear();
    const retried = await drainResume(service, workflow.name, failed.id, {
      inputs: { quiet: true },
    });

    assertEquals(retried?.status, "succeeded");
    assertEquals(executor.count("main/announce"), 1);
    const announce = retried!.getJob("main")!.getStep("announce")!;
    assertEquals(announce.status, "skipped");
    // The guard skip does not restore the earlier attempt's output.
    assertEquals(announce.output, undefined);
  });
});

Deno.test("resume: refuses an ineligible failed run without saving or running anything", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createRetryWorkflow();
    const { runRepo, executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("compile");
    const failed = await service.execute(workflow.name);
    // An earlier retry that threw mid-execution leaves pending reset steps.
    failed.getJob("build")!.getStep("test")!.resetToPending();
    const before = JSON.stringify(failed.toData());
    const saves = runRepo.saves;
    const calls = [...executor.calls.values()].reduce((a, b) => a + b, 0);

    await assertRejects(
      () => drainResume(service, workflow.name, failed.id),
      Error,
      `Step "test" in job "build" is pending`,
    );

    assertEquals(runRepo.saves, saves);
    assertEquals(JSON.stringify(failed.toData()), before);
    assertEquals(
      [...executor.calls.values()].reduce((a, b) => a + b, 0),
      calls,
    );
  });
});

Deno.test("resume: suspendedOnly refuses a failed run", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createRetryWorkflow();
    const { runRepo, executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("compile");
    const failed = await service.execute(workflow.name);
    const saves = runRepo.saves;

    const error = await assertRejects(
      () =>
        drainResume(service, workflow.name, failed.id, { suspendedOnly: true }),
      Error,
      `Run ${failed.id} is not suspended (status: failed)`,
    );
    assertStringIncludes(
      error.message,
      `Retry it with 'swamp workflow resume retry-wf --run ${failed.id}'.`,
    );
    assertEquals(runRepo.saves, saves);
    assertEquals(failed.status, "failed");
  });
});

Deno.test("resume: refuses a succeeded run and names the next action", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createRetryWorkflow();
    const { service } = await setupRetry(tempDir, workflow);
    const run = await service.execute(workflow.name);
    assertEquals(run.status, "succeeded");

    const error = await assertRejects(
      () => drainResume(service, workflow.name, run.id),
      Error,
      "is not suspended or failed (status: succeeded)",
    );
    assertStringIncludes(error.message, "swamp workflow history retry-wf");
  });
});

Deno.test("resume: hands the tracker row to the resuming process", async () => {
  await withTempDir(async (tempDir) => {
    const tracker = new RecordingRunTracker();
    const workflow = createRetryWorkflow();
    const { executor, service } = await setupRetry(
      tempDir,
      workflow,
      tracker,
    );
    executor.failing.add("compile");
    const failed = await service.execute(workflow.name);

    executor.failing.clear();
    await drainResume(service, workflow.name, failed.id);

    assertEquals(tracker.reactivations, [
      { runId: failed.id, pid: Deno.pid, hostname: hostname() },
    ]);
    assertEquals(tracker.completions, [
      { runId: failed.id, status: "failed" },
      { runId: failed.id, status: "completed" },
    ]);
  });
});

/** One step whose input reads `inputs.n`, so a string `n` fails evaluation. */
function createArithmeticWorkflow(withGate: boolean): Workflow {
  const steps = [
    modelStep("compute", { inputs: { value: "${{ inputs.n + 1 }}" } }),
  ];
  if (withGate) {
    steps.unshift(
      Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
    );
  }
  return Workflow.create({
    name: withGate ? "gated-arith-wf" : "arith-wf",
    jobs: [Job.create({ name: "main", steps })],
  });
}

Deno.test("resume: restores a failed run when evaluation fails before execution", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createArithmeticWorkflow(false);
    const { runRepo, executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("compute");
    const failed = await service.execute(workflow.name, { inputs: { n: 1 } });
    assertEquals(failed.status, "failed");
    const before = failed.toData();

    executor.failing.clear();
    await assertRejects(
      () =>
        drainResume(service, workflow.name, failed.id, { inputs: { n: "x" } }),
      Error,
      "no such overload",
    );

    const stored = await runRepo.findById(workflow.id, failed.id);
    assertEquals(stored?.status, "failed");
    assertEquals(stored?.toData(), before);
    assertEquals(executor.count("main/compute"), 1);
  });
});

Deno.test("resume: restores a suspended run when evaluation fails before execution", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createArithmeticWorkflow(true);
    const { runRepo, service } = await setupRetry(tempDir, workflow);
    const suspended = await service.execute(workflow.name, {
      inputs: { n: 1 },
    });
    assertEquals(suspended.status, "suspended");
    suspended.getJob("main")!.getStep("gate")!.succeed();
    await runRepo.save(workflow.id, suspended);
    const before = suspended.toData();

    await assertRejects(
      () =>
        drainResume(service, workflow.name, suspended.id, {
          inputs: { n: "x" },
        }),
      Error,
      "no such overload",
    );

    const stored = await runRepo.findById(workflow.id, suspended.id);
    assertEquals(stored?.status, "suspended");
    assertEquals(stored?.toData(), before);
  });
});

Deno.test("resume: a failing restore still rethrows the original error", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = createArithmeticWorkflow(false);
    const { runRepo, executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("compute");
    const failed = await service.execute(workflow.name, { inputs: { n: 1 } });
    // Allow resume's early save, then fail the restore.
    runRepo.allowSaves = runRepo.saves + 1;

    // The evaluation error, not the restore's datastore error.
    await assertRejects(
      () =>
        drainResume(service, workflow.name, failed.id, { inputs: { n: "x" } }),
      Error,
      "no such overload",
    );
  });
});

/** A one-step workflow whose step input resolves `inputs.greeting`. */
function greetingWorkflow(message: string, id?: string): Workflow {
  return Workflow.create({
    id,
    name: "recover-greeting",
    inputs: {
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
    },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "greet",
            task: StepTask.modelMethod("some-model", "run", { message }),
          }),
        ],
      }),
    ],
  });
}

/**
 * Rewinds a completed one-step run to mid-step and interrupts it, the state
 * a crash leaves behind. `interrupt` returns early on a succeeded run.
 */
function interruptMidStep(run: WorkflowRun): WorkflowRun {
  const data = run.toData();
  const job = data.jobs[0];
  const step = job.steps[0];
  data.status = "running";
  data.completedAt = undefined;
  job.status = "running";
  job.completedAt = undefined;
  step.status = "running";
  step.completedAt = undefined;
  step.output = undefined;
  const rewound = WorkflowRun.fromData(data);
  rewound.interrupt("server_crash");
  return rewound;
}

Deno.test("WorkflowExecutionService.run: definition fingerprint lets recovery match a workflow with an inputs expression", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const workflow = greetingWorkflow("${{ inputs.greeting }}");
    await workflowRepo.save(workflow);

    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      new MockStepExecutor(),
      undefined,
      catalogStore,
    );

    const run = await service.execute(workflow.name, {
      inputs: { greeting: "howdy" },
    });

    assertEquals(run.status, "succeeded");
    const definitionFingerprint = await computeWorkflowFingerprint(workflow);
    assertEquals(run.runPlan?.definitionFingerprint, definitionFingerprint);
    // Evaluation resolved the inputs expression, so the evaluated
    // fingerprint differs from the definition's.
    assertNotEquals(run.runPlan?.fingerprint, definitionFingerprint);

    const interrupted = interruptMidStep(run);
    const unchanged = await assessRecoveryForRun(workflow, interrupted);
    assertEquals(unchanged.fingerprintMismatch, false);
    assertEquals(unchanged.unguardedSteps, ["greet"]);

    const edited = greetingWorkflow(
      "${{ inputs.greeting }} again",
      workflow.id,
    );
    const drifted = await assessRecoveryForRun(edited, interrupted);
    assertEquals(drifted.fingerprintMismatch, true);
  });
});

// swamp-club#2381: workflow execution resolves its datastore-tier subdirs
// through the datastore path resolver, as the model-method path does.

/** Files under `root`, relative and sorted; empty when `root` is missing. */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of walk(root, { includeDirs: false })) {
      files.push(relative(root, entry.path));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files.sort();
}

/** A filesystem datastore rooted outside the repo's `.swamp/`. */
function externalDatastore(
  repoDir: string,
  datastoreDir: string,
): DefaultDatastorePathResolver {
  return new DefaultDatastorePathResolver(repoDir, {
    type: "filesystem",
    path: datastoreDir,
  });
}

function serviceWithResolver(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  repoDir: string,
  executor: StepExecutor,
  catalogStore: CatalogStore,
  datastoreResolver: DefaultDatastorePathResolver,
): WorkflowExecutionService {
  return new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    repoDir,
    executor,
    undefined,
    catalogStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    datastoreResolver,
  );
}

Deno.test("WorkflowExecutionService: passes the datastore resolver to step, guard model.method() and child workflow contexts (swamp-club#2381)", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const resolvers = new Map<string, unknown>();
    const executor: StepExecutor = {
      execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
        resolvers.set(ctx.stepName, ctx.datastoreResolver);
        // A null guard result lets the guarded step run as well.
        return Promise.resolve(
          ctx.stepName.startsWith("__guard_") ? null : { executed: true },
        );
      },
    };
    await workflowRepo.save(Workflow.create({
      name: "child",
      jobs: [Job.create({
        name: "job1",
        steps: [Step.create({
          name: "child-step",
          task: StepTask.modelMethod("some-model", "run"),
        })],
      })],
    }));
    const parent = Workflow.create({
      name: "parent",
      jobs: [Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "guarded",
            task: StepTask.modelMethod("some-model", "run"),
            guard: '${{ model.method("infra", "exists") }}',
          }),
          Step.create({
            name: "call-child",
            task: StepTask.workflow("child"),
          }),
        ],
      })],
    });
    await workflowRepo.save(parent);

    const resolver = externalDatastore(tempDir, join(tempDir, "external-ds"));
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      const run = await serviceWithResolver(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        catalogStore,
        resolver,
      ).execute(parent.name);
      assertEquals(run.status, "succeeded");
    } finally {
      catalogStore.close();
    }

    assertEquals([...resolvers.keys()].sort(), [
      "__guard_guarded",
      "child-step",
      "guarded",
    ]);
    for (const [stepName, seen] of resolvers) {
      assertEquals(seen === resolver, true, `${stepName} lost the resolver`);
    }
  });
});

Deno.test("WorkflowExecutionService: saves and replays evaluated workflows through the datastore resolver (swamp-club#2381)", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();
    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const datastoreDir = join(tempDir, "external-ds");
    const resolver = externalDatastore(tempDir, datastoreDir);
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      const service = serviceWithResolver(
        workflowRepo,
        runRepo,
        tempDir,
        executor,
        catalogStore,
        resolver,
      );
      const run = await service.execute(workflow.name);
      assertEquals(run.status, "succeeded");

      const evaluated = await listFiles(
        join(datastoreDir, "workflows-evaluated"),
      );
      assertEquals(evaluated.length, 2, JSON.stringify(evaluated));
      assertEquals(
        evaluated.includes(join("runs", run.id, "evaluated-workflow.yaml")),
        true,
        JSON.stringify(evaluated),
      );
      assertEquals(
        await listFiles(join(tempDir, ".swamp", "workflows-evaluated")),
        [],
      );

      // Nothing repo-local exists, so a replay must read the datastore copy.
      const replay = await service.execute(workflow.name, {
        lastEvaluated: true,
      });
      assertEquals(replay.status, "succeeded");
    } finally {
      catalogStore.close();
    }
  });
});

/** Registers a per-run model type whose `run` method records its arguments. */
async function registerRecordingModel(
  received: unknown[],
): Promise<ModelType> {
  const { z } = await import("zod");
  const { modelRegistry } = await import("../models/model.ts");
  const { initializeLogging } = await import(
    "../../infrastructure/logging/logger.ts"
  );
  await initializeLogging({});
  const modelType = ModelType.create(
    `@test-2381/routing-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type: modelType,
    version: "2026.01.01.1",
    globalArguments: z.object({}),
    resources: {},
    methods: {
      run: {
        description: "records its arguments",
        arguments: z.object({ value: z.string() }),
        execute: (args: { value: string }) => {
          received.push(args);
          return Promise.resolve({});
        },
      },
    },
  });
  return modelType;
}

function recordingDefinition(name: string, modelType: ModelType): Definition {
  return Definition.create({
    name,
    type: modelType.normalized,
    methods: { run: { arguments: { value: "routed" } } },
  });
}

async function executeStep(
  tempDir: string,
  catalogStore: CatalogStore,
  modelName: string,
  datastoreResolver?: DefaultDatastorePathResolver,
): Promise<void> {
  const step = Step.create({
    name: "step",
    task: StepTask.model(modelName, "run"),
  });
  await new DefaultStepExecutor().execute(step, {
    workflowId: createWorkflowId(crypto.randomUUID()),
    workflowRunId: crypto.randomUUID(),
    workflowName: "wf",
    jobName: "job",
    stepName: "step",
    repoDir: tempDir,
    signal: new AbortController().signal,
    step,
    catalogStore,
    datastoreResolver,
    authoredExpressions: new Set(),
  });
}

Deno.test("DefaultStepExecutor: writes outputs and evaluated definitions through the datastore resolver (swamp-club#2381)", async () => {
  const received: unknown[] = [];
  const modelType = await registerRecordingModel(received);
  await withTempDir(async (tempDir) => {
    const datastoreDir = join(tempDir, "external-ds");
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      await new YamlDefinitionRepository(tempDir).save(
        modelType,
        recordingDefinition("routed", modelType),
      );
      await executeStep(
        tempDir,
        catalogStore,
        "routed",
        externalDatastore(tempDir, datastoreDir),
      );
    } finally {
      catalogStore.close();
    }

    assertEquals(received, [{ value: "routed" }]);
    const outputs = await listFiles(join(datastoreDir, "outputs"));
    assertEquals(
      outputs.filter((f) => f.endsWith(".yaml")).length,
      1,
      JSON.stringify(outputs),
    );
    assertEquals(
      (await listFiles(join(datastoreDir, "definitions-evaluated"))).length,
      1,
    );
    for (const subdir of ["outputs", "definitions-evaluated"]) {
      assertEquals(
        (await listFiles(join(tempDir, ".swamp", subdir)))
          .filter((f) => f.endsWith(".yaml")),
        [],
        `${subdir} leaked into the repo-local .swamp`,
      );
    }
  });
});

Deno.test("DefaultStepExecutor: finds a definition that exists only in the datastore's auto-definitions (swamp-club#2381)", async () => {
  const received: unknown[] = [];
  const modelType = await registerRecordingModel(received);
  await withTempDir(async (tempDir) => {
    const resolver = externalDatastore(tempDir, join(tempDir, "external-ds"));
    // Saved the way direct type execution saves an auto-definition.
    await new YamlDefinitionRepository(
      tempDir,
      undefined,
      resolver.resolvePath("auto-definitions"),
      false,
    ).save(modelType, recordingDefinition("auto-routed", modelType));
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      await executeStep(tempDir, catalogStore, "auto-routed", resolver);
    } finally {
      catalogStore.close();
    }
    assertEquals(received, [{ value: "routed" }]);
  });
});

Deno.test("DefaultStepExecutor: keeps outputs and evaluated definitions repo-local without a datastore resolver", async () => {
  const received: unknown[] = [];
  const modelType = await registerRecordingModel(received);
  await withTempDir(async (tempDir) => {
    const catalogStore = new CatalogStore(join(tempDir, "_catalog.db"));
    try {
      await new YamlDefinitionRepository(tempDir).save(
        modelType,
        recordingDefinition("local", modelType),
      );
      await executeStep(tempDir, catalogStore, "local");
    } finally {
      catalogStore.close();
    }
    assertEquals(received, [{ value: "routed" }]);
    assertEquals(
      (await listFiles(join(tempDir, ".swamp", "outputs")))
        .filter((f) => f.endsWith(".yaml")).length,
      1,
    );
    assertEquals(
      (await listFiles(join(tempDir, ".swamp", "definitions-evaluated")))
        .length,
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Resume against a changed workflow (swamp-club#2433)
// ---------------------------------------------------------------------------

type ResumeOptions = Parameters<WorkflowExecutionService["resume"]>[2];

interface JobShape {
  name: string;
  steps: Step[];
  dependsOn?: string[];
  condition?: TriggerCondition;
}

/** A workflow named "changed-wf" with the given id, or a fresh one. */
function shapedWorkflow(jobs: JobShape[], id?: WorkflowId): Workflow {
  return Workflow.create({
    id,
    name: "changed-wf",
    jobs: jobs.map((j) =>
      Job.create({
        name: j.name,
        steps: j.steps,
        dependsOn: (j.dependsOn ?? []).map((job) => ({
          job,
          condition: j.condition ?? TriggerCondition.succeeded(),
        })),
      })
    ),
  });
}

function eachStep(
  name: string,
  collection: string,
  opts: { dependsOn?: string[]; allowFailure?: boolean } = {},
): Step {
  return Step.create({
    name,
    task: StepTask.model("test-model", "run"),
    forEach: { item: "env", in: collection },
    allowFailure: opts.allowFailure,
    dependsOn: (opts.dependsOn ?? []).map((dep) => ({
      step: dep,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

function dependentStep(name: string, dependsOn: string[]): Step {
  return modelStep(name, {
    dependsOn: dependsOn.map((step) => ({
      step,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

/**
 * Fails a run of `before` at `failing`, saves `after` in its place, and
 * asserts that resuming refuses with `message` without saving the run or
 * calling a step.
 */
async function assertResumeRefused(
  tempDir: string,
  before: Workflow,
  failing: string[],
  after: JobShape[],
  options: ResumeOptions,
  message: string,
): Promise<void> {
  const { workflowRepo, runRepo, executor, service } = await setupRetry(
    tempDir,
    before,
  );
  for (const step of failing) executor.failing.add(step);
  const failed = await service.execute(before.name);
  assertEquals(failed.status, "failed");
  await workflowRepo.save(shapedWorkflow(after, before.id));
  const stored = JSON.stringify(
    (await runRepo.findById(before.id, failed.id))!.toData(),
  );
  const saves = runRepo.saves;
  const calls = [...executor.calls.values()].reduce((a, b) => a + b, 0);

  const error = await assertRejects(
    () => drainResume(service, before.name, failed.id, options),
    UserError,
    message,
  );
  assertStringIncludes(error.message, "Start a new run.");

  assertEquals(runRepo.saves, saves);
  assertEquals(
    JSON.stringify((await runRepo.findById(before.id, failed.id))!.toData()),
    stored,
  );
  assertEquals(
    [...executor.calls.values()].reduce((a, b) => a + b, 0),
    calls,
  );
}

/** build: compile → test; release (depends on build): publish. */
function buildRelease(): Workflow {
  return shapedWorkflow([
    {
      name: "build",
      steps: [modelStep("compile"), dependentStep("test", ["compile"])],
    },
    { name: "release", steps: [modelStep("publish")], dependsOn: ["build"] },
  ]);
}

Deno.test("resume: --from refuses a step moved to a job nothing re-enters, instead of a false success", async () => {
  await withTempDir(async (tempDir) => {
    await assertResumeRefused(
      tempDir,
      buildRelease(),
      ["test"],
      [
        { name: "build", steps: [modelStep("compile")] },
        {
          name: "release",
          steps: [modelStep("publish"), modelStep("test")],
          dependsOn: ["build"],
        },
      ],
      {
        fromStep: "test",
      },
      `Step "test" is in job "build" in the run, job "release" in the workflow.`,
    );
  });
});

Deno.test("resume: --from refuses a step moved next to a dependent, instead of crashing mid-run", async () => {
  await withTempDir(async (tempDir) => {
    await assertResumeRefused(
      tempDir,
      buildRelease(),
      ["test"],
      [
        { name: "build", steps: [modelStep("compile")] },
        {
          name: "release",
          steps: [modelStep("test"), dependentStep("publish", ["test"])],
          dependsOn: ["build"],
        },
      ],
      {
        fromStep: "test",
      },
      `Step "test" is in job "build" in the run, job "release" in the workflow.`,
    );
  });
});

/** main: a → b → c. */
function chain(): Workflow {
  return shapedWorkflow([{
    name: "main",
    steps: [
      modelStep("a"),
      dependentStep("b", ["a"]),
      dependentStep("c", ["b"]),
    ],
  }]);
}

Deno.test("resume: --from refuses a renamed step", async () => {
  await withTempDir(async (tempDir) => {
    await assertResumeRefused(
      tempDir,
      chain(),
      ["b"],
      [{
        name: "main",
        steps: [
          modelStep("a"),
          dependentStep("b2", ["a"]),
          dependentStep("c", ["b2"]),
        ],
      }],
      { fromStep: "b2" },
      `Step "b2" in job "main" is not in the run.`,
    );
  });
});

Deno.test("resume: a retry refuses a step added to a job it re-enters", async () => {
  await withTempDir(async (tempDir) => {
    await assertResumeRefused(
      tempDir,
      chain(),
      ["b"],
      [{
        name: "main",
        steps: [
          modelStep("a"),
          dependentStep("b", ["a"]),
          dependentStep("c", ["b"]),
          modelStep("lint"),
        ],
      }],
      undefined,
      `Step "lint" in job "main" is not in the run.`,
    );
  });
});

Deno.test("resume: a retry refuses a renamed dependent of the failed step", async () => {
  await withTempDir(async (tempDir) => {
    await assertResumeRefused(
      tempDir,
      chain(),
      ["b"],
      [{
        name: "main",
        steps: [
          modelStep("a"),
          dependentStep("b", ["a"]),
          dependentStep("c2", ["b"]),
        ],
      }],
      undefined,
      `Step "c2" in job "main" is not in the run.`,
    );
  });
});

Deno.test("resume: --from refuses a renamed job instead of resetting the whole run", async () => {
  await withTempDir(async (tempDir) => {
    await assertResumeRefused(
      tempDir,
      buildRelease(),
      ["compile"],
      [
        {
          name: "build2",
          steps: [modelStep("compile"), dependentStep("test", ["compile"])],
        },
        {
          name: "release",
          steps: [modelStep("publish")],
          dependsOn: ["build2"],
        },
      ],
      { fromStep: "compile" },
      `Job "build2" is not in the run.`,
    );
  });
});

Deno.test("resume: --from refuses a step name removed from one job but kept in another", async () => {
  await withTempDir(async (tempDir) => {
    const before = shapedWorkflow([
      { name: "a", steps: [modelStep("x"), modelStep("y")] },
      { name: "b", steps: [modelStep("x")] },
    ]);
    await assertResumeRefused(tempDir, before, ["x"], [
      { name: "a", steps: [modelStep("y")] },
      { name: "b", steps: [modelStep("x")] },
    ], {
      fromStep: "x",
    }, `Step "x" is in job "a" in the run, job "b" in the workflow.`);
  });
});

Deno.test("resume: --from conservatively refuses an added step in a re-entered job its condition would skip", async () => {
  await withTempDir(async (tempDir) => {
    const before = shapedWorkflow([
      { name: "main", steps: [modelStep("b")] },
      {
        name: "on-failure",
        steps: [modelStep("alert")],
        dependsOn: ["main"],
        condition: TriggerCondition.failed(),
      },
    ]);
    await assertResumeRefused(
      tempDir,
      before,
      ["b"],
      [
        { name: "main", steps: [modelStep("b")] },
        {
          name: "on-failure",
          steps: [modelStep("alert"), modelStep("page")],
          dependsOn: ["main"],
          condition: TriggerCondition.failed(),
        },
      ],
      { fromStep: "b" },
      `Step "page" in job "on-failure" is not in the run.`,
    );
  });
});

Deno.test("resume: --from refuses a plain step moved away from a forEach step it shares a prefix with", async () => {
  await withTempDir(async (tempDir) => {
    const collection = '${{ ["a"] }}';
    const before = shapedWorkflow([
      {
        name: "build",
        steps: [
          eachStep("test-${{ self.env }}", collection),
          modelStep(
            "test-unit",
          ),
        ],
      },
      { name: "release", steps: [modelStep("publish")], dependsOn: ["build"] },
    ]);
    await assertResumeRefused(
      tempDir,
      before,
      ["test-unit"],
      [
        {
          name: "build",
          steps: [eachStep("test-${{ self.env }}", collection)],
        },
        {
          name: "release",
          steps: [modelStep("publish"), modelStep("test-unit")],
          dependsOn: ["build"],
        },
      ],
      {
        fromStep: "test-unit",
      },
      `Step "test-unit" is in job "build" in the run, job "release" in the workflow.`,
    );
  });
});

/**
 * Fails a run of `before` at `failing`, saves `after` in its place, then
 * resumes it with nothing failing.
 */
async function resumeChanged(
  tempDir: string,
  before: Workflow,
  failing: string[],
  after: JobShape[] | undefined,
  options: ResumeOptions,
  runInputs?: Record<string, unknown>,
) {
  const harness = await setupRetry(tempDir, before);
  for (const step of failing) harness.executor.failing.add(step);
  const failed = await harness.service.execute(before.name, {
    inputs: runInputs,
  });
  assertEquals(failed.status, "failed");
  if (after) {
    await harness.workflowRepo.save(shapedWorkflow(after, before.id));
  }
  harness.executor.failing.clear();
  const events: WorkflowExecutionEvent[] = [];
  let resumed: WorkflowRun | undefined;
  for await (
    const event of harness.service.resume(before.name, failed.id, options)
  ) {
    events.push(event);
    if (event.kind === "completed") resumed = event.run;
  }
  return { ...harness, failed, resumed: resumed!, events };
}

Deno.test("resume: --from still works after removing a step upstream of it", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed, executor } = await resumeChanged(tempDir, chain(), [
      "b",
    ], [{
      name: "main",
      steps: [modelStep("b"), dependentStep("c", ["b"])],
    }], { fromStep: "b" });
    assertEquals(resumed.status, "succeeded");
    assertEquals(executor.count("main/b"), 2);
    assertEquals(executor.count("main/c"), 1);
  });
});

Deno.test("resume: --from still works after removing a step downstream of it", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed, executor } = await resumeChanged(tempDir, chain(), [
      "b",
    ], [{
      name: "main",
      steps: [modelStep("a"), dependentStep("b", ["a"])],
    }], { fromStep: "b" });
    assertEquals(resumed.status, "succeeded");
    assertEquals(executor.count("main/b"), 2);
  });
});

Deno.test("resume: --from still works after changing a step's body", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed } = await resumeChanged(tempDir, chain(), ["b"], [{
      name: "main",
      steps: [
        modelStep("a"),
        modelStep("b", {
          inputs: { fixed: true },
          dependsOn: [{ step: "a", condition: TriggerCondition.succeeded() }],
        }),
        dependentStep("c", ["b"]),
      ],
    }], { fromStep: "b" });
    assertEquals(resumed.status, "succeeded");
  });
});

Deno.test("resume: --from and retry leave an unchanged forEach and gate run unrefused", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = shapedWorkflow([{
      name: "main",
      steps: [
        Step.create({ name: "gate", task: StepTask.manualApproval("Go?") }),
        eachStep("deploy-${{ self.env }}", "${{ inputs.envs }}", {
          dependsOn: ["gate"],
        }),
      ],
    }]);
    const { runRepo, executor, service } = await setupRetry(
      tempDir,
      workflow,
    );
    executor.failing.add("deploy-b");
    const suspended = await service.execute(workflow.name, {
      inputs: { envs: ["a", "b"] },
    });
    assertEquals(suspended.status, "suspended");
    const gate = suspended.getJob("main")!.getStep("gate")!;
    gate.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    gate.succeed();
    await runRepo.save(workflow.id, suspended);
    const failed = await drainResume(service, workflow.name, suspended.id);
    assertEquals(failed?.status, "failed");

    const retried = await drainResume(service, workflow.name, failed!.id);
    assertEquals(retried?.status, "failed");
    executor.failing.clear();
    const fromTemplate = await drainResume(service, workflow.name, failed!.id, {
      fromStep: "deploy-${{ self.env }}",
    });
    assertEquals(fromTemplate?.status, "succeeded");
    assertEquals(executor.count("main/deploy-b"), 3);
  });
});

Deno.test("resume: --from still works on a run started from an evaluated forEach workflow", async () => {
  await withTempDir(async (tempDir) => {
    const template = "deploy-${{ self.env }}";
    const source = shapedWorkflow([{
      name: "main",
      steps: [
        modelStep("prep"),
        eachStep(template, "${{ inputs.envs }}", { dependsOn: ["prep"] }),
      ],
    }]);
    // What 'workflow evaluate' saves: concrete iterations, no forEach.
    const evaluated = shapedWorkflow([{
      name: "main",
      steps: [modelStep("prep"), dependentStep("deploy-prod", ["prep"])],
    }], source.id);
    const { runRepo, executor, service } = await setupRetry(tempDir, source);
    const { YamlEvaluatedWorkflowRepository } = await import(
      "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts"
    );
    await new YamlEvaluatedWorkflowRepository(tempDir).save(evaluated);
    executor.failing.add("prep");
    const failed = await service.execute(source.name, {
      lastEvaluated: true,
      inputs: { envs: ["prod"] },
    });
    assertEquals(failed.status, "failed");
    const records = failed.getJob("main")!.steps;
    assertEquals(
      records.find((s) => s.stepName === "deploy-prod")
        ?.forEachTemplate,
      undefined,
    );

    executor.failing.clear();
    const resumed = await drainResume(service, source.name, failed.id, {
      fromStep: "prep",
    });
    assertEquals(resumed?.status, "succeeded");
    assertEquals(executor.count("main/prep"), 2);
    assertExists(await runRepo.findById(source.id, failed.id));
  });
});

/** main: deploy iterations over a literal collection; deploy-b fails first. */
function deployOver(collection: string): JobShape[] {
  return [{
    name: "main",
    steps: [eachStep("deploy-${{ self.env }}", collection)],
  }];
}

function assertStranded(run: WorkflowRun, stepName: string): void {
  const step = run.getJob("main")!.getStep(stepName)!;
  assertEquals(step.status, "failed");
  assertEquals(step.failureKind, "workflow_changed");
  assertEquals(step.error, STRANDED_STEP_ERROR);
  assertEquals(step.allowedFailure, false);
}

Deno.test("resume: --from over a smaller forEach collection fails the dropped iteration", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed, events, executor } = await resumeChanged(
      tempDir,
      shapedWorkflow(deployOver('${{ ["a", "b"] }}')),
      ["deploy-b"],
      deployOver('${{ ["a"] }}'),
      { fromStep: "deploy-${{ self.env }}" },
    );
    assertEquals(resumed.status, "failed");
    assertEquals(resumed.getJob("main")!.status, "failed");
    assertEquals(executor.count("main/deploy-b"), 1);
    assertStranded(resumed, "deploy-b");
    assertEquals(
      resumed.getJob("main")!.getStep("deploy-a")!.status,
      "succeeded",
    );
    assertEquals(resumed.toData().failedStep, "deploy-b");
    assertEquals(resumed.toData().failureReason, STRANDED_STEP_ERROR);
    const stranded = events.find((e) =>
      e.kind === "step_failed" && e.stepId === "deploy-b"
    );
    assert(stranded?.kind === "step_failed");
    assertEquals(stranded.forEachTemplate, "deploy-${{ self.env }}");
    assertEquals(stranded.modelName, undefined);
    assertEquals(stranded.methodName, undefined);
  });
});

Deno.test("resume: a stranded iteration fails even when its forEach step allows failure", async () => {
  await withTempDir(async (tempDir) => {
    const shape = (collection: string): JobShape[] => [{
      name: "main",
      steps: [
        eachStep("deploy-${{ self.env }}", collection, { allowFailure: true }),
        modelStep("check", {
          dependsOn: [{
            step: "deploy-${{ self.env }}",
            condition: TriggerCondition.completed(),
          }],
        }),
      ],
    }];
    const { resumed } = await resumeChanged(
      tempDir,
      shapedWorkflow(shape('${{ ["a", "b"] }}')),
      ["deploy-b", "check"],
      shape('${{ ["a"] }}'),
      { fromStep: "deploy-${{ self.env }}" },
    );
    assertStranded(resumed, "deploy-b");
    assertEquals(resumed.status, "failed");
  });
});

Deno.test("resume: a retry with an --input that narrows a forEach collection fails the dropped iteration", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed, executor } = await resumeChanged(
      tempDir,
      shapedWorkflow(deployOver("${{ inputs.envs }}")),
      ["deploy-b"],
      undefined,
      { inputs: { envs: ["a"] } },
      { envs: ["a", "b"] },
    );
    assertEquals(resumed.status, "failed");
    assertEquals(executor.count("main/deploy-a"), 2);
    assertStranded(resumed, "deploy-b");
  });
});

Deno.test("resume: a retry with an --input that renames iterations fails the old ones", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed, executor } = await resumeChanged(
      tempDir,
      shapedWorkflow(deployOver("${{ inputs.envs }}")),
      ["deploy-b"],
      undefined,
      { inputs: { envs: ["x", "y"] } },
      { envs: ["a", "b"] },
    );
    assertEquals(resumed.status, "failed");
    assertEquals(executor.count("main/deploy-x"), 1);
    assertEquals(executor.count("main/deploy-y"), 1);
    assertStranded(resumed, "deploy-a");
    assertStranded(resumed, "deploy-b");
  });
});

Deno.test("resume: a retry of a run with a stranded step is refused, and --from clears the failure kind", async () => {
  await withTempDir(async (tempDir) => {
    const { resumed, service, workflowRepo } = await resumeChanged(
      tempDir,
      shapedWorkflow(deployOver('${{ ["a", "b"] }}')),
      ["deploy-b"],
      deployOver('${{ ["a"] }}'),
      { fromStep: "deploy-${{ self.env }}" },
    );
    await assertRejects(
      () => drainResume(service, "changed-wf", resumed.id),
      UserError,
      `Step "deploy-\${{ self.env }}" in job "main" did not run: the workflow or a forEach collection changed. Start a new run.`,
    );

    // Restoring the collection and re-entering at the template runs it.
    const restored = shapedWorkflow(
      deployOver('${{ ["a", "b"] }}'),
      resumed.workflowId as WorkflowId,
    );
    await workflowRepo.save(restored);
    const again = await drainResume(service, "changed-wf", resumed.id, {
      fromStep: "deploy-${{ self.env }}",
    });
    assertEquals(again?.status, "succeeded");
    const deployB = again!.getJob("main")!.getStep("deploy-b")!;
    assertEquals(deployB.status, "succeeded");
    assertEquals(deployB.failureKind, undefined);
  });
});

Deno.test("resume: a --from that suspends again still fails an iteration its reset stranded", async () => {
  await withTempDir(async (tempDir) => {
    const shape = (collection: string): JobShape[] => [{
      name: "main",
      steps: [
        Step.create({ name: "gate", task: StepTask.manualApproval("Go?") }),
        eachStep("deploy-${{ self.env }}", collection, {
          dependsOn: ["gate"],
        }),
      ],
    }];
    const before = shapedWorkflow(shape('${{ ["a", "b"] }}'));
    const { workflowRepo, runRepo, service } = await setupRetry(
      tempDir,
      before,
    );
    const suspended = await service.execute(before.name);
    assertEquals(suspended.status, "suspended");
    // Reject the gate, as 'workflow reject' does.
    const gate = suspended.getJob("main")!.getStep("gate")!;
    gate.recordApprovalDecision({
      approved: false,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    gate.fail("Approval rejected");
    suspended.getJob("main")!.fail();
    suspended.complete();
    await runRepo.save(before.id, suspended);

    await workflowRepo.save(
      shapedWorkflow(shape('${{ ["a"] }}'), before.id),
    );
    const asksAgain = await drainResume(service, before.name, suspended.id, {
      fromStep: "gate",
    });
    assertEquals(asksAgain, undefined);
    const waiting = (await runRepo.findById(before.id, suspended.id))!;
    assertEquals(waiting.status, "suspended");
    const regate = waiting.getJob("main")!.getStep("gate")!;
    regate.recordApprovalDecision({
      approved: true,
      decidedBy: "user:test",
      decidedAt: new Date().toISOString(),
    });
    regate.succeed();
    await runRepo.save(before.id, waiting);

    const resumed = await drainResume(service, before.name, suspended.id);
    assertEquals(resumed?.status, "failed");
    assertStranded(resumed!, "deploy-b");
    assertEquals(
      resumed!.getJob("main")!.getStep("deploy-a")!.status,
      "succeeded",
    );
  });
});

Deno.test("resume: --from still works in a job whose name is written with an input expression", async () => {
  await withTempDir(async (tempDir) => {
    const workflow = shapedWorkflow([{
      name: "deploy-${{ inputs.env }}",
      steps: [modelStep("a"), dependentStep("b", ["a"])],
    }]);
    const { executor, service } = await setupRetry(tempDir, workflow);
    executor.failing.add("b");
    const failed = await service.execute(workflow.name, {
      inputs: { env: "prod" },
    });
    assertEquals(failed.status, "failed");
    assertEquals(failed.jobs.map((j) => j.jobName), ["deploy-prod"]);

    executor.failing.clear();
    const resumed = await drainResume(service, workflow.name, failed.id, {
      fromStep: "b",
    });
    assertEquals(resumed?.status, "succeeded");
    assertEquals(executor.count("deploy-prod/b"), 2);
  });
});

// ---------------------------------------------------------------------------
// Resume a suspended run against a changed workflow (swamp-club#2498)
// ---------------------------------------------------------------------------

/**
 * main: prep → gate → deploy → notify; post (depends on main): announce. The
 * shape of the swamp-club#2498 reproduction.
 */
function gatedJobs(post: Step[] = [modelStep("announce")]): JobShape[] {
  return [
    {
      name: "main",
      steps: [
        modelStep("prep"),
        Step.create({
          name: "gate",
          task: StepTask.manualApproval("Approve deploy?"),
          dependsOn: [{
            step: "prep",
            condition: TriggerCondition.succeeded(),
          }],
        }),
        dependentStep("deploy", ["gate"]),
        dependentStep("notify", ["deploy"]),
      ],
    },
    { name: "post", steps: post, dependsOn: ["main"] },
  ];
}

/**
 * Runs `before` until it suspends at the gate in job main, approves the gate,
 * and saves `after` in the workflow's place.
 */
async function suspendThenEdit(
  tempDir: string,
  before: Workflow,
  after: JobShape[],
  inputs?: Record<string, unknown>,
) {
  const { workflowRepo, runRepo, executor, service } = await setupRetry(
    tempDir,
    before,
  );
  const suspended = await service.execute(before.name, { inputs });
  assertEquals(suspended.status, "suspended");
  const gate = suspended.getJob("main")!.getStep("gate")!;
  gate.recordApprovalDecision({
    approved: true,
    decidedBy: "user:test",
    decidedAt: new Date().toISOString(),
  });
  gate.succeed();
  await runRepo.save(before.id, suspended);
  await workflowRepo.save(shapedWorkflow(after, before.id));
  return { runRepo, executor, service, run: suspended };
}

/**
 * Suspends a run of {@link gatedJobs}, saves `after`, and asserts that
 * resuming refuses with `message` without saving the run or calling a step.
 */
async function assertSuspendedResumeRefused(
  tempDir: string,
  after: JobShape[],
  message: string,
): Promise<void> {
  const before = shapedWorkflow(gatedJobs());
  const { runRepo, executor, service, run } = await suspendThenEdit(
    tempDir,
    before,
    after,
  );
  const stored = JSON.stringify(
    (await runRepo.findById(before.id, run.id))!.toData(),
  );
  const saves = runRepo.saves;
  const calls = [...executor.calls.values()].reduce((a, b) => a + b, 0);

  const error = await assertRejects(
    () => drainResume(service, before.name, run.id),
    UserError,
    message,
  );
  assertStringIncludes(
    error.message,
    `To cancel: 'swamp workflow cancel changed-wf --run ${run.id}'.`,
  );

  assertEquals(runRepo.saves, saves);
  const after_ = (await runRepo.findById(before.id, run.id))!;
  assertEquals(JSON.stringify(after_.toData()), stored);
  assertEquals(after_.status, "suspended");
  assertEquals(
    [...executor.calls.values()].reduce((a, b) => a + b, 0),
    calls,
  );
}

Deno.test("resume: refuses a suspended run with a step added to the gate's job, instead of crashing mid-run", async () => {
  await withTempDir(async (tempDir) => {
    const [main, post] = gatedJobs();
    await assertSuspendedResumeRefused(
      tempDir,
      [
        { ...main, steps: [...main.steps, dependentStep("lint", ["gate"])] },
        post,
      ],
      `Step "lint" in job "main" is not in the run.`,
    );
  });
});

Deno.test("resume: refuses a suspended run with a pending step moved to another job, before running anything", async () => {
  await withTempDir(async (tempDir) => {
    const [main, post] = gatedJobs();
    await assertSuspendedResumeRefused(
      tempDir,
      [
        { ...main, steps: main.steps.slice(0, 3) },
        { ...post, steps: [...post.steps, modelStep("notify")] },
      ],
      `Step "notify" is in job "main" in the run, job "post" in the workflow.`,
    );
  });
});

Deno.test("resume: refuses a suspended run with an added job, instead of reporting success", async () => {
  await withTempDir(async (tempDir) => {
    await assertSuspendedResumeRefused(
      tempDir,
      [
        ...gatedJobs(),
        { name: "extra", steps: [modelStep("audit")], dependsOn: ["main"] },
      ],
      `Job "extra" is not in the run.`,
    );
  });
});

Deno.test("resume: a suspended run still resumes after a pending step is removed", async () => {
  await withTempDir(async (tempDir) => {
    const before = shapedWorkflow(gatedJobs());
    const [main, post] = gatedJobs();
    const { executor, service, run } = await suspendThenEdit(
      tempDir,
      before,
      [{ ...main, steps: main.steps.slice(0, 3) }, post],
    );
    const resumed = await drainResume(service, before.name, run.id);
    assertEquals(resumed?.status, "succeeded");
    assertEquals(executor.count("main/deploy"), 1);
    assertEquals(executor.count("post/announce"), 1);
    // The removed step's record stays pending, as before.
    assertEquals(
      resumed!.getJob("main")!.getStep("notify")!.status,
      "pending",
    );
  });
});

Deno.test("resume: a suspended run still resumes after a step is removed from one job but kept in another", async () => {
  await withTempDir(async (tempDir) => {
    const before = shapedWorkflow(
      gatedJobs([modelStep("announce"), modelStep("notify")]),
    );
    const [main, post] = gatedJobs([
      modelStep("announce"),
      modelStep("notify"),
    ]);
    const { executor, service, run } = await suspendThenEdit(
      tempDir,
      before,
      [{ ...main, steps: main.steps.slice(0, 3) }, post],
    );
    const resumed = await drainResume(service, before.name, run.id);
    assertEquals(resumed?.status, "succeeded");
    assertEquals(executor.count("main/notify"), 0);
    assertEquals(executor.count("post/notify"), 1);
  });
});

Deno.test("resume: a forEach narrowed through --input on a suspended resume still succeeds", async () => {
  await withTempDir(async (tempDir) => {
    const shape: JobShape[] = [{
      name: "main",
      steps: [
        Step.create({ name: "gate", task: StepTask.manualApproval("Go?") }),
        eachStep("deploy-${{ self.env }}", "${{ inputs.envs }}", {
          dependsOn: ["gate"],
        }),
      ],
    }];
    const workflow = shapedWorkflow(shape);
    const { executor, service, run } = await suspendThenEdit(
      tempDir,
      workflow,
      shape,
      { envs: ["a", "b"] },
    );
    const resumed = await drainResume(service, workflow.name, run.id, {
      inputs: { envs: ["a"] },
    });
    assertEquals(resumed?.status, "succeeded");
    assertEquals(executor.count("main/deploy-a"), 1);
    assertEquals(executor.count("main/deploy-b"), 0);
    // The iteration the smaller collection drops stays pending, as before.
    assertEquals(
      resumed!.getJob("main")!.getStep("deploy-b")!.status,
      "pending",
    );
  });
});

Deno.test("resume: refuses a recovered run with no run plan whose workflow changed shape, and leaves it suspended", async () => {
  await withTempDir(async (tempDir) => {
    // A run started with --last-evaluated records no run plan, so recovery's
    // fingerprint check cannot refuse a changed definition. The resume that
    // 'workflow recover' prints refuses instead, once the run is suspended
    // and can be cancelled.
    const before = shapedWorkflow(gatedJobs());
    const { workflowRepo, runRepo, executor, service } = await setupRetry(
      tempDir,
      before,
    );
    const interrupted = WorkflowRun.fromData({
      id: crypto.randomUUID(),
      workflowId: before.id,
      workflowName: before.name,
      status: "interrupted",
      jobs: [
        {
          jobName: "main",
          status: "unknown",
          steps: [
            { stepName: "prep", status: "succeeded" },
            { stepName: "gate", status: "succeeded" },
            { stepName: "deploy", status: "unknown" },
            { stepName: "notify", status: "pending" },
          ],
        },
        {
          jobName: "post",
          status: "pending",
          steps: [{ stepName: "announce", status: "pending" }],
        },
      ],
    });
    const [main, post] = gatedJobs();
    const edited = shapedWorkflow(
      [
        { ...main, steps: [...main.steps, dependentStep("lint", ["gate"])] },
        post,
      ],
      before.id,
    );
    await workflowRepo.save(edited);
    assertEquals(
      (await assessRecoveryForRun(edited, interrupted)).fingerprintMismatch,
      false,
    );
    // What 'swamp workflow recover' does before printing the resume command.
    interrupted.resetUnknownStepsForRecovery();
    await runRepo.save(before.id, interrupted);

    const error = await assertRejects(
      () => drainResume(service, before.name, interrupted.id),
      UserError,
      `Step "lint" in job "main" is not in the run.`,
    );
    assertStringIncludes(error.message, "swamp workflow cancel changed-wf");
    assertEquals(
      (await runRepo.findById(before.id, interrupted.id))!.status,
      "suspended",
    );
    assertEquals(executor.calls.size, 0);
  });
});
