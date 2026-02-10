import { assertEquals } from "@std/assert";
import { JobRun, StepRun, WorkflowRun } from "./workflow_run.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

function createTestWorkflow(): Workflow {
  return Workflow.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-workflow",
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "step2",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
      Job.create({
        name: "job2",
        steps: [
          Step.create({
            name: "step3",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

// StepRun tests

Deno.test("StepRun.pending creates pending step run", () => {
  const stepRun = StepRun.pending("step1");
  assertEquals(stepRun.stepName, "step1");
  assertEquals(stepRun.status, "pending");
  assertEquals(stepRun.startedAt, undefined);
  assertEquals(stepRun.completedAt, undefined);
  assertEquals(stepRun.error, undefined);
  assertEquals(stepRun.output, undefined);
});

Deno.test("StepRun.start marks step as running", () => {
  const stepRun = StepRun.pending("step1");
  stepRun.start();
  assertEquals(stepRun.status, "running");
  assertEquals(stepRun.startedAt instanceof Date, true);
});

Deno.test("StepRun.succeed marks step as succeeded", () => {
  const stepRun = StepRun.pending("step1");
  stepRun.start();
  stepRun.succeed({ result: "success" });
  assertEquals(stepRun.status, "succeeded");
  assertEquals(stepRun.completedAt instanceof Date, true);
  assertEquals(stepRun.output, { result: "success" });
});

Deno.test("StepRun.fail marks step as failed", () => {
  const stepRun = StepRun.pending("step1");
  stepRun.start();
  stepRun.fail("Something went wrong");
  assertEquals(stepRun.status, "failed");
  assertEquals(stepRun.completedAt instanceof Date, true);
  assertEquals(stepRun.error, "Something went wrong");
});

Deno.test("StepRun.skip marks step as skipped", () => {
  const stepRun = StepRun.pending("step1");
  stepRun.skip();
  assertEquals(stepRun.status, "skipped");
  assertEquals(stepRun.completedAt instanceof Date, true);
});

Deno.test("StepRun.toData returns correct structure", () => {
  const stepRun = StepRun.pending("step1");
  stepRun.start();
  stepRun.succeed({ value: 42 });

  const data = stepRun.toData();
  assertEquals(data.stepName, "step1");
  assertEquals(data.status, "succeeded");
  assertEquals(typeof data.startedAt, "string");
  assertEquals(typeof data.completedAt, "string");
  assertEquals(data.output, { value: 42 });
});

Deno.test("StepRun.fromData reconstructs step run correctly", () => {
  const data = {
    stepName: "test",
    status: "succeeded" as const,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    output: { value: 42 },
  };

  const stepRun = StepRun.fromData(data);
  assertEquals(stepRun.stepName, "test");
  assertEquals(stepRun.status, "succeeded");
  assertEquals(stepRun.output, { value: 42 });
});

// JobRun tests

Deno.test("JobRun.pending creates pending job run with steps", () => {
  const jobRun = JobRun.pending("job1", ["step1", "step2"]);
  assertEquals(jobRun.jobName, "job1");
  assertEquals(jobRun.status, "pending");
  assertEquals(jobRun.steps.length, 2);
  assertEquals(jobRun.steps[0].stepName, "step1");
  assertEquals(jobRun.steps[1].stepName, "step2");
});

Deno.test("JobRun.getStatus returns step status for TriggerEvaluationContext", () => {
  const jobRun = JobRun.pending("job1", ["step1", "step2"]);
  jobRun.getStep("step1")?.start();
  jobRun.getStep("step1")?.succeed();

  assertEquals(jobRun.getStatus("step1"), "succeeded");
  assertEquals(jobRun.getStatus("step2"), "pending");
  assertEquals(jobRun.getStatus("nonexistent"), undefined);
});

Deno.test("JobRun.getStep finds step by name", () => {
  const jobRun = JobRun.pending("job1", ["step1", "step2"]);
  assertEquals(jobRun.getStep("step1")?.stepName, "step1");
  assertEquals(jobRun.getStep("nonexistent"), undefined);
});

Deno.test("JobRun.start marks job as running", () => {
  const jobRun = JobRun.pending("job1", ["step1"]);
  jobRun.start();
  assertEquals(jobRun.status, "running");
});

Deno.test("JobRun.succeed marks job as succeeded", () => {
  const jobRun = JobRun.pending("job1", ["step1"]);
  jobRun.start();
  jobRun.succeed();
  assertEquals(jobRun.status, "succeeded");
});

Deno.test("JobRun.fail marks job as failed", () => {
  const jobRun = JobRun.pending("job1", ["step1"]);
  jobRun.start();
  jobRun.fail();
  assertEquals(jobRun.status, "failed");
});

Deno.test("JobRun.skip marks job and pending steps as skipped", () => {
  const jobRun = JobRun.pending("job1", ["step1", "step2"]);
  jobRun.getStep("step1")?.start();
  jobRun.getStep("step1")?.succeed();
  jobRun.skip();

  assertEquals(jobRun.status, "skipped");
  assertEquals(jobRun.getStep("step1")?.status, "succeeded"); // Already completed, not changed
  assertEquals(jobRun.getStep("step2")?.status, "skipped"); // Was pending, now skipped
});

Deno.test("JobRun.toData returns correct structure", () => {
  const jobRun = JobRun.pending("job1", ["step1"]);
  jobRun.start();

  const data = jobRun.toData();
  assertEquals(data.jobName, "job1");
  assertEquals(data.status, "running");
  assertEquals(data.steps.length, 1);
});

Deno.test("JobRun.fromData reconstructs job run correctly", () => {
  const data = {
    jobName: "test-job",
    status: "running" as const,
    startedAt: new Date().toISOString(),
    steps: [
      { stepName: "step1", status: "succeeded" as const },
    ],
  };

  const jobRun = JobRun.fromData(data);
  assertEquals(jobRun.jobName, "test-job");
  assertEquals(jobRun.status, "running");
  assertEquals(jobRun.steps.length, 1);
});

// WorkflowRun tests

Deno.test("WorkflowRun.create initializes from workflow", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  assertEquals(typeof run.id, "string");
  assertEquals(run.workflowId, workflow.id);
  assertEquals(run.workflowName, workflow.name);
  assertEquals(run.status, "pending");
  assertEquals(run.jobs.length, 2);
  assertEquals(run.getJob("job1")?.steps.length, 2);
  assertEquals(run.getJob("job2")?.steps.length, 1);
});

Deno.test("WorkflowRun.getStatus returns job status for TriggerEvaluationContext", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  run.getJob("job1")?.start();
  run.getJob("job1")?.succeed();

  assertEquals(run.getStatus("job1"), "succeeded");
  assertEquals(run.getStatus("job2"), "pending");
  assertEquals(run.getStatus("nonexistent"), undefined);
});

Deno.test("WorkflowRun.getJob finds job by name", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  assertEquals(run.getJob("job1")?.jobName, "job1");
  assertEquals(run.getJob("nonexistent"), undefined);
});

Deno.test("WorkflowRun.start marks run as running", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  run.start();
  assertEquals(run.status, "running");
  assertEquals(run.startedAt instanceof Date, true);
});

Deno.test("WorkflowRun.complete marks run as succeeded when all jobs succeeded", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  run.start();
  run.getJob("job1")?.start();
  run.getJob("job1")?.succeed();
  run.getJob("job2")?.start();
  run.getJob("job2")?.succeed();
  run.complete();

  assertEquals(run.status, "succeeded");
});

Deno.test("WorkflowRun.complete marks run as failed when any job failed", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);

  run.start();
  run.getJob("job1")?.start();
  run.getJob("job1")?.succeed();
  run.getJob("job2")?.start();
  run.getJob("job2")?.fail();
  run.complete();

  assertEquals(run.status, "failed");
});

Deno.test("WorkflowRun.toData returns correct structure", () => {
  const workflow = createTestWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();

  const data = run.toData();
  assertEquals(data.workflowId, workflow.id);
  assertEquals(data.workflowName, workflow.name);
  assertEquals(data.status, "running");
  assertEquals(data.jobs.length, 2);
});

Deno.test("WorkflowRun.fromData reconstructs run correctly", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    workflowId: "550e8400-e29b-41d4-a716-446655440000",
    workflowName: "test-workflow",
    status: "running" as const,
    startedAt: new Date().toISOString(),
    jobs: [
      {
        jobName: "job1",
        status: "succeeded" as const,
        steps: [{ stepName: "step1", status: "succeeded" as const }],
      },
    ],
  };

  const run = WorkflowRun.fromData(data);
  assertEquals(run.id, data.id);
  assertEquals(run.workflowId, data.workflowId);
  assertEquals(run.workflowName, data.workflowName);
  assertEquals(run.status, "running");
  assertEquals(run.jobs.length, 1);
});

Deno.test("WorkflowRun.fromData and toData roundtrip correctly", () => {
  const workflow = createTestWorkflow();
  const original = WorkflowRun.create(workflow);
  original.start();
  original.getJob("job1")?.start();
  original.getJob("job1")?.getStep("step1")?.start();
  original.getJob("job1")?.getStep("step1")?.succeed({ result: "ok" });

  const data = original.toData();
  const restored = WorkflowRun.fromData(data);

  assertEquals(restored.id, original.id);
  assertEquals(restored.workflowId, original.workflowId);
  assertEquals(restored.status, original.status);
  assertEquals(restored.jobs.length, original.jobs.length);
});
