import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  DefaultStepExecutor,
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "./execution_service.ts";
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
import type { WorkflowRun } from "./workflow_run.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Mock step executor for testing.
 */
class MockStepExecutor implements StepExecutor {
  executedSteps: string[] = [];
  shouldFail: Set<string> = new Set();

  execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.executedSteps.push(`${ctx.jobName}/${ctx.stepName}`);

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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const run = await service.execute(workflow.name);

    const savedRuns = await runRepo.findAllByWorkflowId(workflow.id);
    assertEquals(savedRuns.length >= 1, true);
    assertEquals(savedRuns[savedRuns.length - 1].id, run.id);
  });
});

Deno.test("calls progress callbacks during execution", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new MockStepExecutor();

    const workflow = createSimpleWorkflow();
    await workflowRepo.save(workflow);

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const events: string[] = [];

    await service.execute(workflow.name, {
      onWorkflowStart: () => events.push("workflow-start"),
      onJobStart: (_, jobName) => events.push(`job-start:${jobName}`),
      onStepStart: (_, jobName, stepName) =>
        events.push(`step-start:${jobName}/${stepName}`),
      onStepComplete: (_, jobName, stepName) =>
        events.push(`step-complete:${jobName}/${stepName}`),
      onJobComplete: (_, jobName) => events.push(`job-complete:${jobName}`),
      onWorkflowComplete: () => events.push("workflow-complete"),
    });

    assertEquals(events.includes("workflow-start"), true);
    assertEquals(events.includes("job-start:job1"), true);
    assertEquals(events.includes("step-start:job1/step1"), true);
    assertEquals(events.includes("step-complete:job1/step1"), true);
    assertEquals(events.includes("job-complete:job1"), true);
    assertEquals(events.includes("workflow-complete"), true);
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const startTime = Date.now();
    const run = await service.execute(workflow.name);
    const elapsed = Date.now() - startTime;

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 3);

    // Verify jobs ran in parallel: max concurrency should be 3
    assertEquals(executor.getMaxConcurrency(), 3);

    // If running sequentially, it would take ~150ms (3 * 50ms)
    // Running in parallel should take ~50-100ms
    // Allow generous margin but should be less than sequential time
    assertEquals(
      elapsed < 140,
      true,
      `Expected parallel execution to be faster than 140ms, got ${elapsed}ms`,
    );
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const events: string[] = [];
    const run = await service.execute(workflow.name, {
      onJobStart: (_, jobName) => events.push(`start:${jobName}`),
      onJobComplete: (_, jobName) => events.push(`complete:${jobName}`),
    });

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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const startTime = Date.now();
    const run = await service.execute(workflow.name);
    const elapsed = Date.now() - startTime;

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps.length, 3);

    // Verify steps ran in parallel: max concurrency should be 3
    assertEquals(executor.getMaxConcurrency(), 3);

    // If running sequentially, it would take ~150ms (3 * 50ms)
    // Running in parallel should take ~50-100ms
    assertEquals(
      elapsed < 140,
      true,
      `Expected parallel execution to be faster than 140ms, got ${elapsed}ms`,
    );
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
    resourceId?: string;
    resourceAttributes?: Record<string, unknown>;
    dataId?: string;
    dataAttributes?: Record<string, unknown>;
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
        resourceId: "",
        resourcePath: "",
        resourceAttributes: {},
        dataId: "",
        dataAttributes: {},
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

    // Configure step1 to produce data that step2 should be able to see
    executor.stepOutputs.set("step1", {
      model: "auth-model",
      dataId: "auth-data-123",
      dataAttributes: { token: "secret-token", expiresAt: "2024-01-01" },
    });

    // step2 depends on step1, should see the data written by step1
    executor.stepOutputs.set("step2", {
      model: "list-model",
      resourceId: "list-resource-456",
      resourceAttributes: { items: ["a", "b", "c"] },
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");
    assertEquals(executor.executedSteps, ["job1/step1", "job1/step2"]);

    // Verify step2 saw the data context updated from step1
    const step2Context = executor.capturedContexts.get("step2");
    const authModelData = step2Context?.["auth-model"] as {
      data?: { id: string; name: string; attributes: Record<string, unknown> };
    };

    // The data should be available in the context when step2 runs
    // Single artifact is unwrapped directly as a DataRecord
    assertEquals(authModelData?.data?.id, "auth-data-123");
    assertEquals(authModelData?.data?.attributes?.token, "secret-token");
    assertEquals(authModelData?.data?.attributes?.expiresAt, "2024-01-01");
  });
});

Deno.test("updates both resource and data context when step produces both", async () => {
  await withTempDir(async (tempDir) => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const runRepo = new InMemoryWorkflowRunRepository();
    const executor = new ModelMethodMockExecutor();

    // Configure step1 to produce both resource and data
    executor.stepOutputs.set("step1", {
      model: "sync-model",
      resourceId: "resource-123",
      resourceAttributes: { status: "synced" },
      dataId: "data-456",
      dataAttributes: { lastSyncTime: "2024-01-01T00:00:00Z" },
    });

    executor.stepOutputs.set("step2", {
      model: "report-model",
    });

    const workflow = Workflow.create({
      name: "resource-and-data-context",
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    const run = await service.execute(workflow.name);

    assertEquals(run.status, "succeeded");

    // Verify step2 saw both resource and data context from step1
    const step2Context = executor.capturedContexts.get("step2");
    const syncModelData = step2Context?.["sync-model"] as {
      resource?: { id: string; attributes: Record<string, unknown> };
      data?: { id: string; name: string; attributes: Record<string, unknown> };
    };

    // Resource should be in context
    assertEquals(syncModelData?.resource?.id, "resource-123");
    assertEquals(syncModelData?.resource?.attributes?.status, "synced");

    // Data should also be in context (single artifact unwrapped as DataRecord)
    assertEquals(syncModelData?.data?.id, "data-456");
    assertEquals(
      syncModelData?.data?.attributes?.lastSyncTime,
      "2024-01-01T00:00:00Z",
    );
  });
});

// --- Workflow nesting and cycle detection tests ---

Deno.test("DefaultStepExecutor rejects workflow task when nesting depth exceeded", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new DefaultStepExecutor(workflowRepo, runRepo, "/tmp");

  const step = Step.create({
    name: "nested-step",
    task: StepTask.workflow("child-workflow"),
  });

  const ctx: StepExecutionContext = {
    workflowId: createWorkflowId("parent-id"),
    workflowRunId: "run-123",
    workflowName: "parent-workflow",
    jobName: "job1",
    stepName: "nested-step",
    repoDir: "/tmp",
    workflowNestingDepth: 10, // At the limit
  };

  await assertRejects(
    () => executor.execute(step, ctx),
    Error,
    "Maximum workflow nesting depth (10) exceeded",
  );
});

Deno.test("DefaultStepExecutor allows workflow task at depth below limit", async () => {
  // Depth 9 should pass the nesting check (limit is 10).
  // It will fail later because the child workflow doesn't exist, but the
  // error message should NOT be about nesting depth.
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new DefaultStepExecutor(workflowRepo, runRepo, "/tmp");

  const step = Step.create({
    name: "nested-step",
    task: StepTask.workflow("nonexistent-child"),
  });

  const ctx: StepExecutionContext = {
    workflowId: createWorkflowId("parent-id"),
    workflowRunId: "run-123",
    workflowName: "parent-workflow",
    jobName: "job1",
    stepName: "nested-step",
    repoDir: "/tmp",
    workflowNestingDepth: 9,
  };

  // Should pass depth check but fail on workflow lookup
  const error = await assertRejects(
    () => executor.execute(step, ctx),
    Error,
  );
  // Verify it's NOT a nesting depth error
  assertEquals(
    (error as Error).message.includes("nesting depth"),
    false,
  );
});

Deno.test("DefaultStepExecutor rejects workflow task on direct cycle", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new DefaultStepExecutor(workflowRepo, runRepo, "/tmp");

  const step = Step.create({
    name: "recursive-step",
    task: StepTask.workflow("parent-workflow"),
  });

  const ctx: StepExecutionContext = {
    workflowId: createWorkflowId("parent-id"),
    workflowRunId: "run-123",
    workflowName: "parent-workflow",
    jobName: "job1",
    stepName: "recursive-step",
    repoDir: "/tmp",
    ancestorWorkflowIds: new Set(["parent-workflow"]),
  };

  await assertRejects(
    () => executor.execute(step, ctx),
    Error,
    "Workflow cycle detected",
  );
});

Deno.test("DefaultStepExecutor rejects workflow task on indirect cycle", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new DefaultStepExecutor(workflowRepo, runRepo, "/tmp");

  const step = Step.create({
    name: "cycle-step",
    task: StepTask.workflow("workflow-a"),
  });

  // Simulates: workflow-a -> workflow-b -> workflow-c trying to call workflow-a
  const ctx: StepExecutionContext = {
    workflowId: createWorkflowId("workflow-c-id"),
    workflowRunId: "run-123",
    workflowName: "workflow-c",
    jobName: "job1",
    stepName: "cycle-step",
    repoDir: "/tmp",
    ancestorWorkflowIds: new Set(["workflow-a", "workflow-b", "workflow-c"]),
  };

  await assertRejects(
    () => executor.execute(step, ctx),
    Error,
    "Workflow cycle detected",
  );
});

Deno.test("DefaultStepExecutor rejects workflow task without repos", async () => {
  const executor = new DefaultStepExecutor(); // No repos

  const step = Step.create({
    name: "nested-step",
    task: StepTask.workflow("child-workflow"),
  });

  const ctx: StepExecutionContext = {
    workflowId: createWorkflowId("parent-id"),
    workflowRunId: "run-123",
    workflowName: "parent-workflow",
    jobName: "job1",
    stepName: "nested-step",
    repoDir: "/tmp",
  };

  await assertRejects(
    () => executor.execute(step, ctx),
    Error,
    "Workflow execution requires workflowRepo, runRepo, and repoDir",
  );
});

Deno.test("nesting context is propagated through WorkflowExecutionService to steps", async () => {
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
    );

    // Execute with nesting context
    const ancestors = new Set(["grandparent-workflow"]);
    await service.execute(workflow.name, undefined, {
      workflowNestingDepth: 3,
      ancestorWorkflowIds: ancestors,
    });

    // Verify the context was propagated to the step executor
    assertEquals(executor.capturedContexts.length, 1);
    assertEquals(executor.capturedContexts[0].workflowNestingDepth, 3);
    assertEquals(
      executor.capturedContexts[0].ancestorWorkflowIds?.has(
        "grandparent-workflow",
      ),
      true,
    );
  });
});
