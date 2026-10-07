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

// swamp-club#2919: approve, reject, cancel, supersede and the resume
// take-over each load a suspended run, change it and save the whole record.
// Two of them on one run at once used to save over each other, so a cancel
// could report `cancelled` and then be overwritten. They now serialize on the
// run's claim. Here two writers share one datastore directory through their
// own repositories and their own lock-backed claims, as two processes do. The
// first is held inside its claim, just before its save; the second starts
// and finds the claim held; the first is then let go.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { RunTrackerRepository } from "../src/domain/models/run_tracker_repository.ts";
import type { EvaluatedWorkflowLookup } from "../src/domain/workflows/abort_settlement.ts";
import { Job } from "../src/domain/workflows/job.ts";
import type { MethodRunOutputs } from "../src/domain/workflows/orphaned_run_reaper.ts";
import type { WorkflowRunRepository } from "../src/domain/workflows/repositories.ts";
import type { WorkflowRunClaims } from "../src/domain/workflows/run_claim.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { cancelLocalRun } from "../src/cli/commands/workflow_cancel.ts";
import {
  createWorkflowRunClaims,
  createWorkflowRunLock,
} from "../src/cli/repo_context.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowApproveDeps,
  workflowApprove,
  type WorkflowApproveEvent,
} from "../src/libswamp/workflows/approve.ts";
import {
  createWorkflowRejectDeps,
  workflowReject,
  type WorkflowRejectEvent,
} from "../src/libswamp/workflows/reject.ts";
import { supersedeSuspendedRuns } from "../src/libswamp/workflows/supersede.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

/** Cancel deps for runs with no tracker rows or method-run records. */
const untracked = {
  runTracker: {
    findAllRunning: () => [],
  } as unknown as RunTrackerRepository,
  outputRepo: {
    findByIds: () => Promise.resolve(new Map()),
    save: () => Promise.reject(new Error("unexpected output save")),
  } as MethodRunOutputs,
};

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

/** One writer's view of the shared datastore, as a process has. */
interface Writer {
  repo: RepositoryContext;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
}

interface Fixture {
  dir: string;
  config: DatastoreConfig;
  first: Writer;
  second: Writer;
  /** Labels of the model-method steps that ran. */
  executions: string[];
}

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-2919-repo-" });
  const datastoreDir = await Deno.makeTempDir({ prefix: "swamp-2919-ds-" });
  const config: DatastoreConfig = { type: "filesystem", path: datastoreDir };
  const writer = (): Writer => {
    const resolver = new DefaultDatastorePathResolver(dir, config);
    const evaluatedRepo = new YamlEvaluatedWorkflowRepository(
      dir,
      resolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
    return {
      repo: createRepositoryContext({
        repoDir: dir,
        datastoreResolver: resolver,
      }),
      findEvaluatedWorkflow: (runId) => evaluatedRepo.findByRunId(runId),
    };
  };
  const first = writer();
  const second = writer();
  const type = ModelType.create(`test/claim-${crypto.randomUUID()}`);
  const executions: string[] = [];
  modelRegistry.register({
    type,
    version: "2026.10.01.1",
    methods: {
      run: {
        description: "Record that the step ran",
        arguments: z.object({ label: z.string() }),
        execute: (args) => {
          executions.push((args as { label: string }).label);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  await first.repo.definitionRepo.save(
    type,
    Definition.create({ name: "worker" }),
  );
  try {
    await fn({ dir, config, first, second, executions });
  } finally {
    first.repo.catalogStore.close();
    second.repo.catalogStore.close();
    await removeDir(dir);
    await removeDir(datastoreDir);
  }
}

/** The issue's workflow: a gate, then a step that runs once it is approved. */
function gatedWorkflow(): Workflow {
  return Workflow.create({
    name: `gated-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("go?") }),
          Step.create({
            name: "post",
            task: StepTask.model("worker", "run", { label: "post" }),
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
    ],
  });
}

function executionService(fixture: Fixture, writer: Writer) {
  return createWorkflowRunDeps(fixture.dir, writer.repo, fixture.config).then(
    (deps) =>
      deps.createExecutionService(
        writer.repo.workflowRepo,
        writer.repo.workflowRunRepo,
        fixture.dir,
        writer.repo.catalogStore,
      ),
  );
}

/** Runs the workflow with the real execution service until it suspends. */
async function suspend(
  fixture: Fixture,
  workflow: Workflow,
): Promise<WorkflowRun> {
  await fixture.first.repo.workflowRepo.save(workflow);
  const service = await executionService(fixture, fixture.first);
  const run = await service.execute(workflow.name);
  assertEquals(run.status, "suspended", JSON.stringify(run.toData()));
  return run;
}

function statuses(run: WorkflowRun): Record<string, string> {
  const result: Record<string, string> = { run: run.status };
  for (const job of run.jobs) {
    result[job.jobName] = job.status;
    for (const step of job.steps) {
      result[`${job.jobName}/${step.stepName}`] = step.status;
    }
  }
  return result;
}

/**
 * The first writer's side of an interleaving: a run repository whose save
 * waits to be let go, so the writer stays inside its claim with its decision
 * made and not yet stored.
 */
function heldAtSave(runRepo: WorkflowRunRepository, events: string[]) {
  const letGo = Promise.withResolvers<void>();
  const held: WorkflowRunRepository = new Proxy(runRepo, {
    get(target, property, receiver) {
      if (property === "save") {
        return async (...args: Parameters<WorkflowRunRepository["save"]>) => {
          events.push("first:at-save");
          await letGo.promise;
          await target.save(...args);
          events.push("first:saved");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { runRepo: held, letGo: () => letGo.resolve() };
}

/**
 * The second writer's claims: the real lock-backed ones, recording that the
 * claim was held by someone else when this writer asked for it, and when its
 * claimed work started.
 */
function arrivingClaims(
  config: DatastoreConfig,
  events: string[],
): WorkflowRunClaims {
  const claims = createWorkflowRunClaims(config);
  return {
    withClaim: async (runId, fn) => {
      const lock = await createWorkflowRunLock(config, runId);
      if (await lock.inspect()) events.push("second:found-claim-held");
      return await claims.withClaim(runId, () => {
        events.push("second:claimed");
        return fn();
      });
    },
  };
}

/**
 * Starts `first`, waits until it is held at its save, starts `second`, waits
 * until it has found the claim held, then lets the first go. Returns both
 * results once both settle.
 */
async function interleave<A, B>(
  events: string[],
  letGo: () => void,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[A, PromiseSettledResult<B>]> {
  const firstDone = first();
  let secondDone: Promise<PromiseSettledResult<B>>;
  try {
    await waitFor(
      () => events.includes("first:at-save"),
      "the first writer to reach its save",
    );
    secondDone = second().then(
      (value): PromiseSettledResult<B> => ({ status: "fulfilled", value }),
      (reason): PromiseSettledResult<B> => ({ status: "rejected", reason }),
    );
    await waitFor(
      () => events.includes("second:found-claim-held"),
      "the second writer to find the claim held",
    );
  } finally {
    // Also on a failed wait, so the first writer is never left parked.
    letGo();
  }
  const firstResult = await firstDone;
  return [firstResult, await secondDone];
}

/** The second writer's claimed work started only after the first saved. */
function assertSerialized(events: string[]): void {
  assertEquals(events, [
    "first:at-save",
    "second:found-claim-held",
    "first:saved",
    "second:claimed",
  ]);
}

async function lastEvent<E>(stream: AsyncIterable<E>): Promise<E> {
  let last: E | undefined;
  for await (const event of stream) last = event;
  return last!;
}

function approve(
  writer: Writer,
  workflow: Workflow,
  run: WorkflowRun,
  runRepo: WorkflowRunRepository,
  runClaims: WorkflowRunClaims,
): Promise<WorkflowApproveEvent> {
  return lastEvent(workflowApprove(
    createLibSwampContext(),
    createWorkflowApproveDeps(writer.repo.workflowRepo, runRepo, runClaims),
    {
      workflowIdOrName: workflow.name,
      stepName: "gate",
      runId: run.id,
      decidedBy: "user:test",
    },
  ));
}

function reject(
  writer: Writer,
  workflow: Workflow,
  run: WorkflowRun,
  runRepo: WorkflowRunRepository,
  runClaims: WorkflowRunClaims,
): Promise<WorkflowRejectEvent> {
  return lastEvent(workflowReject(
    createLibSwampContext(),
    createWorkflowRejectDeps(
      writer.repo.workflowRepo,
      runRepo,
      runClaims,
      writer.findEvaluatedWorkflow,
    ),
    {
      workflowIdOrName: workflow.name,
      stepName: "gate",
      runId: run.id,
      decidedBy: "user:test",
    },
  ));
}

function cancel(
  writer: Writer,
  workflow: Workflow,
  run: WorkflowRun,
  runRepo: WorkflowRunRepository,
  runClaims: WorkflowRunClaims,
): Promise<WorkflowRun | null> {
  return cancelLocalRun(run, workflow, "Cancelled by user", {
    runRepo,
    findEvaluatedWorkflow: writer.findEvaluatedWorkflow,
    runClaims,
    ...untracked,
    killProcess: () => Promise.resolve(true),
  });
}

function supersede(
  writer: Writer,
  workflow: Workflow,
  run: WorkflowRun,
  runRepo: WorkflowRunRepository,
  runClaims: WorkflowRunClaims,
) {
  return supersedeSuspendedRuns(
    workflow,
    run.inputs,
    {
      findSuspendedRuns: async (workflowId) =>
        (await runRepo.findAllByWorkflowId(workflowId))
          .filter((candidate) => candidate.status === "suspended"),
      findEvaluatedWorkflow: writer.findEvaluatedWorkflow,
      runClaims,
    },
    runRepo,
  );
}

function stored(
  fixture: Fixture,
  workflow: Workflow,
  run: WorkflowRun,
): Promise<WorkflowRun> {
  return fixture.second.repo.workflowRunRepo.findById(workflow.id, run.id)
    .then((found) => found!);
}

Deno.test("run claim: a cancel that arrives during an approve cancels the approved run", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const events: string[] = [];
    const held = heldAtSave(fixture.first.repo.workflowRunRepo, events);
    const { first, second, config } = fixture;

    const [approved, cancelled] = await interleave(
      events,
      held.letGo,
      () =>
        approve(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      () =>
        cancel(
          second,
          workflow,
          run,
          second.repo.workflowRunRepo,
          arrivingClaims(config, events),
        ),
    );

    assertSerialized(events);
    assertEquals(approved.kind, "completed");
    assertEquals(cancelled.status, "fulfilled");
    if (cancelled.status === "fulfilled") {
      assertEquals(cancelled.value?.status, "cancelled");
    }
    const record = await stored(fixture, workflow, run);
    assertEquals(statuses(record), {
      run: "cancelled",
      main: "failed",
      "main/gate": "succeeded",
      "main/post": "failed",
    });
    assertEquals(record.tags["cancel_reason"], "Cancelled by user");
    assertEquals(fixture.executions, []);
  });
});

Deno.test("run claim: an approve that arrives during a cancel is refused", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const events: string[] = [];
    const held = heldAtSave(fixture.first.repo.workflowRunRepo, events);
    const { first, second, config } = fixture;

    const [cancelled, approved] = await interleave(
      events,
      held.letGo,
      () =>
        cancel(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      () =>
        approve(
          second,
          workflow,
          run,
          second.repo.workflowRunRepo,
          arrivingClaims(config, events),
        ),
    );

    assertSerialized(events);
    assertEquals(cancelled?.status, "cancelled");
    assertEquals(approved.status, "fulfilled");
    if (approved.status === "fulfilled") {
      assertEquals(approved.value.kind, "error");
      if (approved.value.kind === "error") {
        assertStringIncludes(
          approved.value.error.message,
          `Run ${run.id} is not suspended (status: cancelled)`,
        );
      }
    }
    const record = await stored(fixture, workflow, run);
    assertEquals(statuses(record), {
      run: "cancelled",
      main: "failed",
      "main/gate": "failed",
      "main/post": "skipped",
    });
  });
});

Deno.test("run claim: a cancel that arrives during a reject leaves the run failed by the rejection", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const events: string[] = [];
    const held = heldAtSave(fixture.first.repo.workflowRunRepo, events);
    const { first, second, config } = fixture;

    const [rejected, cancelled] = await interleave(
      events,
      held.letGo,
      () =>
        reject(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      () =>
        cancel(
          second,
          workflow,
          run,
          second.repo.workflowRunRepo,
          arrivingClaims(config, events),
        ),
    );

    assertSerialized(events);
    assertEquals(rejected.kind, "completed");
    // Cancel reports the status it found, not `cancelled`.
    assertEquals(cancelled.status, "fulfilled");
    if (cancelled.status === "fulfilled") {
      assertEquals(cancelled.value?.status, "failed");
    }
    const record = await stored(fixture, workflow, run);
    assertEquals(record.status, "failed");
    assertEquals(record.tags["cancel_reason"], undefined);
  });
});

Deno.test("run claim: a reject that arrives during a cancel is refused", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const events: string[] = [];
    const held = heldAtSave(fixture.first.repo.workflowRunRepo, events);
    const { first, second, config } = fixture;

    const [, rejected] = await interleave(
      events,
      held.letGo,
      () =>
        cancel(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      () =>
        reject(
          second,
          workflow,
          run,
          second.repo.workflowRunRepo,
          arrivingClaims(config, events),
        ),
    );

    assertSerialized(events);
    assertEquals(rejected.status, "fulfilled");
    if (rejected.status === "fulfilled") {
      assertEquals(rejected.value.kind, "error");
    }
    assertEquals((await stored(fixture, workflow, run)).status, "cancelled");
  });
});

Deno.test("run claim: a supersede that arrives during an approve cancels the approved run", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const events: string[] = [];
    const held = heldAtSave(fixture.first.repo.workflowRunRepo, events);
    const { first, second, config } = fixture;

    const [approved, superseded] = await interleave(
      events,
      held.letGo,
      () =>
        approve(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      () =>
        supersede(
          second,
          workflow,
          run,
          second.repo.workflowRunRepo,
          arrivingClaims(config, events),
        ),
    );

    assertSerialized(events);
    assertEquals(approved.kind, "completed");
    assertEquals(superseded.status, "fulfilled");
    if (superseded.status === "fulfilled") {
      assertEquals(superseded.value.cancelledRunIds, [run.id]);
    }
    assertEquals(statuses(await stored(fixture, workflow, run)), {
      run: "cancelled",
      main: "failed",
      "main/gate": "succeeded",
      "main/post": "failed",
    });
  });
});

Deno.test("run claim: an approve that arrives during a supersede is refused", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const events: string[] = [];
    const held = heldAtSave(fixture.first.repo.workflowRunRepo, events);
    const { first, second, config } = fixture;

    const [superseded, approved] = await interleave(
      events,
      held.letGo,
      () =>
        supersede(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      () =>
        approve(
          second,
          workflow,
          run,
          second.repo.workflowRunRepo,
          arrivingClaims(config, events),
        ),
    );

    assertSerialized(events);
    assertEquals(superseded.cancelledRunIds, [run.id]);
    assertEquals(approved.status, "fulfilled");
    if (approved.status === "fulfilled") {
      assertEquals(approved.value.kind, "error");
    }
    assertEquals((await stored(fixture, workflow, run)).status, "cancelled");
  });
});

Deno.test("run claim: a resume that arrives during a cancel is refused and runs nothing", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const { first, second, config } = fixture;
    // With its gate approved, nothing but the cancel stops the resume.
    const approved = await approve(
      first,
      workflow,
      run,
      first.repo.workflowRunRepo,
      createWorkflowRunClaims(config),
    );
    assertEquals(approved.kind, "completed");

    const events: string[] = [];
    const held = heldAtSave(first.repo.workflowRunRepo, events);
    const service = await executionService(fixture, second);
    service.runClaims = arrivingClaims(config, events);

    const [cancelled, resumed] = await interleave(
      events,
      held.letGo,
      () =>
        cancel(
          first,
          workflow,
          run,
          held.runRepo,
          createWorkflowRunClaims(config),
        ),
      async () => {
        for await (const _event of service.resume(workflow.name, run.id)) {
          // Drained: a refusal throws before the first event.
        }
      },
    );

    assertSerialized(events);
    assertEquals(cancelled?.status, "cancelled");
    assertEquals(resumed.status, "rejected");
    if (resumed.status === "rejected") {
      await assertRejects(
        () => Promise.reject(resumed.reason),
        Error,
        "is not suspended or failed (status: cancelled)",
      );
    }
    assertEquals((await stored(fixture, workflow, run)).status, "cancelled");
    assertEquals(fixture.executions, []);
  });
});

Deno.test("run claim: a held claim does not change what the run repository finds", async () => {
  await withFixture(async (fixture) => {
    const workflow = gatedWorkflow();
    const run = await suspend(fixture, workflow);
    const runRepo = fixture.second.repo.workflowRunRepo;

    await createWorkflowRunClaims(fixture.config).withClaim(
      run.id,
      async () => {
        const all = await runRepo.findAllByWorkflowId(workflow.id);
        assertEquals(all.map((found) => found.id), [run.id]);
        const global = await runRepo.findGlobalById(run.id);
        assertEquals(global?.workflowId, workflow.id);
        assertEquals((await runRepo.findAllGlobal()).length, 1);
      },
    );
  });
});
