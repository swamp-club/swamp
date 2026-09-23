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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  resolveResumableRun,
  resolveSuspendedRun,
} from "./suspended_run_resolver.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";

function createWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "j",
        steps: [Step.create({ name: "s", task: StepTask.model("m", "run") })],
      }),
    ],
  });
}

function createSuspendedRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  run.suspend();
  return run;
}

function stubRepos(
  workflow: Workflow | null,
  runs: WorkflowRun[],
): { workflowRepo: WorkflowRepository; runRepo: WorkflowRunRepository } {
  return {
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(workflow?.name === name ? workflow : null),
      findById: (_id: WorkflowId) => Promise.resolve(workflow),
      findAll: () => Promise.resolve(workflow ? [workflow] : []),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      getPath: () => "",
    } as unknown as WorkflowRepository,
    runRepo: {
      findAllByWorkflowId: () => Promise.resolve(runs),
      findById: (_wfId: WorkflowId, runId: WorkflowRunId) =>
        Promise.resolve(
          runs.find((r) => r.id === (runId as string)) ?? null,
        ),
      save: () => Promise.resolve(),
    } as unknown as WorkflowRunRepository,
  };
}

Deno.test("resolveSuspendedRun: returns single suspended run by name", async () => {
  const wf = createWorkflow("test-wf");
  const run = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const result = await resolveSuspendedRun(workflowRepo, runRepo, "test-wf");
  assertEquals(result.workflowName, "test-wf");
  assertEquals(result.run.id, run.id);
  assertEquals(result.workflow.name, "test-wf");
});

Deno.test("resolveSuspendedRun: throws when workflow not found", async () => {
  const { workflowRepo, runRepo } = stubRepos(null, []);

  await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "nonexistent"),
    Error,
    "Workflow not found",
  );
});

Deno.test("resolveSuspendedRun: throws when no suspended runs with latest run state", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.jobs[0].steps[0].succeed();
  run.jobs[0].succeed();
  run.complete();
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf"),
    Error,
    "No suspended runs found",
  );
  assertStringIncludes(error.message, "already completed");
  assertStringIncludes(error.message, "swamp workflow history test-wf");
});

Deno.test("resolveSuspendedRun: throws with run command when no runs exist", async () => {
  const wf = createWorkflow("test-wf");
  const { workflowRepo, runRepo } = stubRepos(wf, []);

  const error = await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf"),
    Error,
    "No suspended runs found",
  );
  assertStringIncludes(error.message, "No runs exist");
  assertStringIncludes(error.message, "swamp workflow run test-wf");
});

Deno.test("resolveSuspendedRun: throws when multiple suspended runs", async () => {
  const wf = createWorkflow("test-wf");
  const run1 = createSuspendedRun(wf);
  const run2 = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run1, run2]);

  await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf"),
    Error,
    "--run <run-id>",
  );
});

Deno.test("resolveSuspendedRun: --run targets specific run", async () => {
  const wf = createWorkflow("test-wf");
  const run1 = createSuspendedRun(wf);
  const run2 = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run1, run2]);

  const result = await resolveSuspendedRun(
    workflowRepo,
    runRepo,
    "test-wf",
    run2.id,
  );
  assertEquals(result.run.id, run2.id);
});

Deno.test("resolveSuspendedRun: --run rejects non-suspended run", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start();
  run.complete();
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf", run.id),
    Error,
    "not suspended",
  );
});

// ── resolveResumableRun ─────────────────────────────────────────────

function createFailedRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.jobs[0].steps[0].fail("error");
  run.jobs[0].fail();
  run.complete();
  return run;
}

const FROM = { fromStep: "s" };

Deno.test("resolveResumableRun: --from returns single failed run by name", async () => {
  const wf = createWorkflow("test-wf");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    "test-wf",
    undefined,
    FROM,
  );
  assertEquals(result.workflowName, "test-wf");
  assertEquals(result.run.id, run.id);
  assertEquals(result.run.status, "failed");
});

Deno.test("resolveResumableRun: --from throws when no failed runs with latest run state", async () => {
  const wf = createWorkflow("test-wf");
  const run = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () =>
      resolveResumableRun(workflowRepo, runRepo, "test-wf", undefined, FROM),
    Error,
    "No failed runs found",
  );
  assertStringIncludes(error.message, "The latest run is suspended");
  assertStringIncludes(error.message, "swamp workflow approve test-wf");
});

Deno.test("resolveResumableRun: --from throws when multiple failed runs", async () => {
  const wf = createWorkflow("test-wf");
  const run1 = createFailedRun(wf);
  const run2 = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run1, run2]);

  await assertRejects(
    () =>
      resolveResumableRun(workflowRepo, runRepo, "test-wf", undefined, FROM),
    Error,
    "--run <run-id>",
  );
});

Deno.test("resolveResumableRun: --from is not made ambiguous by a suspended run", async () => {
  const wf = createWorkflow("test-wf");
  const failed = createFailedRun(wf);
  const suspended = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [suspended, failed]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    "test-wf",
    undefined,
    FROM,
  );
  assertEquals(result.run.id, failed.id);
});

Deno.test("resolveResumableRun: --run with --from targets specific failed run", async () => {
  const wf = createWorkflow("test-wf");
  const run1 = createFailedRun(wf);
  const run2 = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run1, run2]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    "test-wf",
    run2.id,
    FROM,
  );
  assertEquals(result.run.id, run2.id);
});

Deno.test("resolveResumableRun: --run with --from rejects non-failed run", async () => {
  const wf = createWorkflow("test-wf");
  const run = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () => resolveResumableRun(workflowRepo, runRepo, "test-wf", run.id, FROM),
    Error,
    "--from requires a failed run",
  );
});

Deno.test("resolveResumableRun: --run without --from accepts a failed run for retry", async () => {
  const wf = createWorkflow("test-wf");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    "test-wf",
    run.id,
  );
  assertEquals(result.run.id, run.id);
});

Deno.test("resolveResumableRun: --run without --from accepts a suspended run", async () => {
  const wf = createWorkflow("test-wf");
  const run = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    "test-wf",
    run.id,
  );
  assertEquals(result.run.id, run.id);
});

Deno.test("resolveResumableRun: --run refuses a run that is neither suspended nor failed", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start();
  run.interrupt("crash");
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () => resolveResumableRun(workflowRepo, runRepo, "test-wf", run.id),
    Error,
    "is not suspended or failed (status: interrupted)",
  );
  assertStringIncludes(error.message, "swamp workflow recover test-wf");
});

Deno.test("resolveResumableRun: refuses an ineligible failed run before resume starts", async () => {
  const wf = createWorkflow("test-wf");
  const run = createFailedRun(wf);
  run.jobs[0].steps[0].resetToPending();
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () => resolveResumableRun(workflowRepo, runRepo, "test-wf", run.id),
    Error,
    `Step "s" in job "j" is pending`,
  );
});

Deno.test("resolveResumableRun: bare resume matches the suspended run and ignores failed runs", async () => {
  const wf = createWorkflow("test-wf");
  const failed1 = createFailedRun(wf);
  const failed2 = createFailedRun(wf);
  const suspended = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [
    failed1,
    suspended,
    failed2,
  ]);

  const result = await resolveResumableRun(workflowRepo, runRepo, "test-wf");
  assertEquals(result.run.id, suspended.id);
});

Deno.test("resolveResumableRun: bare resume with only a failed run names the retry command", async () => {
  const wf = createWorkflow("test-wf");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () => resolveResumableRun(workflowRepo, runRepo, "test-wf"),
    Error,
    "No suspended runs found",
  );
  assertStringIncludes(
    error.message,
    `The latest run is failed. Retry it with 'swamp workflow resume test-wf --run ${run.id}'.`,
  );
  // The hint names the run, so the message does not repeat the id.
  assertEquals(error.message.split(run.id).length - 1, 1);
});

Deno.test("resolveSuspendedRun: ignores failed runs, as approve and reject need", async () => {
  const wf = createWorkflow("test-wf");
  const failed = createFailedRun(wf);
  const suspended = createSuspendedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [failed, suspended]);

  const result = await resolveSuspendedRun(workflowRepo, runRepo, "test-wf");
  assertEquals(result.run.id, suspended.id);
  await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf", failed.id),
    Error,
    "is not suspended",
  );
});

Deno.test("resolveResumableRun: the failed-run hint fits serve's 200-character error limit", async () => {
  const wf = createWorkflow("retry-failed-steps");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () => resolveResumableRun(workflowRepo, runRepo, "retry-failed-steps"),
    Error,
  );
  assertEquals(error.message.length <= 200, true, error.message);
});

Deno.test("resolveSuspendedRun: approve and reject on a failed run name the resume command", async () => {
  const wf = createWorkflow("test-wf");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  // approve and reject resolve through resolveSuspendedRun, so the hint must
  // name `workflow resume` rather than a flag to add to their own command.
  const error = await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf"),
    Error,
    "No suspended runs found",
  );
  assertStringIncludes(
    error.message,
    `Retry it with 'swamp workflow resume test-wf --run ${run.id}'.`,
  );
});
