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

import { assertEquals } from "@std/assert";
import { supersedeSuspendedRuns } from "./supersede.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";

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

function createSuspendedRun(
  workflow: Workflow,
  inputs: Record<string, unknown> = {},
  instanceId?: string,
): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  run.captureInputs(inputs);
  run.suspend(inputs);
  if (instanceId) {
    // Use fromData to set instanceId since the constructor doesn't expose it
    const data = run.toData();
    data.instanceId = instanceId;
    return WorkflowRun.fromData(data);
  }
  return run;
}

function stubRunRepo(saved: WorkflowRun[]): WorkflowRunRepository {
  return {
    save: (_wfId: WorkflowId, run: WorkflowRun) => {
      saved.push(run);
      return Promise.resolve();
    },
  } as unknown as WorkflowRunRepository;
}

Deno.test("supersedeSuspendedRuns: cancels matching-input suspended run", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, { env: "prod" });
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    { env: "prod" },
    () => Promise.resolve([run]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, [run.id]);
  assertEquals(saved.length, 1);
  assertEquals(saved[0].status, "cancelled");
});

Deno.test("supersedeSuspendedRuns: preserves different-input suspended run", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, { env: "staging" });
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    { env: "prod" },
    () => Promise.resolve([run]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved.length, 0);
});

Deno.test("supersedeSuspendedRuns: cancels only matching runs", async () => {
  const wf = createWorkflow("deploy");
  const matching = createSuspendedRun(wf, { env: "prod" });
  const different = createSuspendedRun(wf, { env: "staging" });
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    { env: "prod" },
    () => Promise.resolve([matching, different]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, [matching.id]);
  assertEquals(saved.length, 1);
});

Deno.test("supersedeSuspendedRuns: skips serve-owned runs", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, { env: "prod" }, "serve-instance-1");
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    { env: "prod" },
    () => Promise.resolve([run]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved.length, 0);
});

Deno.test("supersedeSuspendedRuns: empty inputs match empty inputs", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, {});
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    {},
    () => Promise.resolve([run]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, [run.id]);
  assertEquals(saved.length, 1);
});

Deno.test("supersedeSuspendedRuns: no suspended runs returns empty", async () => {
  const wf = createWorkflow("deploy");
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    { env: "prod" },
    () => Promise.resolve([]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved.length, 0);
});

Deno.test("supersedeSuspendedRuns: skips non-suspended runs in the list", async () => {
  const wf = createWorkflow("deploy");
  const run = WorkflowRun.create(wf);
  run.start();
  run.captureInputs({ env: "prod" });
  // Not suspended — still running
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf.id as WorkflowId,
    { env: "prod" },
    () => Promise.resolve([run]),
    stubRunRepo(saved),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved.length, 0);
});
