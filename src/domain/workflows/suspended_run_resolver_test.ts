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

import { assertEquals, assertRejects } from "@std/assert";
import { resolveSuspendedRun } from "./suspended_run_resolver.ts";
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

Deno.test("resolveSuspendedRun: throws when no suspended runs", async () => {
  const wf = createWorkflow("test-wf");
  const run = WorkflowRun.create(wf);
  run.start();
  run.complete();
  const { workflowRepo, runRepo } = stubRepos(wf, [run]);

  await assertRejects(
    () => resolveSuspendedRun(workflowRepo, runRepo, "test-wf"),
    Error,
    "No suspended runs found",
  );
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
