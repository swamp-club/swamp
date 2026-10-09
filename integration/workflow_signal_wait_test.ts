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
 * Integration tests for the wait_for_signal step task (swamp-club#3068,
 * swamp-club#3093): a run suspends on a wait, `workflow signal` delivers a
 * JSON payload by creating the wait's outcome record, and a resume applies
 * it as the step's output, or fails the step once the wait timed out.
 * Everything runs on real YAML repositories, the per-workflow run index and
 * the filesystem control-plane store, through the libswamp operations the
 * CLI calls.
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
  WAIT_KEY_HELD_STEP_ERROR,
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "../src/domain/workflows/signal_wait.ts";
import {
  claimWaitKey,
  type WaitKeyRecords,
  type WaitKeyRequest,
} from "../src/domain/workflows/wait_key_claim.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import {
  decideSignal,
  encodeWaitRecord,
  WAIT_RECORD_MAX_BYTES,
  type WaitOutcome,
  waitOutcomeKey,
} from "../src/domain/workflows/signal_wait_records.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../src/libswamp/workflows/history_get.ts";
import { mapWorkflowExecutionEvent } from "../src/libswamp/workflows/run.ts";
import { createRunGcDeps } from "../src/libswamp/data/run_gc.ts";
import {
  createWorkflowApproveDeps,
  workflowApprove,
} from "../src/libswamp/workflows/approve.ts";
import {
  createWorkflowCancelSuspendedDeps,
  workflowCancelSuspended,
} from "../src/libswamp/workflows/cancel_suspended.ts";
import {
  createWorkflowDeleteDeps,
  workflowDelete,
} from "../src/libswamp/workflows/delete.ts";
import {
  createWorkflowRejectDeps,
  workflowReject,
} from "../src/libswamp/workflows/reject.ts";
import {
  createWorkflowSignalDeps,
  workflowSignal,
  type WorkflowSignalData,
  type WorkflowSignalEvent,
} from "../src/libswamp/workflows/signal.ts";
import {
  createWorkflowWaitsDeps,
  workflowWaits,
  type WorkflowWaitsData,
} from "../src/libswamp/workflows/waits.ts";
import { supersedeSuspendedRuns } from "../src/libswamp/workflows/supersede.ts";
import type { InputsSchema } from "../src/domain/definitions/definition.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { unclaimedRuns } from "../src/domain/workflows/run_claim.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import type {
  SignalWaitStore,
  SignalWaitSupport,
} from "../src/domain/workflows/signal_wait_store.ts";
import {
  attachSignalWaits,
  requireInitializedRepoReadOnly,
  resolveSignalWaitSupport,
  signalWaitsOf,
} from "../src/cli/repo_context.ts";
import { resolveResumableRun } from "../src/domain/workflows/suspended_run_resolver.ts";

await initializeLogging({});

class RecordingExecutor implements StepExecutor {
  readonly executed: string[] = [];
  /** Runs while the named step executes, to order work against it. */
  during?: (stepName: string) => Promise<void>;
  async execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    this.executed.push(`${ctx.workflowName}/${ctx.stepName}`);
    await this.during?.(ctx.stepName);
    return { step: ctx.stepName };
  }
}

interface Harness {
  repoDir: string;
  catalogStore: CatalogStore;
  workflowRepo: YamlWorkflowRepository;
  runRepo: YamlWorkflowRunRepository;
  service: WorkflowExecutionService;
  executor: RecordingExecutor;
  /** The wait records of the repository's datastore, on the real filesystem. */
  waits: SignalWaitStore;
}

/**
 * A second repository context on the datastore of `h`: its own repositories
 * and wait store, built as another process or another checkout would build
 * them, sharing nothing in memory with the first.
 */
function secondContext(h: Harness): Harness {
  const runRepo = new YamlWorkflowRunRepository(h.repoDir);
  const support = waitSupportOf(h.repoDir);
  attachSignalWaits({ workflowRunRepo: runRepo }, support);
  return {
    ...h,
    workflowRepo: new YamlWorkflowRepository(h.repoDir),
    runRepo,
    waits: support.store,
  };
}

/**
 * A service as another process would build it: it did not start any run,
 * so a step it runs again looks for a wait that step registered before.
 */
function serviceOfAnotherProcess(h: Harness): WorkflowExecutionService {
  const service = new WorkflowExecutionService(
    h.workflowRepo,
    h.runRepo,
    h.repoDir,
    h.executor,
    undefined,
    h.catalogStore,
  );
  service.signalWaits = h.service.signalWaits;
  return service;
}

/** Wait support as the CLI resolves it for the default datastore. */
function waitSupportOf(
  repoDir: string,
): SignalWaitSupport & { supported: true } {
  // The default datastore stores run records itself, as the CLI finds.
  const support = resolveSignalWaitSupport(
    { type: "filesystem", path: join(repoDir, ".swamp") },
    undefined,
    { runsInDatastore: true },
  );
  assert(support.supported);
  return support;
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
    const support = waitSupportOf(repoDir);
    attachSignalWaits({ workflowRunRepo: runRepo }, support);
    const executor = new RecordingExecutor();
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
      executor,
      undefined,
      catalogStore,
    );
    service.signalWaits = support;
    await fn({
      repoDir,
      catalogStore,
      workflowRepo,
      runRepo,
      service,
      executor,
      waits: support.store,
    });
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
  options: { allowFailure?: boolean; reviewGuard?: string; key?: string } = {},
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
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA, options.key),
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
      createWorkflowSignalDeps(h.runRepo, { supported: true, store: h.waits }),
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
      createWorkflowWaitsDeps(h.runRepo, { supported: true, store: h.waits }),
    )
  ) {
    if (event.kind === "completed") return event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  throw new Error("no completed event");
}

/**
 * Moves the deadline of every wait the run holds into the past, in the run
 * record and in the wait's registration, as both would read once the
 * timeout had elapsed. Never sleeps.
 */
async function expireWaits(h: Harness, run: WorkflowRun): Promise<void> {
  const data = run.toData();
  for (const job of data.jobs) {
    for (const step of job.steps) {
      const wait = step.wait as { id?: string; deadline?: string } | undefined;
      if (!wait) continue;
      wait.deadline = "2020-01-01T00:00:00.000Z";
      if (!wait.id) continue;
      const registration = await h.waits.findRegistration(wait.id);
      if (registration.kind !== "found") continue;
      await h.waits.removeRegistration(wait.id);
      await h.waits.register({
        ...registration.record,
        deadline: wait.deadline,
      });
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
    assertEquals(stepOf(run, "review").status, "waiting_signal");
    assertEquals(h.executor.executed, []);
    // The executor registered the wait, so it can be signalled by its id.
    const registration = await h.waits.findRegistration(waitId);
    assert(registration.kind === "found");
    assertEquals(registration.record.runId, run.id);
    assertEquals(registration.record.stepName, "review");
    assertEquals(registration.record.schema, VERDICT_SCHEMA);

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
    assertEquals(
      stepOf(await reload(h, run), "review").status,
      "waiting_signal",
    );
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
    assertEquals(stepOf(after, "review").status, "waiting_signal");
    assertEquals(stepOf(after, "review").output, undefined);
    assertEquals(waitIdOf(after), waitId);
    assertEquals((await h.waits.findOutcome(waitId)).kind, "absent");
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

    // The signal is the wait's outcome record. The run record is untouched:
    // the step still waits there until a resume applies the outcome.
    const outcome = await h.waits.findOutcome(waitId);
    assert(outcome.kind === "found" && outcome.record.kind === "accepted");
    assertEquals(outcome.record.payload, sent);
    assertEquals(outcome.record.receipt, data.signal);
    const signalled = await reload(h, run);
    assertEquals(signalled.toData(), run.toData());
    assertEquals(stepOf(signalled, "review").status, "waiting_signal");
    assertEquals((await listWaits(h)).waits, []);

    // A second signal is refused and shown the stored receipt.
    const again = await signalError(h, waitId, { verdict: "abandon" });
    assertStringIncludes(again.message, "already settled");
    assertStringIncludes(again.message, data.signal.id);

    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    // The resume gave the step the payload exactly as sent and the receipt.
    assertEquals(stepOf(finished, "review").status, "succeeded");
    assertEquals(stepOf(finished, "review").output, {
      type: "wait_for_signal",
      payload: sent,
      signal: data.signal,
    });
    // The run ended: its registration is gone and its outcome kept, so a
    // late signal is still answered with the receipt.
    assertEquals((await h.waits.findRegistration(waitId)).kind, "absent");
    assertEquals((await h.waits.findOutcome(waitId)).kind, "found");
    assertStringIncludes(
      (await signalError(h, waitId, { verdict: "fix" })).message,
      data.signal.id,
    );
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
    assertEquals(
      stepOf(await reload(h, run), "review").status,
      "waiting_signal",
    );
    // The refusal settled the wait as timed out, so the resume and every
    // other reader decide the same way whatever their clocks say.
    const outcome = await h.waits.findOutcome(waitId);
    assert(outcome.kind === "found");
    assertEquals(outcome.record.kind, "timed_out");

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

    // A signal for the old attempt is told that wait expired, and is not
    // pointed at a resume: the step has moved on to a new wait.
    assertEquals((await h.waits.findRegistration(firstWaitId)).kind, "absent");
    const stale = await signalError(h, firstWaitId, { verdict: "ship" });
    assertStringIncludes(stale.message, "expired at");
    assertEquals(stale.message.includes("swamp workflow resume"), false);
    assertEquals((await listWaits(h)).waits.map((w) => w.waitId), [
      secondWaitId,
    ]);
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
    assertEquals(
      stepOf(await reload(h, run), "review").status,
      "waiting_signal",
    );

    // A signalled run is kept too: its step waits in the record until a
    // resume applies the signal, and cancelling it would discard one.
    const fresh = release("kept-after-signal");
    await h.workflowRepo.save(fresh);
    await drain(h.service.run(fresh.name));
    const freshRun = await only(h, fresh);
    const freshWaitId = waitIdOf(freshRun);
    await signalOk(h, freshWaitId, { verdict: "ship" });
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
    assertEquals(after.cancelledRunIds, []);
    assertEquals(after.skippedRuns, [{
      runId: freshRun.id,
      waitIds: [freshWaitId],
    }]);
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
        s.isSignalWait || s.status === "waiting_approval"
      ),
      [],
    );
    assertEquals(stepOf(cancelled, "review").status, "failed");
    assertEquals((await listWaits(h)).waits, []);
    // Saving the run as cancelled closed its wait first.
    assertEquals((await h.waits.findRegistration(waitId)).kind, "absent");
    const outcome = await h.waits.findOutcome(waitId);
    assert(outcome.kind === "found");
    assertEquals(outcome.record.kind, "cancelled");

    const closed = await signalError(h, waitId, { verdict: "ship" });
    assertStringIncludes(closed.message, "closed before a signal arrived");
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
    assertEquals(stepOf(run, "review").status, "waiting_signal");

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

Deno.test("signal wait: a signal is accepted while the owner still runs the level, and the resume waits until the owner is done or dead", async () => {
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

    // The run tracker as the owner leaves it mid-level: its row still says
    // running, under its pid.
    const tracker = RunTrackerStore.fromSwampDir(join(h.repoDir, ".swamp"));
    try {
      const ownerPid = 4242;
      tracker.register(
        ActiveRun.createWorkflowRun({
          id: run.id,
          workflowName: workflow.name,
          pid: ownerPid,
          hostname: "this-host",
        }),
      );
      let ownerDead = false;
      const resuming = new WorkflowExecutionService(
        h.workflowRepo,
        h.runRepo,
        h.repoDir,
        h.executor,
        undefined,
        h.catalogStore,
        undefined,
        undefined,
        undefined,
        undefined,
        tracker,
      );
      resuming.signalWaits = h.service.signalWaits;
      resuming.ownerLiveness = {
        hostname: "this-host",
        isDead: (pid) => pid === ownerPid && ownerDead,
      };

      // The signal no longer waits for the owner: it writes no run record,
      // so nothing the owner saves can erase it.
      await signalOk(h, waitId, { verdict: "ship" });
      assertEquals(
        stepOf(await reload(h, run), "review").status,
        "waiting_signal",
      );

      // The resume does wait: the owner still saves the record.
      const refused = await assertRejects(
        () => drain(resuming.resume(workflow.name, run.id)),
        UserError,
      );
      assertStringIncludes(refused.message, "has not finished suspending");
      assertEquals((await reload(h, run)).status, "suspended");
      assertEquals(h.executor.executed, []);

      // The owner was killed mid-level: the resume takes the run over and
      // runs the abandoned step again.
      ownerDead = true;
      await drain(resuming.resume(workflow.name, run.id));
    } finally {
      tracker.close();
    }
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
    // The wait is still registered, but its step could never take the
    // signal, so it is refused instead of accepted and lost.
    const refused = await signalError(h, waitId, { verdict: "ship" });
    assertStringIncludes(refused.message, "cannot be read");
    assertEquals((await h.waits.findOutcome(waitId)).kind, "absent");

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

/** A wait beside a sibling step in the same level, then a step after both. */
function waitBesideSibling(name: string): Workflow {
  return Workflow.create({
    name,
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
}

Deno.test("signal wait: a signal sent while a sibling of the level still runs survives every later save by the owner", async () => {
  const workflow = waitBesideSibling("during-drain");
  await withHarness([workflow], async (h) => {
    let delivered: WorkflowSignalData | undefined;
    // Ordered, not timed: the signal is sent from inside the sibling step,
    // after the wait opened and before the owner's remaining saves.
    h.executor.during = async (stepName) => {
      if (stepName !== "sibling" || delivered) return;
      // The steps of a level start together, so the sibling holds here
      // until the wait beside it has opened.
      await waitFor(
        async () => (await h.waits.listRegistrations()).length === 1,
        "the wait beside the sibling to be registered",
      );
      const [registration] = await h.waits.listRegistrations();
      delivered = await signalOk(h, registration.waitId, { verdict: "ship" });
    };

    await drain(h.service.run(workflow.name));

    assert(delivered);
    const suspended = await only(h, workflow);
    assertEquals(suspended.status, "suspended");
    assertEquals(stepOf(suspended, "sibling").status, "succeeded");
    // The owner's saves left the step waiting; the signal is not in them.
    assertEquals(stepOf(suspended, "review").status, "waiting_signal");
    const outcome = await h.waits.findOutcome(delivered.waitId);
    assert(outcome.kind === "found" && outcome.record.kind === "accepted");

    await drain(h.service.resume(workflow.name, suspended.id));
    const finished = await reload(h, suspended);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "review").output, {
      type: "wait_for_signal",
      payload: { verdict: "ship" },
      signal: delivered.signal,
    });
    assertEquals(h.executor.executed, [
      `${workflow.name}/sibling`,
      `${workflow.name}/ship`,
    ]);
  });
});

Deno.test("signal wait: a signal sent from a second repository context is applied by the next resume", async () => {
  const workflow = release("second-context");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const other = secondContext(h);

    // The second context finds the wait by listing, not by being told.
    const { waits } = await listWaits(other);
    assertEquals(waits.map((w) => w.waitId), [waitIdOf(run)]);
    const data = await signalOk(other, waits[0].waitId, { verdict: "ship" });

    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "review").output, {
      type: "wait_for_signal",
      payload: { verdict: "ship" },
      signal: data.signal,
    });
    assertEquals(stepOf(finished, "ship").status, "succeeded");
  });
});

Deno.test("signal wait: a signal against a timeout leaves one outcome, whichever is created first", async () => {
  const signalFirst = release("signal-then-deadline");
  const timeoutFirst = release("deadline-then-signal");
  await withHarness([signalFirst, timeoutFirst], async (h) => {
    // The signal is created first; the deadline passes before the resume.
    await drain(h.service.run(signalFirst.name));
    const signalled = await only(h, signalFirst);
    const data = await signalOk(h, waitIdOf(signalled), { verdict: "ship" });
    await expireWaits(h, signalled);
    assertEquals((await listWaits(h)).waits, []);
    await drain(h.service.resume(signalFirst.name, signalled.id));
    const shipped = await reload(h, signalled);
    assertEquals(stepOf(shipped, "review").status, "succeeded");
    assertEquals(stepOf(shipped, "ship").status, "succeeded");
    assertEquals(stepOf(shipped, "escalate").status, "skipped");

    // The timeout is created first, here by the listing; the signal loses.
    await drain(h.service.run(timeoutFirst.name));
    const expired = await only(h, timeoutFirst);
    const waitId = waitIdOf(expired);
    await expireWaits(h, expired);
    assertEquals((await listWaits(h)).waits.map((w) => w.expired), [true]);
    const refused = await signalError(h, waitId, { verdict: "ship" });
    assertStringIncludes(refused.message, "expired at");
    const outcome = await h.waits.findOutcome(waitId);
    assert(outcome.kind === "found");
    assertEquals(outcome.record.kind, "timed_out");
    await drain(h.service.resume(timeoutFirst.name, expired.id));
    const escalated = await reload(h, expired);
    assertEquals(stepOf(escalated, "review").error, WAIT_TIMEOUT_STEP_ERROR);
    assertEquals(stepOf(escalated, "escalate").status, "succeeded");
    // Nothing the first run stored was disturbed.
    assertEquals(
      (await signalError(h, data.waitId, { verdict: "fix" })).message.includes(
        data.signal.id,
      ),
      true,
    );
  });
});

Deno.test("signal wait: a signal against a cancel leaves one outcome, and the loser is answered from it", async () => {
  const workflow = release("signal-then-cancel");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    const data = await signalOk(h, waitId, { verdict: "ship" });

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

    // The cancel lost the create: the signal stays the wait's one outcome.
    assertEquals((await reload(h, run)).status, "cancelled");
    const outcome = await h.waits.findOutcome(waitId);
    assert(outcome.kind === "found" && outcome.record.kind === "accepted");
    assertEquals(outcome.record.receipt, data.signal);
    assertEquals((await h.waits.findRegistration(waitId)).kind, "absent");
    assertStringIncludes(
      (await signalError(h, waitId, { verdict: "fix" })).message,
      "already settled",
    );
  });
});

Deno.test("signal wait: a run suspended before waits were registered takes a signal and resumes", async () => {
  const workflow = release("earlier-build");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const fresh = await only(h, workflow);
    const waitId = waitIdOf(fresh);
    // The record as swamp-club#3068 wrote it: status `waiting`, the wait on
    // the step, and nothing in the control-plane store.
    const data = fresh.toData();
    data.jobs[0].steps.find((s) => s.stepName === "review")!.status = "waiting";
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));
    await h.waits.removeRegistration(waitId);
    const run = await reload(h, fresh);
    assertEquals(stepOf(run, "review").status, "waiting");

    assertEquals((await listWaits(h)).waits.map((w) => w.waitId), [waitId]);
    await h.waits.removeRegistration(waitId);
    const sent = await signalOk(h, waitId, { verdict: "ship" });
    assertEquals(sent.stepName, "review");

    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "review").output, {
      type: "wait_for_signal",
      payload: { verdict: "ship" },
      signal: sent.signal,
    });
    assertEquals(stepOf(finished, "ship").status, "succeeded");
  });
});

for (const corruption of ["payload", "receipt", "outcome"] as const) {
  for (const allowFailure of [false, true]) {
    Deno.test(`signal wait: unusable accepted ${corruption} fails on resume with allowFailure=${allowFailure}`, async () => {
      const workflow = release("forged-outcome", { allowFailure });
      await withHarness([workflow], async (h) => {
        await drain(h.service.run(workflow.name));
        const run = await only(h, workflow);
        const waitId = waitIdOf(run);
        const wait = stepOf(run, "review").signalWait!;
        const outcome: WaitOutcome = {
          kind: "accepted",
          waitId: corruption === "outcome" ? crypto.randomUUID() : waitId,
          workflowId: run.workflowId,
          runId: run.id,
          deadline: wait.deadline.toISOString(),
          settledAt: new Date().toISOString(),
          receipt: {
            id: crypto.randomUUID(),
            waitId: corruption === "receipt" ? crypto.randomUUID() : waitId,
            receivedAt: new Date().toISOString(),
            submittedBy: "nobody",
          },
          payload: corruption === "payload"
            ? { verdict: "ship", constructor: { prototype: {} } }
            : { verdict: "ship" },
        };
        // Model a malformed write from another datastore writer, including
        // an outcome whose ID disagrees with the key it was stored under.
        const backing = new FileSystemControlPlaneStore(
          join(h.repoDir, ".swamp"),
        );
        const bytes = encodeWaitRecord(outcome);
        await backing.put(waitOutcomeKey(waitId), bytes);

        const events = await drain(h.service.resume(workflow.name, run.id));
        const failed = events.find((e) =>
          e.kind === "step_failed" && e.stepId === "review"
        );
        assert(failed?.kind === "step_failed");
        assertEquals(failed.error, WAIT_UNREADABLE_STEP_ERROR);
        assertEquals(failed.allowedFailure, allowFailure || undefined);
        assertEquals(
          events.some((e) => e.kind === "signal_wait_requested"),
          false,
        );
        const finished = await reload(h, run);
        assertEquals(finished.status, allowFailure ? "succeeded" : "failed");
        assertEquals(stepOf(finished, "review").output, undefined);
        assertEquals(stepOf(finished, "ship").status, "skipped");
        assertEquals(stepOf(finished, "escalate").status, "succeeded");
        assertEquals(h.executor.executed, [`${workflow.name}/escalate`]);
        assertEquals(await backing.get(waitOutcomeKey(waitId)), bytes);
      });
    });
  }
}

Deno.test("signal wait: a workflow with a wait is refused before anything runs where wait records cannot be shared", async () => {
  const workflow = waitBesideSibling("unsupported");
  await withHarness([workflow], async (h) => {
    h.service.signalWaits = {
      supported: false,
      reason:
        'the "@acme/bucket" datastore has no control-plane store shared between hosts',
    };

    const events: WorkflowExecutionEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of h.service.run(workflow.name)) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error
      ? thrown.message
      : JSON.stringify(events.at(-1));
    assertStringIncludes(message, "waits for a signal");
    assertStringIncludes(message, "@acme/bucket");
    assertEquals(h.executor.executed, []);
    assertEquals(await h.runRepo.findAllByWorkflowId(workflow.id), []);
    assertEquals(await h.waits.listRegistrations(), []);
  });
});

Deno.test("signal wait: a resume after an approval is refused while the owner still runs the level", async () => {
  const workflow = Workflow.create({
    name: "gate-during-drain",
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve the release"),
          }),
          Step.create({
            name: "after",
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    for await (
      const event of workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        { workflowIdOrName: workflow.name, stepName: "gate" },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    const tracker = RunTrackerStore.fromSwampDir(join(h.repoDir, ".swamp"));
    try {
      const ownerPid = 4242;
      tracker.register(
        ActiveRun.createWorkflowRun({
          id: run.id,
          workflowName: workflow.name,
          pid: ownerPid,
          hostname: "this-host",
        }),
      );
      const resuming = new WorkflowExecutionService(
        h.workflowRepo,
        h.runRepo,
        h.repoDir,
        h.executor,
        undefined,
        h.catalogStore,
        undefined,
        undefined,
        undefined,
        undefined,
        tracker,
      );
      resuming.signalWaits = h.service.signalWaits;
      resuming.ownerLiveness = { hostname: "this-host", isDead: () => false };

      const refused = await assertRejects(
        () => drain(resuming.resume(workflow.name, run.id)),
        UserError,
      );
      assertStringIncludes(refused.message, "has not finished suspending");
      // It says what to do: the owner's last save can drop the approval.
      assertStringIncludes(refused.message, "must be given again");
      assertEquals(h.executor.executed, []);

      // The owner finished the level and marked its row suspended.
      tracker.complete(run.id, "suspended");
      await drain(resuming.resume(workflow.name, run.id));
    } finally {
      tracker.close();
    }
    assertEquals((await reload(h, run)).status, "succeeded");
    assertEquals(h.executor.executed, [`${workflow.name}/after`]);
  });
});

Deno.test("signal wait: deleting a workflow removes the wait records of its runs and no others", async () => {
  const doomed = release("doomed");
  const kept = release("kept");
  await withHarness([doomed, kept], async (h) => {
    await drain(h.service.run(doomed.name));
    await drain(h.service.run(kept.name));
    const doomedRun = await only(h, doomed);
    const keptRun = await only(h, kept);
    await signalOk(h, waitIdOf(doomedRun), { verdict: "ship" });
    await signalOk(h, waitIdOf(keptRun), { verdict: "ship" });

    for await (
      const event of workflowDelete(
        createLibSwampContext(),
        createWorkflowDeleteDeps(h.repoDir, undefined, undefined, undefined, {
          supported: true,
          store: h.waits,
        }),
        { workflowIdOrName: doomed.name },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    assertEquals(await h.runRepo.findAllByWorkflowId(doomed.id), []);
    const doomedWait = waitIdOf(doomedRun);
    assertEquals((await h.waits.findRegistration(doomedWait)).kind, "absent");
    assertEquals((await h.waits.findOutcome(doomedWait)).kind, "absent");
    const keptWait = waitIdOf(keptRun);
    assertEquals((await h.waits.findRegistration(keptWait)).kind, "found");
    assertEquals((await h.waits.findOutcome(keptWait)).kind, "found");
  });
});

Deno.test("signal wait: collecting a run removes its outcome with it, and keeps the outcome of a run that stays", async () => {
  const old = release("collected");
  const live = release("still-waiting");
  await withHarness([old, live], async (h) => {
    await drain(h.service.run(old.name));
    const oldRun = await only(h, old);
    const oldWait = waitIdOf(oldRun);
    await signalOk(h, oldWait, { verdict: "ship" });
    await drain(h.service.resume(old.name, oldRun.id));
    assertEquals((await reload(h, oldRun)).status, "succeeded");
    // The run ended: its outcome is kept for as long as its record.
    assertEquals((await h.waits.findOutcome(oldWait)).kind, "found");

    await drain(h.service.run(live.name));
    const liveRun = await only(h, live);
    const liveWait = waitIdOf(liveRun);
    await signalOk(h, liveWait, { verdict: "ship" });

    const gc = createRunGcDeps(h.repoDir, undefined, undefined, {
      supported: true,
      store: h.waits,
    });
    const result = await gc.gcAll({
      workflowRunRetentionDays: 0,
      outputRetentionDays: 0,
      dryRun: false,
    });

    assertEquals(result.workflowRunsDeleted, 1);
    assertEquals(await h.runRepo.findAllByWorkflowId(old.id), []);
    assertEquals((await h.waits.findOutcome(oldWait)).kind, "absent");
    // A suspended run is never collected, and neither are its records.
    assertEquals((await reload(h, liveRun)).status, "suspended");
    assertEquals((await h.waits.findRegistration(liveWait)).kind, "found");
    assertEquals((await h.waits.findOutcome(liveWait)).kind, "found");
  });
});

for (const namespace of [undefined, "team-a"]) {
  for (const cache of ["empty", "stale"] as const) {
    Deno.test(`signal wait: ${cache} custom datastore cache preserves old shared outcomes (namespace=${namespace})`, async () => {
      const workflow = release("shared-outcome");
      await withHarness([workflow], async (h) => {
        const remoteRoot = join(h.repoDir, "remote");
        const cacheDir = join(h.repoDir, "second-host");
        const supportFor = (repoDir: string) =>
          resolveSignalWaitSupport({
            type: "@test/shared",
            config: {},
            datastorePath: "test://shared",
            cachePath: join(repoDir, ".swamp"),
            namespace,
          }, {
            capabilities: () => ({ controlPlane: true }),
            controlPlaneStore: () =>
              new FileSystemControlPlaneStore(
                namespace ? join(remoteRoot, namespace) : remoteRoot,
              ),
            // A pull need not hydrate the owner run into this host's cache.
            pullChanged: () => Promise.resolve(0),
            pushChanged: () => Promise.resolve(0),
            markDirty: () => Promise.resolve(),
          });
        const ownerSupport = supportFor(h.repoDir);
        assert(ownerSupport.supported);
        h.waits = ownerSupport.store;
        h.service.signalWaits = ownerSupport;
        attachSignalWaits({ workflowRunRepo: h.runRepo }, ownerSupport);
        await drain(h.service.run(workflow.name));
        const run = await only(h, workflow);
        // The authoritative wait and its registration are now years past
        // their deadlines; the accepted signal arrived before that deadline.
        await expireWaits(h, run);
        const waitId = waitIdOf(run);
        const registration = await h.waits.findRegistration(waitId);
        assert(registration.kind === "found");
        const decision = decideSignal(
          registration.record,
          { verdict: "ship" },
          "ada",
          new Date("2019-12-31T23:59:59.000Z"),
        );
        assert(decision.accepted);
        await h.waits.settle(decision.outcome);
        const expectedOutcome = await h.waits.findOutcome(waitId);

        const otherSupport = supportFor(cacheDir);
        assert(otherSupport.supported);
        assertEquals(otherSupport.localRunAbsenceIsAuthoritative, undefined);
        const otherRepo = new YamlWorkflowRunRepository(cacheDir);
        if (cache === "stale") {
          // This host knows the suspended run but has never seen its signal.
          await otherRepo.save(workflow.id, await reload(h, run));
        }
        const deps = createWorkflowWaitsDeps(otherRepo, otherSupport);
        for await (
          const event of workflowWaits(createLibSwampContext(), deps)
        ) {
          assert(event.kind !== "error");
          if (event.kind === "completed") assertEquals(event.data.waits, []);
        }
        assertEquals(await h.waits.findRegistration(waitId), registration);
        assertEquals(await h.waits.findOutcome(waitId), expectedOutcome);
        const gc = createRunGcDeps(
          cacheDir,
          undefined,
          undefined,
          otherSupport,
        );
        await gc.gcAll({
          workflowRunRetentionDays: 0,
          outputRetentionDays: 0,
          dryRun: false,
        });
        assertEquals(await h.waits.findRegistration(waitId), registration);
        assertEquals(await h.waits.findOutcome(waitId), expectedOutcome);

        await drain(h.service.resume(workflow.name, run.id));
        const finished = await reload(h, run);
        assertEquals(finished.status, "succeeded");
        assertEquals(stepOf(finished, "review").output, {
          type: "wait_for_signal",
          payload: { verdict: "ship" },
          signal: decision.outcome.receipt,
        });
        assertEquals(await h.waits.findOutcome(waitId), expectedOutcome);
      });
    });
  }
}

Deno.test("signal wait: filesystem listing and GC remove authoritative orphans after the grace period", async () => {
  for (const action of ["list", "gc"]) {
    const workflow = release("orphan");
    await withHarness([workflow], async (h) => {
      await drain(h.service.run(workflow.name));
      const run = await only(h, workflow);
      await expireWaits(h, run);
      const waitId = waitIdOf(run);
      const registration = await h.waits.findRegistration(waitId);
      assert(registration.kind === "found");
      const decision = decideSignal(
        registration.record,
        { verdict: "ship" },
        "ada",
        new Date("2019-12-31T23:59:59.000Z"),
      );
      assert(decision.accepted);
      await h.waits.settle(decision.outcome);
      await h.runRepo.deleteAllByWorkflowId(workflow.id);
      const support = waitSupportOf(h.repoDir);
      if (action === "list") {
        for await (
          const event of workflowWaits(
            createLibSwampContext(),
            createWorkflowWaitsDeps(h.runRepo, support),
          )
        ) {
          assert(event.kind !== "error");
        }
      } else {
        await createRunGcDeps(h.repoDir, undefined, undefined, support).gcAll({
          workflowRunRetentionDays: 0,
          outputRetentionDays: 0,
          dryRun: false,
        });
      }
      assertEquals((await h.waits.findRegistration(waitId)).kind, "absent");
      assertEquals((await h.waits.findOutcome(waitId)).kind, "absent");
    });
  }
});

Deno.test("signal wait: oversized enum registrations fail normally before suspension and a smaller schema accepts signals", async () => {
  for (const large of [true, false]) {
    const schema: InputsSchema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: {
          type: "string",
          enum: large
            ? [
              "ship",
              ...Array.from({ length: 20000 }, (_, i) => `choice-${i}-🐸`),
            ]
            : ["ship"],
        },
      },
    };
    const workflow = Workflow.create({
      name: "enum-registration",
      jobs: [Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, schema),
          }),
        ],
      })],
    });
    await withHarness([workflow], async (h) => {
      const events = await drain(h.service.run(workflow.name));
      const run = await only(h, workflow);
      const review = stepOf(run, "review");
      if (large) {
        assertEquals(run.status, "failed");
        assertEquals(review.status, "failed");
        assertEquals(review.signalWait, undefined);
        assertStringIncludes(
          review.error ?? "",
          `over the ${WAIT_RECORD_MAX_BYTES} byte limit`,
        );
        assertEquals(
          events.some((e) => e.kind === "signal_wait_requested"),
          false,
        );
        assert(
          events.some((e) => e.kind === "step_failed" && e.stepId === "review"),
        );
        assertEquals(await h.waits.listRegistrations(), []);
        assertEquals(await h.waits.listOutcomes(), []);
      } else {
        assertEquals(run.status, "suspended");
        await signalOk(h, waitIdOf(run), { verdict: "ship" });
        await drain(h.service.resume(workflow.name, run.id));
        assertEquals((await reload(h, run)).status, "succeeded");
      }
    });
  }
});

Deno.test("signal wait: a step that runs again after its process died takes over the wait it had registered, so a signal accepted in between is applied", async () => {
  const workflow = release("crashed-after-registering");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    // What a kill between registering the wait and saving the run leaves,
    // once recovered: the registration exists, and the record shows the
    // step not started, with no wait.
    const data = run.toData();
    const review = data.jobs[0].steps.find((s) => s.stepName === "review")!;
    review.status = "pending";
    review.startedAt = undefined;
    review.wait = undefined;
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));
    assertEquals((await listWaits(h)).waits.map((w) => w.waitId), [waitId]);

    const sent = await signalOk(h, waitId, { verdict: "ship" });

    // The step runs again and waits on the same wait, not a new one.
    await drain(serviceOfAnotherProcess(h).resume(workflow.name, run.id));
    const again = await reload(h, run);
    assertEquals(again.status, "suspended");
    assertEquals(waitIdOf(again), waitId);
    assertEquals((await h.waits.listRegistrations()).length, 1);

    await drain(serviceOfAnotherProcess(h).resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(finished.status, "succeeded");
    assertEquals(stepOf(finished, "review").output, {
      type: "wait_for_signal",
      payload: { verdict: "ship" },
      signal: sent.signal,
    });
    assertEquals(stepOf(finished, "ship").status, "succeeded");
  });
});

Deno.test("signal wait: a step that runs again does not take over a wait that expired unsignalled; it opens a new one", async () => {
  const workflow = release("crashed-then-expired");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const oldWaitId = waitIdOf(run);
    await expireWaits(h, run);
    const data = (await reload(h, run)).toData();
    const review = data.jobs[0].steps.find((s) => s.stepName === "review")!;
    review.status = "pending";
    review.startedAt = undefined;
    review.wait = undefined;
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));

    await drain(serviceOfAnotherProcess(h).resume(workflow.name, run.id));

    const again = await reload(h, run);
    const newWaitId = waitIdOf(again);
    assertNotEquals(newWaitId, oldWaitId);
    assertEquals(
      (await h.waits.listRegistrations()).map((r) => r.waitId),
      [newWaitId],
    );
    // The old wait is closed, so a signal for it is answered, not accepted.
    assertStringIncludes(
      (await signalError(h, oldWaitId, { verdict: "ship" })).message,
      "closed before a signal arrived",
    );
    await signalOk(h, newWaitId, { verdict: "ship" });
  });
});

Deno.test("signal wait: a store that turns out unusable when opened refuses the workflow before anything runs", async () => {
  const workflow = waitBesideSibling("unusable-store");
  await withHarness([workflow], async (h) => {
    h.service.signalWaits = {
      supported: true,
      store: h.waits,
      ready: () =>
        Promise.reject(
          new UserError("the store cannot create a record atomically"),
        ),
    };

    const error = await assertRejects(
      () => drain(h.service.run(workflow.name)),
      Error,
    );

    assertStringIncludes(error.message, "waits for a signal");
    assertStringIncludes(error.message, "cannot create a record atomically");
    assertEquals(h.executor.executed, []);
    assertEquals(await h.runRepo.findAllByWorkflowId(workflow.id), []);
  });
});

Deno.test("signal wait: a run left waiting on a datastore that cannot hold wait records still times out on resume, and is refused until then", async () => {
  const workflow = release("unsupported-leftover");
  await withHarness([workflow], async (h) => {
    // Suspended while waits were supported, as by an earlier build.
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    h.service.signalWaits = {
      supported: false,
      reason: "the datastore has no control-plane store shared between hosts",
    };

    const refused = await assertRejects(
      () => drain(h.service.resume(workflow.name, run.id)),
      UserError,
    );
    assertStringIncludes(refused.message, "cannot deliver one");
    assertStringIncludes(refused.message, "cancel the run");
    assertEquals((await reload(h, run)).status, "suspended");

    // Past the deadline the failed handler still runs.
    await expireWaits(h, run);
    await drain(h.service.resume(workflow.name, run.id));
    const finished = await reload(h, run);
    assertEquals(stepOf(finished, "review").error, WAIT_TIMEOUT_STEP_ERROR);
    assertEquals(stepOf(finished, "escalate").status, "succeeded");
  });
});

Deno.test("signal wait: a new run opens its waits without reading every registration, and a resumed run looks for one to take over", async () => {
  const workflow = release("no-scan-on-new-run");
  await withHarness([workflow], async (h) => {
    let listed = 0;
    const counting: SignalWaitStore = {
      register: (r) => h.waits.register(r),
      findRegistration: (id) => h.waits.findRegistration(id),
      listRegistrations: () => {
        listed++;
        return h.waits.listRegistrations();
      },
      findOutcome: (id) => h.waits.findOutcome(id),
      listOutcomes: () => h.waits.listOutcomes(),
      settle: (o) => h.waits.settle(o),
      removeRegistration: (id) => h.waits.removeRegistration(id),
      removeOutcome: (id) => h.waits.removeOutcome(id),
      highestKeyRecord: (w, k) => h.waits.highestKeyRecord(w, k),
      createKeyRecord: (r) => h.waits.createKeyRecord(r),
      listKeyRecords: () => h.waits.listKeyRecords(),
      removeKeyRecord: (at) => h.waits.removeKeyRecord(at),
      removeKeyRecordsOfWorkflow: (w) => h.waits.removeKeyRecordsOfWorkflow(w),
    };
    h.service.signalWaits = { supported: true, store: counting };

    await drain(h.service.run(workflow.name));
    assertEquals(listed, 0);

    // A step that runs again in a run taken up later does look.
    const run = await only(h, workflow);
    const data = run.toData();
    const review = data.jobs[0].steps.find((s) => s.stepName === "review")!;
    review.status = "pending";
    review.startedAt = undefined;
    review.wait = undefined;
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));
    const resuming = new WorkflowExecutionService(
      h.workflowRepo,
      h.runRepo,
      h.repoDir,
      h.executor,
      undefined,
      h.catalogStore,
    );
    resuming.signalWaits = { supported: true, store: counting };
    await drain(resuming.resume(workflow.name, run.id));
    assertEquals(listed, 1);
    assertEquals(waitIdOf(await reload(h, run)), waitIdOf(run));
  });
});

Deno.test("signal wait: a resume opens the wait store before anything runs, and a network failure is not reported as a missing capability", async () => {
  const workflow = Workflow.create({
    name: "gate-then-wait",
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
          Step.create({
            name: "build",
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "review",
            dependsOn: [{
              step: "build",
              condition: TriggerCondition.succeeded(),
            }],
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
          }),
        ],
      }),
    ],
  });
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    for await (
      const event of workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        { workflowIdOrName: workflow.name, stepName: "gate" },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    // The store turns out not to be usable: a refusal naming the workflow.
    h.service.signalWaits = {
      supported: true,
      store: h.waits,
      ready: () =>
        Promise.reject(new UserError("the store cannot create atomically")),
    };
    const refused = await assertRejects(
      () => drain(h.service.resume(workflow.name, run.id)),
      UserError,
    );
    assertStringIncludes(refused.message, "cannot support");
    assertEquals(h.executor.executed, []);
    assertEquals((await reload(h, run)).status, "suspended");

    // The network is down: passed on as it is.
    h.service.signalWaits = {
      supported: true,
      store: h.waits,
      ready: () => Promise.reject(new Error("connection reset")),
    };
    const failed = await assertRejects(
      () => drain(h.service.resume(workflow.name, run.id)),
      Error,
      "connection reset",
    );
    assertEquals(failed.message.includes("cannot support"), false);
    assertEquals(h.executor.executed, []);
  });
});

/** A workflow whose one step runs `child` as a nested workflow. */
function calling(name: string, child: Workflow, gate = false): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-nested",
            task: StepTask.workflow(child.name),
          }),
          ...(gate
            ? [
              Step.create({
                name: "gate",
                task: StepTask.manualApproval("Ship it?"),
              }),
            ]
            : []),
        ],
      }),
    ],
  });
}

function suspendedOf(events: WorkflowExecutionEvent[]) {
  const suspended = events.findLast((e) => e.kind === "suspended");
  assert(suspended?.kind === "suspended");
  return suspended;
}

Deno.test("signal wait: a parent's suspension names the open wait of its nested run, and publishes it (swamp-club#3110)", async () => {
  const child = release("named-child");
  const parent = calling("naming-parent", child);
  await withHarness([parent, child], async (h) => {
    const events = await drain(h.service.run(parent.name));
    const childRun = await only(h, child);
    const wait = stepOf(childRun, "review").signalWait!;

    const suspended = suspendedOf(events);
    assertEquals(suspended.nested?.runId, childRun.id);
    assertEquals(suspended.nestedSignalWaits, [{
      workflowId: child.id,
      workflowName: child.name,
      runId: childRun.id,
      jobId: "release",
      stepId: "review",
      waitId: wait.id,
      deadline: wait.deadline.toISOString(),
    }]);

    // What a client is sent: the wait is in the suspended event, which is
    // the only place a run on a server learns of it.
    const published = mapWorkflowExecutionEvent(suspended, h.runRepo);
    assert(published.kind === "suspended");
    assertEquals(published.nestedSignalWaits, suspended.nestedSignalWaits);
  });
});

Deno.test("signal wait: a parent's suspension names a wait two levels down, under the workflow it belongs to", async () => {
  const leaf = release("leaf");
  const middle = calling("middle", leaf);
  const top = calling("top", middle);
  await withHarness([top, middle, leaf], async (h) => {
    const events = await drain(h.service.run(top.name));
    const leafRun = await only(h, leaf);
    const middleRun = await only(h, middle);

    const suspended = suspendedOf(events);
    assertEquals(suspended.nested?.runId, middleRun.id);
    assertEquals(
      suspended.nestedSignalWaits?.map((w) => [
        w.workflowId,
        w.workflowName,
        w.runId,
        w.waitId,
      ]),
      [[leaf.id, leaf.name, leafRun.id, waitIdOf(leafRun)]],
    );
  });
});

Deno.test("signal wait: a parent suspended on its own gate still names its nested run's wait", async () => {
  const child = release("beside-gate-child");
  const parent = calling("gated-parent", child, true);
  await withHarness([parent, child], async (h) => {
    const events = await drain(h.service.run(parent.name));
    const childRun = await only(h, child);

    const suspended = suspendedOf(events);
    assertEquals(suspended.stepId, "gate");
    assertEquals(suspended.nested, undefined);
    assertEquals(
      suspended.nestedSignalWaits?.map((w) => w.waitId),
      [waitIdOf(childRun)],
    );
  });
});

Deno.test("signal wait: a suspension names no nested wait once the wait is signalled, and none for a run with no nested run", async () => {
  const child = release("settled-child");
  const parent = calling("settled-parent", child);
  await withHarness([parent, child], async (h) => {
    // A run of the child alone holds a wait of its own, and no nested one.
    const alone = suspendedOf(await drain(h.service.run(child.name)));
    assertEquals(alone.wait !== undefined, true);
    assertEquals(alone.nestedSignalWaits, undefined);
  });
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h, parent);
    const childRun = await only(h, child);
    await signalOk(h, waitIdOf(childRun), { verdict: "ship" });

    // The child now needs a resume, not a signal: the refusal names no wait.
    const error = await assertRejects(
      () => drain(h.service.resume(parent.name, parentRun.id)),
    );
    const message = error instanceof Error ? error.message : "";
    assertEquals(message.includes("swamp workflow signal"), false);
    assertStringIncludes(
      message,
      `swamp workflow resume ${child.name} --run ${childRun.id}`,
    );
  });
});

Deno.test("signal wait: history get and the waits listing show a signal before the resume applies it", async () => {
  const workflow = release("receipt-shown");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const waitId = waitIdOf(run);
    const support = { supported: true as const, store: h.waits };

    const view = async () => {
      for await (
        const event of workflowHistoryGet(
          createLibSwampContext(),
          createWorkflowHistoryGetDeps(
            h.repoDir,
            undefined,
            h.workflowRepo,
            undefined,
            support,
          ),
          run.id,
        )
      ) {
        if (event.kind === "completed") return event.data;
        if (event.kind === "error") throw new Error(event.error.message);
      }
      throw new Error("no completed event");
    };
    const listed = async () => {
      for await (
        const event of workflowWaits(
          createLibSwampContext(),
          createWorkflowWaitsDeps(h.runRepo, support),
          { includeSignalled: true },
        )
      ) {
        if (event.kind === "completed") return event.data;
        if (event.kind === "error") throw new Error(event.error.message);
      }
      throw new Error("no completed event");
    };
    const reviewOf = (data: Awaited<ReturnType<typeof view>>) =>
      data.jobs[0].steps.find((s) => s.name === "review")!;

    assertEquals(reviewOf(await view()).wait?.receipt, undefined);
    assertEquals((await listed()).signalled, []);

    const delivered = await signalOk(h, waitId, { verdict: "ship" });

    const review = reviewOf(await view());
    assertEquals(review.status, "waiting");
    assertEquals(review.wait?.receipt?.id, delivered.signal.id);
    const after = await listed();
    assertEquals(after.waits, []);
    assertEquals(
      after.signalled?.map((w) => [w.waitId, w.signal.id, w.awaitingResume]),
      [[waitId, delivered.signal.id, true]],
    );
    // Neither read wrote the run: its step still waits until the resume.
    assertEquals(
      stepOf(await reload(h, run), "review").status,
      "waiting_signal",
    );

    await drain(h.service.resume(workflow.name, run.id));
    assertEquals((await listed()).signalled, []);
  });
});

/** The refusal `workflow resume` gives before it starts anything. */
async function resumeRefusal(
  h: Harness,
  parent: Workflow,
  parentRun: WorkflowRun,
  signalWaits?: SignalWaitSupport,
): Promise<string> {
  const error = await assertRejects(() =>
    resolveResumableRun(
      h.workflowRepo,
      h.runRepo,
      parent.name,
      parentRun.id,
      { signalWaits },
    )
  );
  return error instanceof Error ? error.message : "";
}

Deno.test("signal wait: the refusal to resume a parent asks the wait store, so a signalled nested wait is not named again", async () => {
  const child = release("asked-child");
  const parent = calling("asking-parent", child);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h, parent);
    const childRun = await only(h, child);
    const waitId = waitIdOf(childRun);
    const support = { supported: true as const, store: h.waits };

    assertStringIncludes(
      await resumeRefusal(h, parent, parentRun, support),
      `swamp workflow signal ${waitId}`,
    );

    await signalOk(h, waitId, { verdict: "ship" });

    const settled = await resumeRefusal(h, parent, parentRun, support);
    assertEquals(settled.includes("swamp workflow signal"), false);
    assertStringIncludes(settled, "is ready to resume");
    assertStringIncludes(
      settled,
      `swamp workflow resume ${child.name} --run ${childRun.id}`,
    );
    // Without the store only the child's record is read, which shows the
    // wait open until the child is resumed.
    assertStringIncludes(
      await resumeRefusal(h, parent, parentRun),
      `swamp workflow signal ${waitId}`,
    );
  });
});

Deno.test("signal wait: with two nested waits, the refusal names the one still open after the first is signalled", async () => {
  const child = Workflow.create({
    name: "two-waits-child",
    jobs: [
      Job.create({
        name: "release",
        steps: ["first", "second"].map((name) =>
          Step.create({
            name,
            allowFailure: true,
            task: StepTask.waitForSignal(3600, VERDICT_SCHEMA),
          })
        ),
      }),
    ],
  });
  const parent = calling("two-waits-parent", child);
  await withHarness([parent, child], async (h) => {
    await drain(h.service.run(parent.name));
    const parentRun = await only(h, parent);
    const childRun = await only(h, child);
    const first = waitIdOf(childRun, "first");
    const second = waitIdOf(childRun, "second");
    const support = { supported: true as const, store: h.waits };

    assertStringIncludes(
      await resumeRefusal(h, parent, parentRun, support),
      `swamp workflow signal ${first}`,
    );
    await signalOk(h, first, { verdict: "ship" });

    const refusal = await resumeRefusal(h, parent, parentRun, support);
    assertStringIncludes(refusal, `swamp workflow signal ${second}`);
    assertEquals(refusal.includes(first), false);
  });
});

Deno.test("signal wait: a read-only repository context shows a signal's receipt, as workflow history get builds it", async () => {
  const workflow = release("read-only-receipt");
  await withHarness([workflow], async (h) => {
    await drain(h.service.run(workflow.name));
    const run = await only(h, workflow);
    const delivered = await signalOk(h, waitIdOf(run), { verdict: "ship" });

    // The context and dependencies exactly as the command wires them.
    const { repoDir, repoContext, datastoreResolver } =
      await requireInitializedRepoReadOnly({
        repoDir: h.repoDir,
        outputMode: "json",
      });
    const support = signalWaitsOf(repoContext);
    assertEquals(support.supported, true);
    const deps = createWorkflowHistoryGetDeps(
      repoDir,
      datastoreResolver,
      repoContext.workflowRepo,
      undefined,
      support,
    );

    let receiptId: string | undefined;
    for await (
      const event of workflowHistoryGet(createLibSwampContext(), deps, run.id)
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
      if (event.kind === "completed") {
        receiptId = event.data.jobs[0].steps.find((s) => s.name === "review")
          ?.wait?.receipt?.id;
      }
    }
    assertEquals(receiptId, delivered.signal.id);
  });
});

Deno.test("signal wait: a run still suspends, naming no nested wait, when its nested run cannot be read back", async () => {
  const child = release("unreadable-child");
  const parent = calling("unreadable-parent", child);
  await withHarness([parent, child], async (h) => {
    // The nested step holds the child in memory; only the walk that names
    // its wait reads it back from the repository.
    const original = h.runRepo.findById.bind(h.runRepo);
    h.runRepo.findById = (workflowId, runId) =>
      workflowId === child.id
        ? Promise.reject(new Error("run record cannot be read"))
        : original(workflowId, runId);

    const events = await drain(h.service.run(parent.name));

    const suspended = suspendedOf(events);
    assertEquals(suspended.nested !== undefined, true);
    assertEquals(suspended.nestedSignalWaits, undefined);
    h.runRepo.findById = original;
    assertEquals((await only(h, parent)).status, "suspended");
  });
});

// Wait keys (swamp-club#3209): a key is held by one open wait of a workflow
// at a time.

/** Starts a run and returns it, among however many the workflow has. */
async function startRun(h: Harness, workflow: Workflow): Promise<WorkflowRun> {
  const before = new Set(
    (await h.runRepo.findAllByWorkflowId(workflow.id)).map((run) => run.id),
  );
  await drain(h.service.run(workflow.name));
  const started = (await h.runRepo.findAllByWorkflowId(workflow.id)).filter(
    (run) => !before.has(run.id),
  );
  assertEquals(started.length, 1);
  return started[0];
}

async function highestOf(h: Harness, workflow: Workflow, key: string) {
  const highest = await h.waits.highestKeyRecord(workflow.id, key);
  assert(highest.kind === "found", `no readable record of key ${key}`);
  return highest.record;
}

async function cancelRun(h: Harness, run: WorkflowRun): Promise<void> {
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
}

Deno.test("wait key: the first run holds the key, and a second run's step fails with wait_key_held while the first wait stays open", async () => {
  const workflow = release("keyed-held", { key: "kitchen-verdict" });
  await withHarness([workflow], async (h) => {
    const first = await startRun(h, workflow);
    const firstWait = waitIdOf(first);
    const second = await startRun(h, workflow);

    // The second run opened nothing: its step failed, and its failed
    // dependent ran.
    const review = stepOf(second, "review");
    assertEquals(review.status, "failed");
    assertEquals(review.error, WAIT_KEY_HELD_STEP_ERROR);
    assertEquals(review.signalWait, undefined);
    assertEquals(stepOf(second, "escalate").status, "succeeded");
    assertEquals(second.status, "succeeded");

    // The first run's wait is as it was, and it is the only one.
    assertEquals((await reload(h, first)).status, "suspended");
    assertEquals((await h.waits.findOutcome(firstWait)).kind, "absent");
    assertEquals(
      (await h.waits.listRegistrations()).map((r) => r.waitId),
      [firstWait],
    );
    const claim = await highestOf(h, workflow, "kitchen-verdict");
    assert(claim.kind === "claim");
    assertEquals(claim.generation, 1);
    assertEquals(claim.waitId, firstWait);

    // The listing carries the key.
    const listed = await listWaits(h);
    assertEquals(listed.waits.map((w) => [w.waitId, w.key]), [
      [firstWait, "kitchen-verdict"],
    ]);
    await signalOk(h, firstWait, { verdict: "ship" });
  });
});

for (const release_ of ["signalled", "timed out", "cancelled"] as const) {
  Deno.test(`wait key: once the holder is ${release_}, the next run's wait claims the key`, async () => {
    const workflow = release(`keyed-${release_.replace(" ", "-")}`, {
      key: "verdict",
    });
    await withHarness([workflow], async (h) => {
      const first = await startRun(h, workflow);
      const firstWait = waitIdOf(first);
      if (release_ === "signalled") {
        // Not resumed: the outcome frees the key, not the run record.
        await signalOk(h, firstWait, { verdict: "ship" });
      } else if (release_ === "timed out") {
        await expireWaits(h, first);
        await drain(h.service.resume(workflow.name, first.id));
        assertEquals(
          stepOf(await reload(h, first), "review").error,
          WAIT_TIMEOUT_STEP_ERROR,
        );
      } else {
        await cancelRun(h, first);
      }

      const next = await startRun(h, workflow);
      assertEquals(next.status, "suspended");
      const nextWait = waitIdOf(next);
      assertNotEquals(nextWait, firstWait);
      const claim = await highestOf(h, workflow, "verdict");
      assert(claim.kind === "claim");
      assertEquals([claim.generation, claim.waitId], [2, nextWait]);
      await signalOk(h, nextWait, { verdict: "ship" });
    });
  });
}

Deno.test("wait key: a step that is reset claims its key again, as a new claim with a new wait", async () => {
  const workflow = release("keyed-retried", {
    allowFailure: false,
    key: "verdict",
  });
  await withHarness([workflow], async (h) => {
    const run = await startRun(h, workflow);
    const firstWait = waitIdOf(run);
    await expireWaits(h, run);
    await drain(h.service.resume(workflow.name, run.id));
    assertEquals((await reload(h, run)).status, "failed");

    await drain(h.service.resume(workflow.name, run.id));
    const retried = await reload(h, run);
    assertEquals(retried.status, "suspended");
    const secondWait = waitIdOf(retried);
    assertNotEquals(secondWait, firstWait);
    const claim = await highestOf(h, workflow, "verdict");
    assert(claim.kind === "claim");
    assertEquals([claim.generation, claim.waitId], [2, secondWait]);
    assertEquals(stepOf(retried, "review").signalWait?.key, "verdict");
    await signalOk(h, secondWait, { verdict: "ship" });
  });
});

/** A claim request for a run that exists only in this test. */
function requestFor(workflow: Workflow, key: string): WaitKeyRequest {
  return {
    workflowId: workflow.id,
    key,
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "release",
    stepName: "review",
    deadline: "2999-01-01T00:00:00.000Z",
  };
}

/**
 * `store` as one claimant sees it, held after it has read the highest
 * record of the key until `go` resolves: the order of two claimants' reads
 * and creates is then the test's to decide.
 */
function heldAfterRead(
  store: SignalWaitStore,
  go: Promise<void>,
): { store: WaitKeyRecords; read: Promise<void> } {
  let read!: () => void;
  const hasRead = new Promise<void>((resolve) => read = resolve);
  let first = true;
  return {
    read: hasRead,
    store: {
      highestKeyRecord: async (workflowId, key) => {
        const highest = await store.highestKeyRecord(workflowId, key);
        if (first) {
          first = false;
          read();
          await go;
        }
        return highest;
      },
      createKeyRecord: (r) => store.createKeyRecord(r),
      listKeyRecords: () => store.listKeyRecords(),
      removeKeyRecord: (at) => store.removeKeyRecord(at),
      removeKeyRecordsOfWorkflow: (w) => store.removeKeyRecordsOfWorkflow(w),
      findOutcome: (id) => store.findOutcome(id),
      settle: (o) => store.settle(o),
    },
  };
}

Deno.test("wait key: two waits that claim a free key at the same moment get exactly one claim", async () => {
  const workflow = release("keyed-race", { key: "verdict" });
  await withHarness([workflow], async (h) => {
    let release!: () => void;
    const go = new Promise<void>((resolve) => release = resolve);
    const a = heldAfterRead(h.waits, go);
    const b = heldAfterRead(secondContext(h).waits, go);
    const now = new Date();
    const claims = [
      claimWaitKey(a.store, requestFor(workflow, "verdict"), now),
      claimWaitKey(b.store, requestFor(workflow, "verdict"), now),
    ];
    // Both have read the key as free before either creates its claim.
    await Promise.all([a.read, b.read]);
    release();

    const kinds = (await Promise.all(claims)).map((c) => c.kind).sort();
    assertEquals(kinds, ["acquired", "held"]);
    assertEquals((await h.waits.listKeyRecords()).length, 1);
  });
});

Deno.test("wait key: collecting the holder's run while two waits claim leaves one holder, and the collected claim's number is not used again", async () => {
  const workflow = release("keyed-gc-race", { key: "verdict" });
  await withHarness([workflow], async (h) => {
    const ended = await startRun(h, workflow);
    await signalOk(h, waitIdOf(ended), { verdict: "ship" });
    await drain(h.service.resume(workflow.name, ended.id));
    assertEquals((await reload(h, ended)).status, "succeeded");

    // One claimant reads the ended run's claim as the highest...
    let release!: () => void;
    const go = new Promise<void>((resolve) => release = resolve);
    const slow = heldAfterRead(h.waits, go);
    const now = new Date();
    const slowClaim = claimWaitKey(
      slow.store,
      requestFor(workflow, "verdict"),
      now,
    );
    await slow.read;

    // ...the run is collected, with its claim and its outcome...
    await createRunGcDeps(h.repoDir, undefined, undefined, {
      supported: true,
      store: h.waits,
    }).gcAll({
      workflowRunRetentionDays: 0,
      outputRetentionDays: 0,
      dryRun: false,
    });
    assertEquals(await h.runRepo.findAllByWorkflowId(workflow.id), []);
    const released = await highestOf(h, workflow, "verdict");
    assertEquals([released.kind, released.generation], ["release", 2]);
    assertEquals((await h.waits.listKeyRecords()).length, 1);

    // ...and another wait claims the key before the first one creates.
    const quick = await claimWaitKey(
      h.waits,
      requestFor(workflow, "verdict"),
      now,
    );
    assert(quick.kind === "acquired");
    assertEquals(quick.claim.generation, 3);

    release();
    const late = await slowClaim;
    assert(late.kind === "held");
    assertEquals(late.claim.waitId, quick.claim.waitId);
  });
});

Deno.test("wait key: a step whose process died between its claim and its registration takes over the wait it claimed", async () => {
  const workflow = release("keyed-crashed", { key: "verdict" });
  await withHarness([workflow], async (h) => {
    const run = await startRun(h, workflow);
    const waitId = waitIdOf(run);
    // What such a kill leaves, once recovered: the claim exists, no wait
    // was registered, and the record shows the step not started.
    await h.waits.removeRegistration(waitId);
    const data = run.toData();
    const review = data.jobs[0].steps.find((s) => s.stepName === "review")!;
    review.status = "pending";
    review.startedAt = undefined;
    review.wait = undefined;
    await h.runRepo.save(workflow.id, WorkflowRun.fromData(data));

    await drain(serviceOfAnotherProcess(h).resume(workflow.name, run.id));

    const again = await reload(h, run);
    assertEquals(again.status, "suspended");
    assertEquals(waitIdOf(again), waitId);
    const registration = await h.waits.findRegistration(waitId);
    assert(registration.kind === "found");
    assertEquals(registration.record.key, "verdict");
    assertEquals((await h.waits.listKeyRecords()).length, 1);
    await signalOk(h, waitId, { verdict: "ship" });
  });
});

Deno.test("wait key: deleting a workflow removes its key records and no others", async () => {
  const doomed = release("keyed-doomed", { key: "verdict" });
  const kept = release("keyed-kept", { key: "verdict" });
  await withHarness([doomed, kept], async (h) => {
    await drain(h.service.run(doomed.name));
    await drain(h.service.run(kept.name));
    const keptWait = waitIdOf(await only(h, kept));

    for await (
      const event of workflowDelete(
        createLibSwampContext(),
        createWorkflowDeleteDeps(h.repoDir, undefined, undefined, undefined, {
          supported: true,
          store: h.waits,
        }),
        { workflowIdOrName: doomed.name },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    const records = await h.waits.listKeyRecords();
    assertEquals(records.map((r) => [r.workflowId, r.kind]), [
      [kept.id, "claim"],
    ]);
    assertEquals((await highestOf(h, kept, "verdict")).kind, "claim");
    await signalOk(h, keptWait, { verdict: "ship" });
  });
});

Deno.test("wait key: a wait without a key writes no key record", async () => {
  const workflow = release("unkeyed");
  await withHarness([workflow], async (h) => {
    const first = await startRun(h, workflow);
    const second = await startRun(h, workflow);
    assertEquals(first.status, "suspended");
    assertEquals(second.status, "suspended");
    assertEquals(await h.waits.listKeyRecords(), []);
    assertEquals((await listWaits(h)).waits.map((w) => w.key), [
      undefined,
      undefined,
    ]);
  });
});
