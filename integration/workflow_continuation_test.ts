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
 * Serve continuing a suspended run by itself (swamp-club#3108), against a
 * real repository on disk whose wait records, continuation claims and
 * heartbeats live in the filesystem control-plane store.
 *
 * Two serve instances are two connection contexts over that one
 * repository, each with its own active-run registry and its own holder
 * name, as two `swamp serve` processes on one datastore have. Every test
 * orders its own writes and polls for what it expects; none sleeps.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { createRecordingSyncService, waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { sweepContinuations } from "../src/serve/continuation_sweep_service.ts";
import {
  continuationClaimsOver,
  runRecordCurrencyOver,
} from "../src/cli/repo_context.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import {
  continuationRunPrefix,
  serveHolder,
  suspensionKeyOf,
} from "../src/domain/workflows/continuation_claim.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRunGcDeps } from "../src/libswamp/data/run_gc.ts";
import {
  createWorkflowDeleteDeps,
  workflowDelete,
} from "../src/libswamp/workflows/delete.ts";
import { acceptedOutcomeFor } from "../src/domain/workflows/signal_wait_store_test_helpers.ts";
import { closeRunWaits } from "../src/domain/workflows/signal_wait_cleanup.ts";
import { WAIT_TIMEOUT_STEP_ERROR } from "../src/domain/workflows/signal_wait.ts";
import type { SignalWaitStore } from "../src/domain/workflows/signal_wait_store.ts";
import {
  createServeCtx,
  errorFrame,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

const opts = { sanitizeOps: false, sanitizeResources: false };

interface Fixture {
  repo: ServeRepo;
  control: FileSystemControlPlaneStore;
  /** How many times the step after the wait has executed. */
  executions: () => number;
  /**
   * Saves a workflow that waits for a signal, then runs the counted step.
   * With `onFailure`, a second counted step, `notify`, runs when the wait
   * fails instead.
   */
  saveWaiting(
    options?: { autoResume?: boolean; onFailure?: boolean; key?: string },
  ): Promise<Workflow>;
}

/** A repository with a model whose one method counts its executions. */
async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  await withServeRepo(async (repo) => {
    const modelType = ModelType.create(
      `test/continuation-${crypto.randomUUID().slice(0, 8)}`,
    );
    let executions = 0;
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      methods: {
        ship: {
          description: "counts its executions",
          kind: "read",
          arguments: z.object({}),
          execute: () => {
            executions++;
            return Promise.resolve({});
          },
        },
      },
    });
    try {
      const model = Definition.create({
        name: `shipper-${crypto.randomUUID().slice(0, 8)}`,
        globalArguments: {},
      });
      await repo.repoContext.definitionRepo.save(modelType, model);
      await fn({
        repo,
        control: new FileSystemControlPlaneStore(swampPath(repo.repoDir)),
        executions: () => executions,
        saveWaiting: async (options = {}) => {
          const workflow = Workflow.create({
            name: `release-${crypto.randomUUID().slice(0, 8)}`,
            autoResume: options.autoResume ?? true,
            jobs: [
              Job.create({
                name: "main",
                steps: [
                  Step.create({
                    name: "review",
                    task: StepTask.waitForSignal(3600, SCHEMA, options.key),
                  }),
                  Step.create({
                    name: "ship",
                    task: StepTask.modelMethod(model.name, "ship"),
                    dependsOn: [{
                      step: "review",
                      condition: TriggerCondition.succeeded(),
                    }],
                  }),
                  ...(options.onFailure
                    ? [Step.create({
                      name: "notify",
                      task: StepTask.modelMethod(model.name, "ship"),
                      dependsOn: [{
                        step: "review",
                        condition: TriggerCondition.failed(),
                      }],
                    })]
                    : []),
                ],
              }),
            ],
          });
          await repo.repoContext.workflowRepo.save(workflow);
          return workflow;
        },
      });
    } finally {
      modelRegistry.invalidateType(modelType);
    }
  });
}

interface Instance {
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
  audit: AuditEvent[];
}

/** One serve instance on the fixture's repository, holding claims as `id`. */
function instance(
  f: Fixture,
  id: string,
  registry = new ActiveRunRegistry(),
): Instance {
  const audit: AuditEvent[] = [];
  const base = createServeCtx(f.repo, undefined, {
    activeRunRegistry: registry,
  });
  const ctx: ConnectionContext = {
    ...base,
    instanceId: id,
    serveOptions: { autoResume: false } as MergedServeOptions,
    auditEmitter: {
      emit: (event: AuditEvent) => audit.push(event),
    } as unknown as AuditEmitter,
    repoContext: {
      ...f.repo.repoContext,
      continuationClaims: continuationClaimsOver(f.control, serveHolder(id)),
    },
  };
  return { ctx, registry, audit };
}

/** Writes a heartbeat for instance `id`, as a live serve instance does. */
async function beat(f: Fixture, id: string): Promise<void> {
  await f.control.put(
    `heartbeats/${id}`,
    new TextEncoder().encode(JSON.stringify({
      instanceId: id,
      hostname: "test",
      pid: 1,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })),
  );
}

/** Runs `workflow` through serve until it suspends on its wait. */
async function suspend(
  f: Fixture,
  workflow: Workflow,
): Promise<{ run: WorkflowRun; waitId: string }> {
  const frames = await sendRequest(createServeCtx(f.repo), {
    type: "workflow.run",
    id: `run-${crypto.randomUUID()}`,
    payload: { workflowIdOrName: workflow.name },
  }, null);
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const suspended = await f.repo.repoContext.workflowRunRepo
    .findSummariesByStatus(workflow.id, "suspended");
  assertEquals(suspended.length, 1, JSON.stringify(frames));
  const run = await loadRun(f, workflow, suspended[0].id);
  const wait = run.findSignalWaits()[0].wait;
  assert(wait, "the run holds a readable wait");
  return { run, waitId: wait.id };
}

async function loadRun(
  f: Fixture,
  workflow: Workflow,
  runId: string,
): Promise<WorkflowRun> {
  const run = await f.repo.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
  assert(run, `run ${runId} exists`);
  return run;
}

/** Settles the run's wait as the local `swamp workflow signal` does. */
async function settleLocally(f: Fixture, run: WorkflowRun): Promise<void> {
  const support = f.repo.repoContext.signalWaits;
  assert(support?.supported, "the datastore holds wait records");
  const wait = run.findSignalWaits()[0].wait!;
  await support.store.settle({
    ...acceptedOutcomeFor(wait, { verdict: "ship" }, { runId: run.id }),
    workflowId: run.workflowId,
  });
}

function actions(instance: Instance): string[] {
  return instance.audit.map((event) => event.action);
}

async function idle(...instances: Instance[]): Promise<void> {
  await waitFor(
    () => instances.every((i) => i.registry.size === 0),
    "every launched resume finished",
  );
}

Deno.test({
  name:
    "continuation: a signal addressed by workflow and key resumes the run as one by wait ID does",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ key: "verdict" });
      const { run } = await suspend(f, workflow);
      const a = instance(f, "a");

      const frames = await sendRequest(a.ctx, {
        type: "workflow.signal",
        id: `signal-${crypto.randomUUID()}`,
        payload: {
          workflow: workflow.name,
          key: "verdict",
          payload: { verdict: "ship" },
        },
      }, null);
      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));

      await waitFor(
        async () => (await loadRun(f, workflow, run.id)).status === "succeeded",
        "the run continued and finished",
      );
      assertEquals(f.executions(), 1);
      assert(actions(a).includes("workflow.auto_resume"));
    });
  },
});

Deno.test({
  name:
    "continuation: a signal that settles a run's last wait resumes it with no manual resume",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run, waitId } = await suspend(f, workflow);
      const a = instance(f, "a");

      const frames = await sendRequest(a.ctx, {
        type: "workflow.signal",
        id: `signal-${crypto.randomUUID()}`,
        payload: { waitId, payload: { verdict: "ship" } },
      }, null);
      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));

      await waitFor(
        async () => (await loadRun(f, workflow, run.id)).status === "succeeded",
        "the run continued and finished",
      );
      assertEquals(f.executions(), 1);
      assert(actions(a).includes("workflow.auto_resume"));
      const claim = await a.ctx.repoContext.continuationClaims!.store.find(
        run.id,
        await suspensionKeyOf(run),
      );
      assertEquals(claim?.holder, serveHolder("a"));
    });
  },
});

Deno.test({
  name:
    "continuation: two instances sweeping the same settled run resume it exactly once",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      const a = instance(f, "a");
      const b = instance(f, "b");

      const [swept, alsoSwept] = await Promise.all([
        sweepContinuations(a.ctx, { takeover: true }),
        sweepContinuations(b.ctx, { takeover: true }),
      ]);
      await idle(a, b);

      assertEquals((await loadRun(f, workflow, run.id)).status, "succeeded");
      assertEquals(f.executions(), 1);
      assert(swept.launched + alsoSwept.launched >= 1);
      // Whatever the loser saw, it ran nothing and the run is as the
      // winner left it. A third pass finds nothing to do.
      assertEquals(
        await sweepContinuations(a.ctx, { takeover: true }),
        { examined: 0, launched: 0 },
      );
    });
  },
});

Deno.test({
  name:
    "continuation: an instance holding an older suspended copy does not resume a suspension a peer consumed",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      const staleCopy = await Deno.readFile(
        f.repo.repoContext.workflowRunRepo.getPath(workflow.id, run.id),
      );
      await settleLocally(f, run);
      const a = instance(f, "a");
      await beat(f, "a");
      await sweepContinuations(a.ctx, { takeover: true });
      await idle(a);
      assertEquals(f.executions(), 1);

      // Instance b's cache still holds the run as it was before a resumed
      // it, as a synced datastore's cache does until something pulls.
      await Deno.writeFile(
        f.repo.repoContext.workflowRunRepo.getPath(workflow.id, run.id),
        staleCopy,
      );
      const b = instance(f, "b");
      for (const takeover of [false, true]) {
        await sweepContinuations(b.ctx, { takeover });
        await idle(b);
      }

      assertEquals(f.executions(), 1);
      assertEquals(b.audit, []);
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");
    });
  },
});

Deno.test({
  name:
    "continuation: an instance holding a suspended copy of a run a peer cancelled does not resume it",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      const path = f.repo.repoContext.workflowRunRepo.getPath(
        workflow.id,
        run.id,
      );
      const staleCopy = await Deno.readFile(path);

      // A peer cancels the run: it is saved as cancelled, and its wait is
      // closed in the store every instance reads.
      const support = f.repo.repoContext.signalWaits;
      assert(support?.supported, "the datastore holds wait records");
      await closeRunWaits(support.store, run, new Date());
      run.endAsCancelled("cancelled on another instance");
      await f.repo.repoContext.workflowRunRepo.save(
        createWorkflowId(workflow.id),
        run,
      );

      // This instance's cache still holds the run as it was.
      await Deno.writeFile(path, staleCopy);
      const a = instance(f, "a");
      for (const takeover of [false, true]) {
        await sweepContinuations(a.ctx, { takeover });
        await idle(a);
      }

      assertEquals(f.executions(), 0);
      assertEquals(a.audit, []);
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");
    });
  },
});

Deno.test({
  name:
    "continuation: a claim left by an instance with no live heartbeat is taken over, once the records are current",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      // Instance "dead" claimed the suspension and went away before it ran
      // anything: no heartbeat names it.
      const b = instance(f, "b");
      const claims = b.ctx.repoContext.continuationClaims!;
      const suspensionKey = await suspensionKeyOf(run);
      await claims.store.create({
        runId: run.id,
        suspensionKey,
        generation: 1,
        holder: serveHolder("dead"),
        claimedAt: new Date().toISOString(),
      });

      await sweepContinuations(b.ctx, { takeover: false });
      await idle(b);
      assertEquals(f.executions(), 0);
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");

      await sweepContinuations(b.ctx, { takeover: true });
      await idle(b);
      assertEquals(f.executions(), 1);
      assertEquals((await loadRun(f, workflow, run.id)).status, "succeeded");
      const claim = await claims.store.find(run.id, suspensionKey);
      assertEquals(claim?.generation, 2);
      assertEquals(claim?.holder, serveHolder("b"));
    });
  },
});

Deno.test({
  name:
    "continuation: a launch refused for capacity leaves the run suspended, and the next sweep retries it",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      const registry = new ActiveRunRegistry({ maxConcurrent: 1 });
      const a = instance(f, "a", registry);
      // Another run fills the registry.
      const busy = crypto.randomUUID();
      let finish!: () => void;
      registry.register({
        runId: busy,
        kind: "workflow-run",
        resourceName: "other",
        buffer: undefined as never,
        controller: new AbortController(),
        startedAt: new Date(),
        completion: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        principalId: null,
      });

      for (let pass = 0; pass < 2; pass++) {
        assertEquals(
          await sweepContinuations(a.ctx, { takeover: true }),
          { examined: 1, launched: 0 },
        );
      }
      assertEquals(f.executions(), 0);
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");
      // Audited once, with the reason, not on every pass.
      assertEquals(actions(a), ["workflow.auto_resume_failed"]);
      assertStringIncludes(a.audit[0].detail ?? "", "code=global_cap");

      registry.deregister(busy);
      finish();
      assertEquals(
        await sweepContinuations(a.ctx, { takeover: true }),
        { examined: 1, launched: 1 },
      );
      await idle(a);
      assertEquals(f.executions(), 1);
      assertEquals((await loadRun(f, workflow, run.id)).status, "succeeded");
    });
  },
});

Deno.test({
  name:
    "continuation: a run whose workflow turns auto-resume off stays suspended, and nothing is reported",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ autoResume: false });
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      const a = instance(f, "a");

      for (let pass = 0; pass < 3; pass++) {
        await sweepContinuations(a.ctx, { takeover: true });
      }
      await idle(a);

      assertEquals(f.executions(), 0);
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");
      assertEquals(actions(a), []);
    });
  },
});

Deno.test({
  name:
    "continuation: the sweep leaves a parent that waits on a nested run alone, and the parent continues once its signalled child ends",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const child = await f.saveWaiting();
      const parent = Workflow.create({
        name: `parent-${crypto.randomUUID().slice(0, 8)}`,
        autoResume: true,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "call-child",
                task: StepTask.workflow(child.name),
              }),
            ],
          }),
        ],
      });
      await f.repo.repoContext.workflowRepo.save(parent);

      const frames = await sendRequest(createServeCtx(f.repo), {
        type: "workflow.run",
        id: `run-${crypto.randomUUID()}`,
        payload: { workflowIdOrName: parent.name },
      }, null);
      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const runRepo = f.repo.repoContext.workflowRunRepo;
      const [parentSummary] = await runRepo.findSummariesByStatus(
        parent.id,
        "suspended",
      );
      const [childSummary] = await runRepo.findSummariesByStatus(
        child.id,
        "suspended",
      );
      assert(parentSummary && childSummary, JSON.stringify(frames));
      const childRun = await loadRun(f, child, childSummary.id);
      const a = instance(f, "a");

      // Nothing to continue yet, and the sweep never takes the parent.
      assertEquals(
        (await sweepContinuations(a.ctx, { takeover: true })).launched,
        0,
      );

      const signalled = await sendRequest(a.ctx, {
        type: "workflow.signal",
        id: `signal-${crypto.randomUUID()}`,
        payload: {
          waitId: childRun.findSignalWaits()[0].wait!.id,
          payload: { verdict: "ship" },
        },
      }, null);
      assertEquals(errorFrame(signalled), undefined, JSON.stringify(signalled));

      await waitFor(
        async () =>
          (await loadRun(f, parent, parentSummary.id)).status === "succeeded",
        "the parent continued after its child",
      );
      assertEquals(
        (await loadRun(f, child, childSummary.id)).status,
        "succeeded",
      );
      assertEquals(f.executions(), 1);
    });
  },
});

/**
 * Gives `target` a synced datastore's view of its run records: each is
 * compared with what `remote` answers for its cache-relative path, through
 * the same wiring serve uses over a sync service with `fetchContent`.
 */
function withRemoteRunRecords(
  f: Fixture,
  target: Instance,
  remote: (relPath: string) => Uint8Array | null,
): { fetched: string[] } {
  const fetched: string[] = [];
  const runRepo = f.repo.repoContext.workflowRunRepo;
  target.ctx.repoContext.runRecordCurrency = runRecordCurrencyOver(
    {
      type: "@test/remote",
      config: {},
      datastorePath: "remote://test",
      cachePath: swampPath(f.repo.repoDir),
    },
    {
      ...createRecordingSyncService().service,
      fetchContent: (relPath) => {
        fetched.push(relPath);
        return Promise.resolve(remote(relPath));
      },
    },
    (run) =>
      runRepo.getPath(
        createWorkflowId(run.workflowId),
        createWorkflowRunId(run.runId),
      ),
  );
  return { fetched };
}

/** The run's record as this host stores it. */
function storedRecord(f: Fixture, run: WorkflowRun): Promise<Uint8Array> {
  return Deno.readFile(
    f.repo.repoContext.workflowRunRepo.getPath(
      createWorkflowId(run.workflowId),
      createWorkflowRunId(run.id),
    ),
  );
}

/** The record a peer left in the datastore when it cancelled the run. */
function cancelledByPeer(record: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(record);
  assertStringIncludes(text, "status: suspended");
  return new TextEncoder().encode(
    text.replace("status: suspended", "status: cancelled"),
  );
}

Deno.test({
  name:
    "continuation: a settled run a peer cancelled is not continued from this instance's suspended copy of it",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      // The signal was accepted and its launch lost; a peer then cancelled
      // the run. Outcomes are written once, so the wait still reads as
      // accepted and this instance's copy still reads as settled.
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      const local = await storedRecord(f, run);
      const remote = cancelledByPeer(local);
      const a = instance(f, "a");
      const { fetched } = withRemoteRunRecords(f, a, () => remote);

      // A pass after boot, when this instance's records may be behind.
      assertEquals(
        await sweepContinuations(a.ctx, { takeover: false }),
        { examined: 1, launched: 0 },
      );
      await idle(a);

      assertEquals(fetched.length, 1);
      assertStringIncludes(fetched[0], run.id);
      assertEquals(f.executions(), 0);
      assertEquals(
        (await loadRun(f, workflow, run.id)).status,
        "suspended",
      );
      // The comparison left this host's record as it was.
      assertEquals(await storedRecord(f, run), local);
      assertEquals(actions(a), []);

      // The next pass does not read the datastore for it again.
      assertEquals(
        (await sweepContinuations(a.ctx, { takeover: false })).launched,
        0,
      );
      assertEquals(fetched.length, 1);
    });
  },
});

Deno.test({
  name:
    "continuation: a settled run whose record matches the datastore's is continued by a pass after boot",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      const local = await storedRecord(f, run);
      const a = instance(f, "a");
      const { fetched } = withRemoteRunRecords(f, a, () => local);

      assertEquals(
        await sweepContinuations(a.ctx, { takeover: false }),
        { examined: 1, launched: 1 },
      );
      await idle(a);

      assertEquals(f.executions(), 1);
      assertEquals(
        (await loadRun(f, workflow, run.id)).status,
        "succeeded",
      );
      // Once before the launch, and once under the run's claim.
      assertEquals(fetched.length, 2);
      assertEquals(fetched[0], fetched[1]);
    });
  },
});

Deno.test({
  name:
    "continuation: a peer's cancel that lands between the look and the resume is caught under the run's claim",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting();
      const { run } = await suspend(f, workflow);
      await settleLocally(f, run);
      const local = await storedRecord(f, run);
      const cancelled = cancelledByPeer(local);
      const a = instance(f, "a");
      let reads = 0;
      withRemoteRunRecords(f, a, () => ++reads === 1 ? local : cancelled);

      assertEquals(
        (await sweepContinuations(a.ctx, { takeover: false })).launched,
        1,
      );
      await idle(a);

      assertEquals(reads, 2);
      assertEquals(f.executions(), 0);
      const after = await loadRun(f, workflow, run.id);
      assertEquals(after.status, "suspended");
      // Refused before the claim: none is left for a later resume to trip on.
      assertEquals(
        await a.ctx.repoContext.continuationClaims!.store.find(
          run.id,
          await suspensionKeyOf(after),
        ),
        undefined,
      );
      // A lost race, not a failure.
      assertEquals(actions(a), ["workflow.auto_resume"]);
    });
  },
});

/** Runs `workflow` to its end through a sweep, which leaves a claim behind. */
async function finishBySweep(
  f: Fixture,
  a: Instance,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const { run } = await suspend(f, workflow);
  await settleLocally(f, run);
  await sweepContinuations(a.ctx, { takeover: true });
  await idle(a);
  assertEquals((await loadRun(f, workflow, run.id)).status, "succeeded");
  assertEquals(
    (await f.control.list(continuationRunPrefix(run.id))).length,
    1,
  );
  return run;
}

// Claims are kept wherever a resume takes one, so they are removed with a
// run whether or not the datastore also holds wait records.
for (const waits of ["with", "without"] as const) {
  Deno.test({
    name:
      `continuation: run gc removes the claims of a collected run (${waits} wait records)`,
    ...opts,
    fn: async () => {
      await withFixture(async (f) => {
        const a = instance(f, "a");
        const run = await finishBySweep(f, a, await f.saveWaiting());

        const gc = createRunGcDeps(
          f.repo.repoDir,
          undefined,
          undefined,
          waits === "with" ? f.repo.repoContext.signalWaits : undefined,
          a.ctx.repoContext.continuationClaims!.store,
        );
        const result = await gc.gcAll({
          workflowRunRetentionDays: 0,
          outputRetentionDays: 0,
          dryRun: false,
        });

        assertEquals(result.workflowRunsDeleted, 1);
        assertEquals(await f.control.list(continuationRunPrefix(run.id)), []);
      });
    },
  });

  Deno.test({
    name:
      `continuation: deleting a workflow removes the claims of its runs and no others (${waits} wait records)`,
    ...opts,
    fn: async () => {
      await withFixture(async (f) => {
        const a = instance(f, "a");
        const doomed = await f.saveWaiting();
        const kept = await f.saveWaiting();
        const doomedRun = await finishBySweep(f, a, doomed);
        const keptRun = await finishBySweep(f, a, kept);

        for await (
          const event of workflowDelete(
            createLibSwampContext(),
            createWorkflowDeleteDeps(
              f.repo.repoDir,
              undefined,
              undefined,
              undefined,
              waits === "with" ? f.repo.repoContext.signalWaits : undefined,
              a.ctx.repoContext.continuationClaims!.store,
            ),
            { workflowIdOrName: doomed.name },
          )
        ) {
          if (event.kind === "error") throw new Error(event.error.message);
        }

        assertEquals(
          await f.repo.repoContext.workflowRunRepo.findAllByWorkflowId(
            doomed.id,
          ),
          [],
        );
        assertEquals(
          await f.control.list(continuationRunPrefix(doomedRun.id)),
          [],
        );
        assertEquals(
          (await f.control.list(continuationRunPrefix(keptRun.id))).length,
          1,
        );
      });
    },
  });
}

// Deadlines noticed by the sweep (swamp-club#3109). The sweep reads the
// clock each test hands it; the executor reads the real one, and the stored
// outcome is what carries the sweep's decision into the resume.

const DAY_MS = 24 * 60 * 60 * 1000;

function waitStore(f: Fixture): SignalWaitStore {
  const support = f.repo.repoContext.signalWaits;
  assert(support?.supported, "the datastore holds wait records");
  return support.store;
}

/** A clock `ms` past the deadline of the run's wait. */
function pastDeadline(run: WorkflowRun, ms = 1): () => number {
  const deadline = run.findSignalWaits()[0].wait!.deadline.getTime();
  return () => deadline + ms;
}

function stepStatuses(run: WorkflowRun): Record<string, string> {
  return Object.fromEntries(
    run.getJob("main")!.steps.map((step) => [step.stepName, step.status]),
  );
}

Deno.test({
  name:
    "continuation: the sweep settles a wait past its deadline as timed out, and the run's failed handler runs with no client action",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ onFailure: true });
      const { run, waitId } = await suspend(f, workflow);
      const a = instance(f, "a");

      // Before the deadline the wait is open and the pass changes nothing.
      assertEquals(
        await sweepContinuations(a.ctx, {
          takeover: true,
          now: pastDeadline(run, -1),
        }),
        { examined: 1, launched: 0 },
      );
      assertEquals((await waitStore(f).findOutcome(waitId)).kind, "absent");

      assertEquals(
        await sweepContinuations(a.ctx, {
          takeover: true,
          now: pastDeadline(run),
        }),
        { examined: 1, launched: 1 },
      );
      await idle(a);

      const outcome = await waitStore(f).findOutcome(waitId);
      assert(outcome.kind === "found");
      assertEquals(outcome.record.kind, "timed_out");
      const ended = await loadRun(f, workflow, run.id);
      assertEquals(ended.status, "failed");
      assertEquals(stepStatuses(ended), {
        review: "failed",
        ship: "skipped",
        notify: "succeeded",
      });
      assertEquals(
        ended.getJob("main")!.getStep("review")!.error,
        WAIT_TIMEOUT_STEP_ERROR,
      );
      assertEquals(f.executions(), 1);
      const resumed = a.audit.find((e) => e.action === "workflow.auto_resume");
      assertStringIncludes(JSON.stringify(resumed), "waitsTimedOut=1");
    });
  },
});

Deno.test({
  name:
    "continuation: a wait that expired while no instance was up is settled and its run continued by the first pass",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ onFailure: true });
      const { run } = await suspend(f, workflow);

      // An instance that starts thirty days after the deadline.
      const restarted = instance(f, "restarted");
      assertEquals(
        await sweepContinuations(restarted.ctx, {
          takeover: true,
          now: pastDeadline(run, 30 * DAY_MS),
        }),
        { examined: 1, launched: 1 },
      );
      await idle(restarted);

      assertEquals(
        stepStatuses(await loadRun(f, workflow, run.id)).notify,
        "succeeded",
      );
    });
  },
});

Deno.test({
  name:
    "continuation: a signal accepted before the deadline still holds when the sweep runs after it",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ onFailure: true });
      const { run, waitId } = await suspend(f, workflow);
      await settleLocally(f, run);
      const a = instance(f, "a");

      await sweepContinuations(a.ctx, {
        takeover: true,
        now: pastDeadline(run, DAY_MS),
      });
      await idle(a);

      const outcome = await waitStore(f).findOutcome(waitId);
      assert(outcome.kind === "found");
      assertEquals(outcome.record.kind, "accepted");
      const ended = await loadRun(f, workflow, run.id);
      assertEquals(ended.status, "succeeded");
      assertEquals(stepStatuses(ended), {
        review: "succeeded",
        ship: "succeeded",
        notify: "skipped",
      });
      const resumed = a.audit.find((e) => e.action === "workflow.auto_resume");
      assert(!JSON.stringify(resumed).includes("waitsTimedOut"));
    });
  },
});

Deno.test({
  name:
    "continuation: a signal that arrives after the sweep timed its wait out is answered expired",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ onFailure: true });
      const { run, waitId } = await suspend(f, workflow);
      const a = instance(f, "a");
      await sweepContinuations(a.ctx, {
        takeover: true,
        now: pastDeadline(run),
      });
      await idle(a);

      const frames = await sendRequest(a.ctx, {
        type: "workflow.signal",
        id: `signal-${crypto.randomUUID()}`,
        payload: { waitId, payload: { verdict: "ship" } },
      }, null);

      assertStringIncludes(JSON.stringify(errorFrame(frames)), "expired");
      assertEquals(
        stepStatuses(await loadRun(f, workflow, run.id)).ship,
        "skipped",
      );
    });
  },
});

Deno.test({
  name:
    "continuation: two instances sweeping the same expired wait store one outcome and run its failed handler once",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ onFailure: true });
      const { run, waitId } = await suspend(f, workflow);
      const a = instance(f, "a");
      const b = instance(f, "b");

      // Clocks that disagree: the create decides, not either clock.
      const [swept, alsoSwept] = await Promise.all([
        sweepContinuations(a.ctx, { takeover: true, now: pastDeadline(run) }),
        sweepContinuations(b.ctx, {
          takeover: true,
          now: pastDeadline(run, 5000),
        }),
      ]);
      await idle(a, b);

      assert(swept.launched + alsoSwept.launched >= 1);
      assertEquals(
        (await waitStore(f).listOutcomes()).filter((o) => o.waitId === waitId)
          .map((o) => o.kind),
        ["timed_out"],
      );
      assertEquals(
        stepStatuses(await loadRun(f, workflow, run.id)).notify,
        "succeeded",
      );
      assertEquals(f.executions(), 1);
    });
  },
});

Deno.test({
  name:
    "continuation: the sweep neither settles nor continues an expired wait of a workflow serve may not resume",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({
        autoResume: false,
        onFailure: true,
      });
      const { run, waitId } = await suspend(f, workflow);
      const a = instance(f, "a");

      assertEquals(
        await sweepContinuations(a.ctx, {
          takeover: true,
          now: pastDeadline(run, DAY_MS),
        }),
        { examined: 1, launched: 0 },
      );

      assertEquals((await waitStore(f).findOutcome(waitId)).kind, "absent");
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");
      assertEquals(f.executions(), 0);
    });
  },
});

Deno.test({
  name:
    "continuation: an expired wait whose registration is gone is not settled from a suspended copy of its run",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const workflow = await f.saveWaiting({ onFailure: true });
      const { run, waitId } = await suspend(f, workflow);
      // What a peer that ended or deleted the run leaves behind.
      await waitStore(f).removeRegistration(waitId);
      const a = instance(f, "a");

      assertEquals(
        await sweepContinuations(a.ctx, {
          takeover: true,
          now: pastDeadline(run, DAY_MS),
        }),
        { examined: 1, launched: 0 },
      );

      assertEquals((await waitStore(f).findOutcome(waitId)).kind, "absent");
      assertEquals((await loadRun(f, workflow, run.id)).status, "suspended");
    });
  },
});

Deno.test({
  name:
    "continuation: a nested run whose wait timed out fails, and its parent stays suspended for a manual resume",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      const child = await f.saveWaiting({ onFailure: true });
      const parent = Workflow.create({
        name: `parent-${crypto.randomUUID().slice(0, 8)}`,
        autoResume: true,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "call-child",
                task: StepTask.workflow(child.name),
              }),
            ],
          }),
        ],
      });
      await f.repo.repoContext.workflowRepo.save(parent);
      const frames = await sendRequest(createServeCtx(f.repo), {
        type: "workflow.run",
        id: `run-${crypto.randomUUID()}`,
        payload: { workflowIdOrName: parent.name },
      }, null);
      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const runRepo = f.repo.repoContext.workflowRunRepo;
      const [parentSummary] = await runRepo.findSummariesByStatus(
        parent.id,
        "suspended",
      );
      const [childSummary] = await runRepo.findSummariesByStatus(
        child.id,
        "suspended",
      );
      assert(parentSummary && childSummary, JSON.stringify(frames));
      const childRun = await loadRun(f, child, childSummary.id);
      const a = instance(f, "a");

      assertEquals(
        (await sweepContinuations(a.ctx, {
          takeover: true,
          now: pastDeadline(childRun),
        })).launched,
        1,
      );
      await idle(a);

      const ended = await loadRun(f, child, childSummary.id);
      assertEquals(ended.status, "failed");
      assertEquals(stepStatuses(ended).notify, "succeeded");
      assertEquals(
        (await loadRun(f, parent, parentSummary.id)).status,
        "suspended",
      );
    });
  },
});

Deno.test({
  name:
    "continuation: a server maximum fails a step that asks for a longer wait, and leaves a longer wait already open alone",
  ...opts,
  fn: async () => {
    await withFixture(async (f) => {
      // Opened with a timeout of an hour, before the maximum applied.
      const open = await f.saveWaiting();
      const { run, waitId } = await suspend(f, open);
      const deadline = run.findSignalWaits()[0].wait!.deadline;

      const support = f.repo.repoContext.signalWaits;
      assert(support?.supported);
      const capped = instance(f, "capped");
      capped.ctx.repoContext.signalWaits = {
        ...support,
        maxTimeoutSeconds: 60,
      };

      const refused = await f.saveWaiting({ onFailure: true });
      const frames = await sendRequest(capped.ctx, {
        type: "workflow.run",
        id: `run-${crypto.randomUUID()}`,
        payload: { workflowIdOrName: refused.name },
      }, null);
      const [refusedRun] = await f.repo.repoContext.workflowRunRepo
        .findAllByWorkflowId(refused.id);
      assert(refusedRun, JSON.stringify(frames));
      assertEquals(stepStatuses(refusedRun), {
        review: "failed",
        ship: "skipped",
        notify: "succeeded",
      });
      assertStringIncludes(
        refusedRun.getJob("main")!.getStep("review")!.error ?? "",
        "more than the 60 seconds this server allows",
      );

      // The open wait keeps its deadline and is still signalled.
      await sweepContinuations(capped.ctx, { takeover: true });
      assertEquals(
        (await loadRun(f, open, run.id)).findSignalWaits()[0].wait!.deadline,
        deadline,
      );
      const signalled = await sendRequest(capped.ctx, {
        type: "workflow.signal",
        id: `signal-${crypto.randomUUID()}`,
        payload: { waitId, payload: { verdict: "ship" } },
      }, null);
      assertEquals(errorFrame(signalled), undefined, JSON.stringify(signalled));
      await waitFor(
        async () => (await loadRun(f, open, run.id)).status === "succeeded",
        "the open wait was signalled and its run finished",
      );
    });
  },
});
