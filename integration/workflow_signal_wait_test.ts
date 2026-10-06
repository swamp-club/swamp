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

/**
 * Integration tests for the wait_for_signal step task (swamp-club#3068): a
 * run suspends on a wait, `workflow signal` delivers a JSON payload under the
 * run's claim, and a resume continues with the payload as the step's output,
 * or fails the step once the wait's deadline has passed. Everything runs on
 * real YAML repositories and the per-workflow run index, through the
 * libswamp operations the CLI calls.
 */

import { join } from "@std/path";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "../src/domain/workflows/signal_wait.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowCancelSuspendedDeps,
  createWorkflowRejectDeps,
  createWorkflowSignalDeps,
  createWorkflowWaitsDeps,
  supersedeSuspendedRuns,
  workflowCancelSuspended,
  workflowReject,
  workflowSignal,
  type WorkflowSignalData,
  type WorkflowSignalEvent,
  workflowWaits,
  type WorkflowWaitsData,
} from "../src/libswamp/mod.ts";
import type { InputsSchema } from "../src/domain/definitions/definition.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { unclaimedRuns } from "../src/domain/workflows/run_claim.ts";

await initializeLogging({});

class RecordingExecutor implements StepExecutor {
  readonly executed: string[] = [];
  execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.executed.push(`${ctx.workflowName}/${ctx.stepName}`);
    return Promise.resolve({ step: ctx.stepName });
  }
}

interface Harness {
  workflowRepo: YamlWorkflowRepository;
  runRepo: YamlWorkflowRunRepository;
  service: WorkflowExecutionService;
  executor: RecordingExecutor;
}

async function withHarness(
  workflows: Workflow[],
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-signal-wait-" });
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    for (const workflow of workflows) await workflowRepo.save(workflow);
    const runRepo = new YamlWorkflowRunRepository(repoDir);
    const executor = new RecordingExecutor();
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
      executor,
      undefined,
      catalogStore,
    );
    await fn({ workflowRepo, runRepo, service, executor });
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

const VERDICT_SCHEMA: InputsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["ship", "fix", "abandon"] },
  },
};

/** The workflow from the issue: a review wait, then ship or escalate. */
function release(
  name: string,
  options: { allowFailure?: boolean; reviewGuard?: string } = {},
): Workflow {
  return Workflow.create({
    name,
    ...(options.reviewGuard
      ? {
        inputs: {
          properties: { skipReview: { type: "boolean", default: false } },
        },
      }
      : {}),
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review",
            allowFailure: options.allowFailure ?? true,
            guard: options.reviewGuard,
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
          }),
          Step.create({
            name: "ship",
            dependsOn: [{
              step: "review",
              condition: TriggerCondition.succeeded(),
            }],
            // A guard skips the step when it is truthy: skip unless the
            // verdict is ship.
            guard: '${{ steps.review.outputs.payload.verdict != "ship" }}',
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "escalate",
            dependsOn: [{
              step: "review",
              condition: TriggerCondition.failed(),
            }],
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

async function drain(
  stream: AsyncIterable<WorkflowExecutionEvent>,
): Promise<WorkflowExecutionEvent[]> {
  const events: WorkflowExecutionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function only(h: Harness, workflow: Workflow): Promise<WorkflowRun> {
  const runs = await h.runRepo.findAllByWorkflowId(workflow.id);
  assertEquals(runs.length, 1);
  return runs[0];
}

function stepOf(run: WorkflowRun, stepName: string, jobName = "release") {
  const step = run.getJob(jobName)?.getStep(stepName);
  assert(step, `step ${stepName} not found`);
  return step;
}

/** The id of the wait the named step of the run holds. */
function waitIdOf(run: WorkflowRun, stepName = "review"): string {
  const wait = stepOf(run, stepName).signalWait;
  assert(wait, `step ${stepName} holds no wait`);
  return wait.id;
}

async function signal(
  h: Harness,
  waitId: string,
  payload: unknown,
): Promise<WorkflowSignalEvent> {
  let last: WorkflowSignalEvent | undefined;
  for await (
    const event of workflowSignal(
      createLibSwampContext(),
      createWorkflowSignalDeps(h.runRepo, unclaimedRuns),
      { waitId, payload, submittedBy: "tester" },
    )
  ) {
    last = event;
  }
  assert(last);
  return last;
}

async function signalOk(
  h: Harness,
  waitId: string,
  payload: unknown,
): Promise<WorkflowSignalData> {
  const event = await signal(h, waitId, payload);
  if (event.kind !== "completed") {
    throw new Error(`signal refused: ${JSON.stringify(event)}`);
  }
  return event.data;
}

async function signalError(
  h: Harness,
  waitId: string,
  payload: unknown,
): Promise<{ code: string; message: string }> {
  const event = await signal(h, waitId, payload);
  if (event.kind !== "error") {
    throw new Error(`signal accepted: ${JSON.stringify(event)}`);
  }
  return event.error;
}

async function listWaits(h: Harness): Promise<WorkflowWaitsData> {
  for await (
    const event of workflowWaits(
      createLibSwampContext(),
      createWorkflowWaitsDeps(h.runRepo),
    )
  ) {
    if (event.kind === "completed") return event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  throw new Error("no completed event");
}

/**
 * Moves the deadline of every wait the run holds into the past, as the
 * record would read once the timeout had elapsed. Never sleeps.
 */
async function expireWaits(h: Harness, run: WorkflowRun): Promise<void> {
  const data = run.toData();
  for (const job of data.jobs) {
    for (const step of job.steps) {
      const wait = step.wait as { deadline?: string } | undefined;
      if (wait) wait.deadline = "2020-01-01T00:00:00.000Z";
    }
  }
  await h.runRepo.save(
    createWorkflowId(run.workflowId),
    WorkflowRun.fromData(data),
  );
}

async function reload(h: Harness, run: WorkflowRun): Promise<WorkflowRun> {
  const loaded = await h.runRepo.findById(
    createWorkflowId(run.workflowId),
    run.id,
  );
  assert(loaded);
  return loaded;
}

Deno.test("signal wait: the run suspends on the wait and reports its id", async () => {
  const workflow = release("suspends");
  await withHarness([workflow], async (h) => {
    const events = await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);

    assertEquals(run.status, "suspended");
    assertEquals(stepOf(run, "review").status, "waiting");
    assertEquals(h.executor.executed, []);

    const requested = events.find((e) => e.kind === "signal_wait_requested");
    assert(requested?.kind === "signal_wait_requested");
    assertEquals(requested.waitId, waitId);
    const suspended = events.at(-1);
    assert(suspended?.kind === "suspended");
    assertEquals(suspended.wait?.id, waitId);
    assertEquals(suspended.stepId, "review");

    const { waits } = await listWaits(h);
    assertEquals(waits.length, 1);
    assertEquals(waits[0].waitId, waitId);
    assertEquals(waits[0].workflowName, workflow.name);
    assertEquals(waits[0].stepName, "review");
    assertEquals(waits[0].expired, false);
    assertEquals(waits[0].schema, VERDICT_SCHEMA);
    assertStringIncludes(waits[0].nextCommand, `workflow signal ${waitId}`);

    // Read back through the run index: a waiting run is not resumable.
    const summaries = await h.runRepo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].status, "suspended");
    assertEquals(summaries[0].awaitingResume, undefined);
  });
});

Deno.test("signal wait: a resume refuses while the wait is open and names the signal command", async () => {
  const workflow = release("refuses-resume");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);

    const error = await assertRejects(
      () => drain(h.service.resume(workflow.name, run.id)),
      UserError,
    );
    assertStringIncludes(error.message, "still waiting for a signal");
    assertStringIncludes(
      error.message,
      `swamp workflow signal ${waitIdOf(run)}`,
    );
    assertEquals(stepOf(await reload(h, run), "review").status, "waiting");
  });
});

Deno.test("signal wait: each refusal is distinct and leaves the wait open", async () => {
  const workflow = release("refusals");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);

    const unknown = await signalError(h, crypto.randomUUID(), {
      verdict: "ship",
    });
    assertEquals(unknown.code, "not_found");

    const wrongEnum = await signalError(h, waitId, { verdict: "maybe" });
    assertEquals(wrongEnum.code, "validation_failed");
    assertStringIncludes(wrongEnum.message, "Payload refused");
    assertStringIncludes(wrongEnum.message, "the wait stays open");

    const extraKey = await signalError(h, waitId, {
      verdict: "ship",
      note: "extra",
    });
    assertStringIncludes(extraKey.message, "note");

    const missing = await signalError(h, waitId, {});
    assertStringIncludes(missing.message, "verdict is required");

    const notObject = await signalError(h, waitId, ["ship"]);
    assertStringIncludes(notObject.message, "must be a JSON object");

    // Nothing was stored by a refused signal.
    const after = await reload(h, run);
    assertEquals(stepOf(after, "review").status, "waiting");
    assertEquals(stepOf(after, "review").output, undefined);
    assertEquals(waitIdOf(after), waitId);
  });
});

Deno.test("signal wait: a signal then a resume runs the branch the payload selects", async () => {
  const workflow = release("ships");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);

    const sent = { verdict: "ship" };
    const data = await signalOk(h, waitId, sent);
    assertEquals(data.runId, run.id);
    assertEquals(data.stepName, "review");
    assertEquals(data.awaitingResume, true);
    assertEquals(data.signal.waitId, waitId);
    assertEquals(data.signal.submittedBy, "tester");
    assertStringIncludes(data.resumeCommand, `--run ${run.id}`);

    // The step succeeded with the payload exactly as sent and the receipt.
    const signalled = await reload(h, run);
    const review = stepOf(signalled, "review");
    assertEquals(review.status, "succeeded");
    assertEquals(review.output, {
      type: "wait_for_signal",
      payload: sent,
      signal: data.signal,
    });
    assertEquals(signalled.isAwaitingResume(), true);
    const summaries = await h.runRepo.findAllSummariesFromIndex(workflow.id);
    assertEquals(summaries[0].awaitingResume, true);
    assertEquals((await listWaits(h)).waits, []);

    // A second signal is refused and shown the stored receipt.
    const again = await signalError(h, waitId, { verdict: "abandon" });
    assertStringIncludes(again.message, "already settled");
    assertStringIncludes(again.message, data.signal.id);
    assertEquals(stepOf(await reload(h, run), "review").output, review.output);

    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "ship").status, "succeeded");
    assertEquals(stepOf(finished, "escalate").status, "skipped");
    assertEquals(h.executor.executed, [`${workflow.name}/ship`]);
  });
});

Deno.test("signal wait: a guard reading the payload skips the branch another verdict excludes", async () => {
  const workflow = release("fixes");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    await signalOk(h, waitIdOf(run), { verdict: "fix" });

    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "ship").status, "skipped");
    assertEquals(stepOf(finished, "ship").skipReason?.kind, "guarded");
    assertEquals(h.executor.executed, []);
  });
});

Deno.test("signal wait: past the deadline a signal is refused and a resume fails the step so the failed handler runs", async () => {
  const workflow = release("times-out");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    await expireWaits(h, run);

    const expired = await signalError(h, waitId, { verdict: "ship" });
    assertStringIncludes(expired.message, "expired");
    assertStringIncludes(expired.message, "swamp workflow resume");
    assertEquals(stepOf(await reload(h, run), "review").status, "waiting");

    const { waits } = await listWaits(h);
    assertEquals(waits.length, 1);
    assertEquals(waits[0].expired, true);
    assertStringIncludes(waits[0].nextCommand, "swamp workflow resume");

    const events = await drain(h.service.resume(workflow.name, run.id));
    const failed = events.find((e) =>
      e.kind === "step_failed" && e.stepId === "review"
    );
    assert(failed?.kind === "step_failed");
    assertEquals(failed.error, WAIT_TIMEOUT_STEP_ERROR);
    assertEquals(failed.allowedFailure, true);

    const finished = await reload(h, run);
    const review = stepOf(finished, "review");
    assertEquals(review.status, "failed");
    assertEquals(review.error, WAIT_TIMEOUT_STEP_ERROR);
    assertEquals(review.allowedFailure, true);
    assertEquals(stepOf(finished, "escalate").status, "succeeded");
    assertEquals(stepOf(finished, "ship").status, "skipped");
    assertEquals(h.executor.executed, [`${workflow.name}/escalate`]);
    // allowFailure decides whether the timeout fails the run.
    assertEquals(finished.status, "succeeded");
  });
});

Deno.test("signal wait: without allowFailure a timeout fails the run, and a retry opens a new wait", async () => {
  const workflow = release("retries", { allowFailure: false });
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const firstWaitId = waitIdOf(run);
    await expireWaits(h, run);

    await drain(h.service.resume(workflow.name, run.id));
    const failed = await reload(h, run);
    assertEquals(failed.status, "failed");
    assertEquals(stepOf(failed, "review").error, WAIT_TIMEOUT_STEP_ERROR);

    // Retrying the failed run resets the step: a fresh wait, a fresh id.
    await drain(h.service.resume(workflow.name, run.id));
    const retried = await reload(h, run);
    assertEquals(retried.status, "suspended");
    const secondWaitId = waitIdOf(retried);
    assertNotEquals(secondWaitId, firstWaitId);

    // A signal for the old attempt finds nothing open.
    const stale = await signalError(h, firstWaitId, { verdict: "ship" });
    assertEquals(stale.code, "not_found");
    await signalOk(h, secondWaitId, { verdict: "ship" });
  });
});

Deno.test("signal wait: a resume whose inputs flip the step's guard still times the wait out and opens no second wait", async () => {
  const workflow = release("guard-flips", {
    reviewGuard: "${{ inputs.skipReview }}",
  });
  await withHarness([workflow], async (h) => {
    await drain(
      h.service.run(workflow.name, { inputs: { skipReview: false } }),
    );
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    const startedAt = stepOf(run, "review").startedAt;
    await expireWaits(h, run);

    // The guard would now skip the step. It holds a wait, so it is settled
    // instead of evaluated again.
    await drain(
      h.service.resume(workflow.name, run.id, {
        inputs: { skipReview: true },
      }),
    );
    const finished = await reload(h, run);
    const review = stepOf(finished, "review");
    assertEquals(review.status, "failed");
    assertEquals(review.error, WAIT_TIMEOUT_STEP_ERROR);
    assertEquals(review.signalWait?.id, waitId);
    assertEquals(review.startedAt, startedAt);
    assertEquals(stepOf(finished, "escalate").status, "succeeded");
  });
});

Deno.test("signal wait: a new run does not supersede a run that waits for a signal, expired or not", async () => {
  const workflow = release("not-superseded");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    const supersede = () =>
      supersedeSuspendedRuns(
        workflow,
        {},
        {
          findSuspendedRuns: (id) => h.runRepo.findAllByWorkflowId(id),
          findEvaluatedWorkflow: () => Promise.resolve(null),
          runClaims: unclaimedRuns,
        },
        h.runRepo,
      );

    let result = await supersede();
    assertEquals(result.cancelledRunIds, []);
    assertEquals(result.skippedRuns, [{ runId: run.id, waitIds: [waitId] }]);
    assertEquals((await reload(h, run)).status, "suspended");

    await expireWaits(h, run);
    result = await supersede();
    assertEquals(result.cancelledRunIds, []);
    assertEquals(result.skippedRuns, [{ runId: run.id, waitIds: [waitId] }]);
    assertEquals(stepOf(await reload(h, run), "review").status, "waiting");

    // Once the wait is settled the run is an ordinary suspended run again.
    const fresh = release("superseded-after-signal");
    await h.workflowRepo.save(fresh);
    await drain(h.service.run(fresh.name));
    const freshRun = await only(h, fresh);
    await signalOk(h, waitIdOf(freshRun), { verdict: "ship" });
    const after = await supersedeSuspendedRuns(
      fresh,
      {},
      {
        findSuspendedRuns: (id) => h.runRepo.findAllByWorkflowId(id),
        findEvaluatedWorkflow: () => Promise.resolve(null),
        runClaims: unclaimedRuns,
      },
      h.runRepo,
    );
    assertEquals(after.cancelledRunIds, [freshRun.id]);
    assertEquals(after.skippedRuns, []);
  });
});

Deno.test("signal wait: cancelling the run leaves no step waiting and closes the wait", async () => {
  const workflow = release("cancelled");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);

    for await (
      const event of workflowCancelSuspended(
        createLibSwampContext(),
        createWorkflowCancelSuspendedDeps(
          h.workflowRepo,
          h.runRepo,
          () => true,
          () => Promise.resolve(null),
        ),
        { runId: run.id, reason: "operator" },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    const cancelled = await reload(h, run);
    assertEquals(cancelled.status, "cancelled");
    assertEquals(
      cancelled.jobs.flatMap((j) => j.steps).filter((s) =>
        s.status === "waiting" || s.status === "waiting_approval"
      ),
      [],
    );
    assertEquals(stepOf(cancelled, "review").status, "failed");
    assertEquals((await listWaits(h)).waits, []);

    const closed = await signalError(h, waitId, { verdict: "ship" });
    assertStringIncludes(closed.message, "is closed");
  });
});

Deno.test("signal wait: rejecting a gate beside the wait leaves no step waiting", async () => {
  const workflow = Workflow.create({
    name: "gate-and-wait",
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve the release"),
          }),
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    assertEquals(stepOf(run, "gate").status, "waiting_approval");
    assertEquals(stepOf(run, "review").status, "waiting");

    for await (
      const event of workflowReject(
        createLibSwampContext(),
        createWorkflowRejectDeps(
          h.workflowRepo,
          h.runRepo,
          unclaimedRuns,
          () => Promise.resolve(null),
        ),
        {
          workflowIdOrName: workflow.name,
          stepName: "gate",
          runId: run.id,
          reason: "not today",
        },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    const rejected = await reload(h, run);
    assertEquals(rejected.status, "failed");
    assertEquals(
      rejected.jobs.flatMap((j) => j.steps).filter((s) =>
        s.status === "waiting" || s.status === "waiting_approval"
      ),
      [],
    );
  });
});

Deno.test("signal wait: each forEach iteration gets its own wait, and the run resumes once all are signalled", async () => {
  const workflow = Workflow.create({
    name: "per-region",
    inputs: {
      properties: { regions: { type: "array", items: { type: "string" } } },
    },
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review-${{ self.region }}",
            forEach: { item: "region", in: "${{ inputs.regions }}" },
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    await drain(
      h.service.run(workflow.name, { inputs: { regions: ["eu", "us"] } }),
    );
    const run = await only(h, workflow);
    const { waits } = await listWaits(h);
    assertEquals(waits.map((w) => w.stepName).sort(), [
      "review-eu",
      "review-us",
    ]);
    assertNotEquals(waits[0].waitId, waits[1].waitId);

    const first = await signalOk(h, waits[0].waitId, { verdict: "ship" });
    assertEquals(first.awaitingResume, false);
    await assertRejects(
      () => drain(h.service.resume(workflow.name, run.id)),
      UserError,
      "still waiting for a signal",
    );

    const second = await signalOk(h, waits[1].waitId, { verdict: "fix" });
    assertEquals(second.awaitingResume, true);
    await drain(h.service.resume(workflow.name, run.id));
    assertEquals((await reload(h, run)).status, "succeeded");
  });
});

Deno.test("signal wait: an expired iteration a resume no longer expands is timed out, not left waiting in a succeeded run", async () => {
  const perRegion = (name: string, allowFailure: boolean) =>
    Workflow.create({
      name,
      inputs: {
        properties: { regions: { type: "array", items: { type: "string" } } },
      },
      jobs: [
        Job.create({
          name: "release",
          steps: [
            Step.create({
              name: "review-${{ self.region }}",
              forEach: { item: "region", in: "${{ inputs.regions }}" },
              allowFailure,
              task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
            }),
          ],
        }),
      ],
    });
  const strict = perRegion("drops-strict", false);
  const lenient = perRegion("drops-lenient", true);
  await withHarness([strict, lenient], async (h) => {
    for (const workflow of [strict, lenient]) {
      await drain(
        h.service.run(workflow.name, { inputs: { regions: ["eu", "us"] } }),
      );
      const run = await only(h, workflow);
      await signalOk(h, waitIdOf(run, "review-eu"), { verdict: "ship" });
      await expireWaits(h, run);

      // The resume's collection no longer produces the "us" iteration.
      const events = await drain(
        h.service.resume(workflow.name, run.id, {
          inputs: { regions: ["eu"] },
        }),
      );

      const finished = await reload(h, run);
      const dropped = stepOf(finished, "review-us");
      assertEquals(dropped.status, "failed");
      assertEquals(dropped.error, WAIT_TIMEOUT_STEP_ERROR);
      const failed = events.find((e) =>
        e.kind === "step_failed" && e.stepId === "review-us"
      );
      assert(failed?.kind === "step_failed");
      assertEquals(failed.error, WAIT_TIMEOUT_STEP_ERROR);
      // allowFailure decides whether the dropped timeout fails the run.
      const allowed = workflow === lenient;
      assertEquals(dropped.allowedFailure, allowed);
      assertEquals(finished.status, allowed ? "succeeded" : "failed");
    }
  });
});

Deno.test("signal wait: a parent waiting on a nested run names the signal, and adopts the child once it finishes", async () => {
  const child = release("signalled-child");
  const parent = Workflow.create({
    name: "signalling-parent",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-nested",
            task: StepTask.workflow(child.name),
          }),
        ],
      }),
    ],
  });
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h, parent);
    const childRun = await only(h, child);
    const waitId = waitIdOf(childRun);
    assertEquals(parentRun.status, "suspended");

    const error = await assertRejects(
      () => drain(h.service.resume(parent.name, parentRun.id)),
    );
    assertStringIncludes(error instanceof Error ? error.message : "", waitId);
    assertStringIncludes(
      error instanceof Error ? error.message : "",
      "swamp workflow signal",
    );

    await signalOk(h, waitId, { verdict: "ship" });
    await drain(h.service.resume(child.name, childRun.id));
    await drain(h.service.resume(parent.name, parentRun.id));
    assertEquals((await reload(h, parentRun)).status, "succeeded");
  });
});

Deno.test("signal wait: a run its killed owner left suspended with a step running takes the signal and resumes", async () => {
  const workflow = Workflow.create({
    name: "abandoned",
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
          }),
          Step.create({
            name: "sibling",
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "ship",
            dependsOn: [
              { step: "review", condition: TriggerCondition.succeeded() },
              { step: "sibling", condition: TriggerCondition.succeeded() },
            ],
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    // What a kill -9 mid-level leaves: the record already says suspended,
    // and the sibling the dead process was running still says running.
    const data = run.toData();
    const sibling = data.jobs[0].steps.find((s) => s.stepName === "sibling")!;
    sibling.status = "running";
    sibling.completedAt = undefined;
    sibling.output = undefined;
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));
    h.executor.executed.length = 0;

    const send = async (ownerIsDead: boolean) => {
      let last: WorkflowSignalEvent | undefined;
      for await (
        const event of workflowSignal(
          createLibSwampContext(),
          createWorkflowSignalDeps(
            h.runRepo,
            unclaimedRuns,
            () => ownerIsDead,
          ),
          { waitId, payload: { verdict: "ship" }, submittedBy: "tester" },
        )
      ) {
        last = event;
      }
      return last!;
    };

    // While the owner lives the signal waits its turn, and says how to give up.
    const refused = await send(false);
    assert(refused.kind === "error");
    assertStringIncludes(refused.error.message, "has not suspended yet");
    assertStringIncludes(refused.error.message, "swamp workflow cancel");
    assertEquals(stepOf(await reload(h, run), "review").status, "waiting");

    const accepted = await send(true);
    assertEquals(accepted.kind, "completed");

    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "sibling").status, "succeeded");
    assertEquals(stepOf(finished, "ship").status, "succeeded");
    assertEquals(h.executor.executed, [
      `${workflow.name}/sibling`,
      `${workflow.name}/ship`,
    ]);
  });
});

Deno.test("signal wait: a schema reading inputs is resolved when the wait is captured", async () => {
  const workflow = Workflow.create({
    name: "schema-from-inputs",
    inputs: { properties: { allowed: { type: "string" } } },
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, {
              type: "object",
              additionalProperties: false,
              required: ["verdict"],
              properties: {
                verdict: { type: "string", enum: ["${{ inputs.allowed }}"] },
              },
            }),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name, { inputs: { allowed: "go" } }));
    const run = await only(h, workflow);
    const wait = stepOf(run, "review").signalWait;
    assert(wait, JSON.stringify(stepOf(run, "review").toData()));

    assertEquals(wait.schema.properties?.verdict.enum, ["go"]);
    const refused = await signalError(h, wait.id, { verdict: "ship" });
    assertStringIncludes(refused.message, "Payload refused");
    await signalOk(h, wait.id, { verdict: "go" });
  });
});

Deno.test("signal wait: a schema still holding an expression fails the step instead of opening a wait nobody can satisfy", async () => {
  const workflow = Workflow.create({
    name: "schema-from-self",
    inputs: {
      properties: { envs: { type: "array", items: { type: "string" } } },
    },
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review-${{ self.env }}",
            forEach: { item: "env", in: "${{ inputs.envs }}" },
            task: StepTask.waitForSignal(3600, {
              type: "object",
              properties: {
                env: { type: "string", enum: ["${{ self.env }}"] },
              },
            }),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    const events = await drain(
      h.service.run(workflow.name, { inputs: { envs: ["dev"] } }),
    );
    const run = await only(h, workflow);
    const review = stepOf(run, "review-dev");

    assertEquals(run.status, "failed");
    assertEquals(review.status, "failed");
    assertEquals(review.signalWait, undefined);
    assertStringIncludes(review.error ?? "", "was not resolved");
    assertStringIncludes(review.error ?? "", "self.env");
    assertEquals(
      events.some((e) => e.kind === "signal_wait_requested"),
      false,
    );
    assertEquals((await listWaits(h)).waits, []);
  });
});

Deno.test("signal wait: a stored wait that cannot be read is listed apart, takes no signal, and fails as unreadable on resume", async () => {
  const workflow = release("unreadable");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    // A hand-edited record: the wait no longer parses.
    const data = run.toData();
    data.jobs[0].steps[0].wait = { kind: "signal", id: "not-a-uuid" };
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));

    const listed = await listWaits(h);
    assertEquals(listed.waits, []);
    assertEquals(listed.unreadableWaits.length, 1);
    assertEquals(listed.unreadableWaits[0].stepName, "review");
    assertStringIncludes(
      listed.unreadableWaits[0].nextCommand,
      `swamp workflow resume ${workflow.name} --run ${run.id}`,
    );
    assertEquals(
      (await signalError(h, waitId, { verdict: "ship" })).code,
      "not_found",
    );

    const events = await drain(h.service.resume(workflow.name, run.id));
    const failed = events.find((e) =>
      e.kind === "step_failed" && e.stepId === "review"
    );
    assert(failed?.kind === "step_failed");
    assertEquals(failed.error, WAIT_UNREADABLE_STEP_ERROR);

    const finished = await reload(h, run);
    assertEquals(stepOf(finished, "review").error, WAIT_UNREADABLE_STEP_ERROR);
    // The value that could not be read is still on the record as written.
    assertEquals(stepOf(finished, "review").toData().wait, {
      kind: "signal",
      id: "not-a-uuid",
    });
    assertEquals(stepOf(finished, "escalate").status, "succeeded");
  });
});
