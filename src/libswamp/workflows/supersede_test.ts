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

import { acceptedOutcomeFor } from "../../domain/workflows/signal_wait_store_test_helpers.ts";
import { assertEquals } from "@std/assert";
import { supersedeSuspendedRuns } from "./supersede.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { unclaimedRuns } from "../../domain/workflows/run_claim.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";

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

/** Runs here have no evaluated snapshot: they settle against `wf`. */
const noSnapshot = () => Promise.resolve(null);

/** A repository holding `stored`, which records the runs saved to it. */
function stubRunRepo(
  saved: WorkflowRun[],
  stored: WorkflowRun[] = [],
): WorkflowRunRepository {
  return {
    findById: (_wfId: WorkflowId, runId: string) =>
      Promise.resolve(stored.find((run) => run.id === runId) ?? null),
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
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  assertEquals(result.cancelledRunIds, [run.id]);
  assertEquals(saved.length, 1);
  assertEquals(saved[0].status, "cancelled");
});

Deno.test("supersedeSuspendedRuns: settles the superseded run's unfinished work", async () => {
  const wf = createWorkflow("deploy");
  const run = WorkflowRun.create(wf);
  run.start();
  run.captureInputs({ env: "prod" });
  run.getJob("j")!.start();
  run.suspend({ env: "prod" });
  const saved: WorkflowRun[] = [];

  await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  const job = saved[0].getJob("j")!;
  assertEquals(job.status, "failed");
  assertEquals(job.getStep("s")!.status, "failed");
  assertEquals(job.getStep("s")!.error, "cancelled");
  assertEquals(job.getStep("s")!.settledByAbort, true);
});

Deno.test("supersedeSuspendedRuns: preserves different-input suspended run", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, { env: "staging" });
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
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
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([matching, different]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [matching, different]),
  );

  assertEquals(result.cancelledRunIds, [matching.id]);
  assertEquals(saved.length, 1);
});

Deno.test("supersedeSuspendedRuns: skips serve-owned runs", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, { env: "prod" }, "serve-instance-1");
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved.length, 0);
});

Deno.test("supersedeSuspendedRuns: empty inputs match empty inputs", async () => {
  const wf = createWorkflow("deploy");
  const run = createSuspendedRun(wf, {});
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    {},
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  assertEquals(result.cancelledRunIds, [run.id]);
  assertEquals(saved.length, 1);
});

Deno.test("supersedeSuspendedRuns: no suspended runs returns empty", async () => {
  const wf = createWorkflow("deploy");
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, []),
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
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved.length, 0);
});

Deno.test("supersedeSuspendedRuns: cancels the run as stored, under its claim", async () => {
  const wf = createWorkflow("deploy");
  const listed = createSuspendedRun(wf, { env: "prod" });
  // The stored record is a separate copy, as a repository read returns.
  const current = WorkflowRun.fromData(listed.toData());
  const saved: WorkflowRun[] = [];
  const claimed: string[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([listed]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: {
        withClaim: (runId, fn) => {
          claimed.push(runId);
          return fn();
        },
      },
    },
    stubRunRepo(saved, [current]),
  );

  assertEquals(result.cancelledRunIds, [listed.id]);
  assertEquals(claimed, [listed.id]);
  assertEquals(saved, [current]);
  assertEquals(listed.status, "suspended");
});

Deno.test("supersedeSuspendedRuns: leaves a run that stopped being suspended since the listing", async () => {
  const wf = createWorkflow("deploy");
  const listed = createSuspendedRun(wf, { env: "prod" });
  const current = WorkflowRun.fromData(listed.toData());
  current.complete();
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([listed]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [current]),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved, []);
});

Deno.test("supersedeSuspendedRuns: leaves a run deleted since the listing", async () => {
  const wf = createWorkflow("deploy");
  const listed = createSuspendedRun(wf, { env: "prod" });
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "prod" },
    {
      findSuspendedRuns: () => Promise.resolve([listed]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, []),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(saved, []);
});

/** A suspended run of `wf` whose only step waits for a signal. */
function createWaitingRun(
  wf: Workflow,
  inputs: Record<string, unknown>,
  opened: Date,
): { run: WorkflowRun; waitId: string } {
  const run = createSuspendedRun(wf, inputs);
  const wait = SignalWait.open({ type: "object" }, 60, opened);
  run.getJob("j")!.getStep("s")!.waitForSignal(wait);
  return { run: WorkflowRun.fromData(run.toData()), waitId: wait.id };
}

Deno.test("supersedeSuspendedRuns: leaves a matching run that waits for a signal and reports it as skipped", async () => {
  const wf = createWorkflow("deploy");
  const { run, waitId } = createWaitingRun(wf, {}, new Date());
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    {},
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(result.skippedRuns, [{ runId: run.id, waitIds: [waitId] }]);
  assertEquals(saved, []);
  assertEquals(run.status, "suspended");
  assertEquals(run.getJob("j")!.getStep("s")!.status, "waiting");
});

Deno.test("supersedeSuspendedRuns: leaves a run whose wait is past its deadline, so a resume can still fail its step", async () => {
  const wf = createWorkflow("deploy");
  const { run, waitId } = createWaitingRun(
    wf,
    {},
    new Date("2020-01-01T00:00:00.000Z"),
  );
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    {},
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [run]),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(result.skippedRuns, [{ runId: run.id, waitIds: [waitId] }]);
  assertEquals(saved, []);
});

Deno.test("supersedeSuspendedRuns: decides the skip on the run as stored under its claim", async () => {
  const wf = createWorkflow("deploy");
  // Listed while it waited; signalled before the claim was taken.
  const { run: listed } = createWaitingRun(wf, {}, new Date());
  const current = WorkflowRun.fromData(listed.toData());
  const signalled = current.getJob("j")!.getStep("s")!;
  signalled.applyWaitOutcome(acceptedOutcomeFor(signalled.signalWait!, {}));
  const saved: WorkflowRun[] = [];

  const result = await supersedeSuspendedRuns(
    wf,
    {},
    {
      findSuspendedRuns: () => Promise.resolve([listed]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo(saved, [current]),
  );

  assertEquals(result.skippedRuns, []);
  assertEquals(result.cancelledRunIds, [listed.id]);
  assertEquals(saved, [current]);
});

Deno.test("supersedeSuspendedRuns: a run with different inputs is neither cancelled nor reported as skipped", async () => {
  const wf = createWorkflow("deploy");
  const { run } = createWaitingRun(wf, { env: "prod" }, new Date());

  const result = await supersedeSuspendedRuns(
    wf,
    { env: "staging" },
    {
      findSuspendedRuns: () => Promise.resolve([run]),
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
    },
    stubRunRepo([], [run]),
  );

  assertEquals(result.cancelledRunIds, []);
  assertEquals(result.skippedRuns, []);
});
