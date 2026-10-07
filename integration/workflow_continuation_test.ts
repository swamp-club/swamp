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
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { sweepContinuations } from "../src/serve/continuation_sweep_service.ts";
import { continuationClaimsOver } from "../src/cli/repo_context.ts";
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
  serveHolder,
  suspensionKeyOf,
} from "../src/domain/workflows/continuation_claim.ts";
import { acceptedOutcomeFor } from "../src/domain/workflows/signal_wait_store_test_helpers.ts";
import { closeRunWaits } from "../src/domain/workflows/signal_wait_cleanup.ts";
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
  /** Saves a workflow that waits for a signal, then runs the counted step. */
  saveWaiting(options?: { autoResume?: boolean }): Promise<Workflow>;
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
                    task: StepTask.waitForSignal(3600, SCHEMA),
                  }),
                  Step.create({
                    name: "ship",
                    task: StepTask.modelMethod(model.name, "ship"),
                    dependsOn: [{
                      step: "review",
                      condition: TriggerCondition.succeeded(),
                    }],
                  }),
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
