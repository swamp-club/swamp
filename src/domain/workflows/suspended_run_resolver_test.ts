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

Deno.test("resolveResumableRun: --run names recover for a running run whose owner is gone", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start(4242);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  for (const fromStep of [undefined, "s"]) {
    const error = await assertRejects(
      () =>
        resolveResumableRun(workflowRepo, runRepo, "test-wf", run.id, {
          fromStep,
          ownerIsDead: (r) => r.id === run.id,
        }),
      Error,
      "its owning process (pid 4242) is gone",
    );
    assertStringIncludes(
      error.message,
      `swamp workflow recover test-wf --run ${run.id}`,
    );
  }
});

Deno.test("resolveResumableRun: --run still says to wait for a running run whose owner is alive", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start(4242);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () =>
      resolveResumableRun(workflowRepo, runRepo, "test-wf", run.id, {
        ownerIsDead: () => false,
      }),
    Error,
    "is not suspended or failed (status: running). Wait for it to complete",
  );
});

Deno.test("resolveResumableRun: without --run names recover when the latest run is running under a dead owner", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start(4242);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () =>
      resolveResumableRun(workflowRepo, runRepo, "test-wf", undefined, {
        ownerIsDead: (r) => r.id === run.id,
      }),
    Error,
    `The latest run (${run.id}) is recorded as running, but its owning process is gone`,
  );
  assertStringIncludes(
    error.message,
    `swamp workflow recover test-wf --run ${run.id}`,
  );
  assertEquals(error.message.includes("Wait for it to complete"), false);
});

Deno.test("resolveResumableRun: without --run still says to wait when the latest run's owner is alive", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start(4242);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () =>
      resolveResumableRun(workflowRepo, runRepo, "test-wf", undefined, {
        ownerIsDead: () => false,
      }),
    Error,
    "The latest run is running",
  );
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

Deno.test("resolveResumableRun: the failed-run hint fits serve's 512-character error limit", async () => {
  const wf = createWorkflow("retry-failed-steps");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  const error = await assertRejects(
    () => resolveResumableRun(workflowRepo, runRepo, "retry-failed-steps"),
    Error,
  );
  assertEquals(error.message.length <= 512, true, error.message);
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

/** The test-wf workflow with a step t added to job j since the run. */
function createEditedWorkflow(): Workflow {
  return Workflow.create({
    name: "test-wf",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({ name: "s", task: StepTask.model("m", "run") }),
          Step.create({ name: "t", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
}

for (
  const [label, runId, options] of [
    ["--from with --run", true, FROM],
    ["--from of the single failed run", false, FROM],
    ["a retry", true, {}],
  ] as const
) {
  Deno.test(`resolveResumableRun: ${label} refuses a workflow whose structure changed`, async () => {
    const run = createFailedRun(createWorkflow("test-wf"));
    const before = JSON.stringify(run.toData());
    const { workflowRepo, runRepo } = stubRepos(createEditedWorkflow(), [run]);

    const error = await assertRejects(
      () =>
        resolveResumableRun(
          workflowRepo,
          runRepo,
          "test-wf",
          runId ? run.id : undefined,
          options,
        ),
      Error,
      `Step "t" in job "j" is not in the run. Start a new run.`,
    );
    assertStringIncludes(
      error.message,
      `swamp workflow history logs ${run.id}`,
    );
    assertEquals(JSON.stringify(run.toData()), before);
  });
}

for (
  const [label, runId, options] of [
    ["a bare resume", false, {}],
    ["--run", true, {}],
    ["suspendedOnly with --run", true, { suspendedOnly: true }],
    ["suspendedOnly without --run", false, { suspendedOnly: true }],
  ] as const
) {
  Deno.test(`resolveResumableRun: ${label} refuses a suspended run whose workflow changed shape`, async () => {
    const run = createSuspendedRun(createWorkflow("test-wf"));
    const before = JSON.stringify(run.toData());
    const { workflowRepo, runRepo } = stubRepos(createEditedWorkflow(), [run]);

    await assertRejects(
      () =>
        resolveResumableRun(
          workflowRepo,
          runRepo,
          "test-wf",
          runId ? run.id : undefined,
          options,
        ),
      Error,
      `The workflow changed shape since the run started. ` +
        `To cancel it: 'swamp workflow cancel test-wf --run ${run.id}'. ` +
        `Step "t" in job "j" is not in the run.`,
    );
    assertEquals(JSON.stringify(run.toData()), before);
  });
}

Deno.test("resolveResumableRun: suspendedOnly refuses a failed run as not suspended", async () => {
  const wf = createWorkflow("test-wf");
  const run = createFailedRun(wf);
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () =>
      resolveResumableRun(workflowRepo, runRepo, "test-wf", run.id, {
        suspendedOnly: true,
      }),
    Error,
    `Run ${run.id} is not suspended (status: failed)`,
  );
});

Deno.test("resolveSuspendedRun: approve and reject still resolve a suspended run whose workflow changed shape", async () => {
  // Deciding a gate records a decision and runs nothing, so it is allowed;
  // the resume that follows is refused.
  const run = createSuspendedRun(createWorkflow("test-wf"));
  const { workflowRepo, runRepo } = stubRepos(createEditedWorkflow(), [run]);

  const result = await resolveSuspendedRun(
    workflowRepo,
    runRepo,
    "test-wf",
    run.id,
  );
  assertEquals(result.run.id, run.id);
});

/**
 * Repos holding two workflows, where `impostor` is named with `target`'s id,
 * so a name-first lookup of that id picks the impostor and an id-only lookup
 * picks the target.
 */
function collidingRepos(runsByWorkflow: Map<string, WorkflowRun[]>): {
  target: Workflow;
  impostor: Workflow;
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
} {
  const target = createWorkflow("target-wf");
  const impostor = createWorkflow(target.id);
  const workflows = [target, impostor];
  return {
    target,
    impostor,
    workflowRepo: {
      findByName: (name: string) =>
        Promise.resolve(workflows.find((w) => w.name === name) ?? null),
      findById: (id: WorkflowId) =>
        Promise.resolve(workflows.find((w) => w.id === id) ?? null),
      findAll: () => Promise.resolve(workflows),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      getPath: () => "",
    } as unknown as WorkflowRepository,
    runRepo: {
      findAllByWorkflowId: (wfId: WorkflowId) =>
        Promise.resolve(runsByWorkflow.get(wfId as string) ?? []),
      findById: (wfId: WorkflowId, runId: WorkflowRunId) =>
        Promise.resolve(
          (runsByWorkflow.get(wfId as string) ?? []).find((r) =>
            r.id === (runId as string)
          ) ?? null,
        ),
      save: () => Promise.resolve(),
    } as unknown as WorkflowRunRepository,
  };
}

function withRuns(
  build: (target: Workflow, impostor: Workflow) => [WorkflowRun, WorkflowRun],
) {
  const runs = new Map<string, WorkflowRun[]>();
  const repos = collidingRepos(runs);
  const [targetRun, impostorRun] = build(repos.target, repos.impostor);
  runs.set(repos.target.id, [targetRun]);
  runs.set(repos.impostor.id, [impostorRun]);
  return { ...repos, targetRun, impostorRun };
}

Deno.test("resolveSuspendedRun: byId resolves the workflow whose id matches, not one named with that id", async () => {
  const { target, workflowRepo, runRepo, targetRun } = withRuns((t, i) => [
    createSuspendedRun(t),
    createSuspendedRun(i),
  ]);

  const result = await resolveSuspendedRun(
    workflowRepo,
    runRepo,
    target.id,
    undefined,
    { byId: true },
  );
  assertEquals(result.workflowId, target.id);
  assertEquals(result.workflowName, "target-wf");
  assertEquals(result.run.id, targetRun.id);
});

Deno.test("resolveSuspendedRun: without byId the name match wins over the id match", async () => {
  const { target, impostor, workflowRepo, runRepo, impostorRun } = withRuns((
    t,
    i,
  ) => [createSuspendedRun(t), createSuspendedRun(i)]);

  const result = await resolveSuspendedRun(workflowRepo, runRepo, target.id);
  assertEquals(result.workflowId, impostor.id);
  assertEquals(result.run.id, impostorRun.id);
});

Deno.test("resolveSuspendedRun: byId does not fall back to a name lookup", async () => {
  const wf = createWorkflow("named-wf");
  const { workflowRepo, runRepo } = stubRepos(wf, [createSuspendedRun(wf)]);

  await assertRejects(
    () =>
      resolveSuspendedRun(workflowRepo, runRepo, "named-wf", undefined, {
        byId: true,
      }),
    Error,
    "Workflow not found",
  );
});

Deno.test("resolveResumableRun: byId with --from resolves the workflow whose id matches", async () => {
  const { target, workflowRepo, runRepo, targetRun } = withRuns((t, i) => [
    createFailedRun(t),
    createFailedRun(i),
  ]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    target.id,
    undefined,
    { ...FROM, byId: true },
  );
  assertEquals(result.workflowId, target.id);
  assertEquals(result.run.id, targetRun.id);
});

Deno.test("resolveResumableRun: byId bare resume resolves the workflow whose id matches", async () => {
  const { target, workflowRepo, runRepo, targetRun } = withRuns((t, i) => [
    createSuspendedRun(t),
    createSuspendedRun(i),
  ]);

  const result = await resolveResumableRun(
    workflowRepo,
    runRepo,
    target.id,
    undefined,
    { byId: true },
  );
  assertEquals(result.workflowId, target.id);
  assertEquals(result.run.id, targetRun.id);
});
