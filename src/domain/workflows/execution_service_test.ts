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

Deno.test("run() yields lifecycle events during execution", async () => {
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
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

Deno.test("DefaultStepExecutor rejects workflow task type", async () => {
  const executor = new DefaultStepExecutor();

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
    signal: new AbortController().signal,
  };

  await assertRejects(
    () => executor.execute(step, ctx),
    Error,
    "Unsupported task type for step executor",
  );
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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
Deno.test("useLastEvaluated context carries task.inputs and expressionContext (Bug B)", async () => {
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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

    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      tempDir,
      executor,
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
