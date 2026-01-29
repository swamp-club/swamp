import { assertEquals, assertNotEquals } from "@std/assert";
import {
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
            task: StepTask.shell("echo", { args: ["hello"] }),
          }),
        ],
      }),
    ],
  });
}

Deno.test("executes simple workflow with one job and one step", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new MockStepExecutor();

  const workflow = createSimpleWorkflow();
  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  assertEquals(run.status, "succeeded");
  assertEquals(run.getJob("job1")?.status, "succeeded");
  assertEquals(run.getJob("job1")?.getStep("step1")?.status, "succeeded");
  assertEquals(executor.executedSteps, ["job1/step1"]);
});

Deno.test("executes workflow with multiple jobs", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new MockStepExecutor();

  const workflow = Workflow.create({
    name: "multi-job",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({ name: "compile", task: StepTask.shell("echo") }),
        ],
      }),
      Job.create({
        name: "test",
        steps: [
          Step.create({ name: "unit", task: StepTask.shell("echo") }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded("build") },
        ],
      }),
    ],
  });

  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  assertEquals(run.status, "succeeded");
  assertEquals(executor.executedSteps, ["build/compile", "test/unit"]);
});

Deno.test("executes workflow with step dependencies", async () => {
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
            task: StepTask.shell("echo"),
          }),
          Step.create({
            name: "compile",
            task: StepTask.shell("echo"),
            dependsOn: [
              { step: "setup", condition: TriggerCondition.succeeded("setup") },
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
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  assertEquals(run.status, "succeeded");
  // Setup must run before compile
  const setupIdx = executor.executedSteps.indexOf("build/setup");
  const compileIdx = executor.executedSteps.indexOf("build/compile");
  assertEquals(setupIdx < compileIdx, true);
});

Deno.test("marks workflow as failed when step fails", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new MockStepExecutor();
  executor.shouldFail.add("step1");

  const workflow = createSimpleWorkflow();
  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  assertEquals(run.status, "failed");
  assertEquals(run.getJob("job1")?.status, "failed");
  assertEquals(run.getJob("job1")?.getStep("step1")?.status, "failed");
  assertNotEquals(run.getJob("job1")?.getStep("step1")?.error, undefined);
});

Deno.test("skips job when trigger condition not met", async () => {
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
          Step.create({ name: "compile", task: StepTask.shell("echo") }),
        ],
      }),
      Job.create({
        name: "test",
        steps: [
          Step.create({ name: "unit", task: StepTask.shell("echo") }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.succeeded("build") },
        ],
      }),
    ],
  });

  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  assertEquals(run.status, "failed");
  assertEquals(run.getJob("build")?.status, "failed");
  assertEquals(run.getJob("test")?.status, "skipped");
});

Deno.test("runs job on failure condition", async () => {
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
          Step.create({ name: "compile", task: StepTask.shell("echo") }),
        ],
      }),
      Job.create({
        name: "notify",
        steps: [
          Step.create({ name: "alert", task: StepTask.shell("echo") }),
        ],
        dependsOn: [
          { job: "build", condition: TriggerCondition.failed("build") },
        ],
      }),
    ],
  });

  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  assertEquals(run.getJob("build")?.status, "failed");
  assertEquals(run.getJob("notify")?.status, "succeeded");
  assertEquals(executor.executedSteps.includes("notify/alert"), true);
});

Deno.test("throws error for nonexistent workflow", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
  );

  try {
    await service.execute("nonexistent");
    throw new Error("Expected error");
  } catch (error) {
    assertEquals((error as Error).message.includes("not found"), true);
  }
});

Deno.test("saves workflow run to repository", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new MockStepExecutor();

  const workflow = createSimpleWorkflow();
  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
    executor,
  );

  const run = await service.execute(workflow.name);

  const savedRuns = await runRepo.findAllByWorkflowId(workflow.id);
  assertEquals(savedRuns.length >= 1, true);
  assertEquals(savedRuns[savedRuns.length - 1].id, run.id);
});

Deno.test("calls progress callbacks during execution", async () => {
  const workflowRepo = new InMemoryWorkflowRepository();
  const runRepo = new InMemoryWorkflowRunRepository();
  const executor = new MockStepExecutor();

  const workflow = createSimpleWorkflow();
  await workflowRepo.save(workflow);

  const service = new WorkflowExecutionService(
    workflowRepo,
    runRepo,
    ".",
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
