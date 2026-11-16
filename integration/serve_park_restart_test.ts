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

import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import type { RunParker } from "../src/domain/workflows/workflow_run.ts";
import type { ControlPlaneStore } from "../src/domain/datastore/control_plane_store.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { continueInterruptedRuns } from "../src/serve/interrupted_run_continuation.ts";
import {
  forgetParkedRun,
  listParkedRuns,
  ServeHandover,
} from "../src/serve/serve_handover.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const modeNone: ServeAuthConfig = {
  mode: "none",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: [],
  approveRequiresExplicitGrant: false,
  signalRequiresExplicitGrant: false,
  tagRequiresExplicitGrant: false,
};

const TEST = { sanitizeOps: false, sanitizeResources: false };

function shellStep(name: string, counter: string, after?: string): Step {
  return Step.create({
    name,
    task: StepTask.directExecution(
      "command/shell",
      `${name}-shell`,
      "execute",
      { run: `echo ${name} >> ${counter}` },
    ),
    dependsOn: after === undefined
      ? []
      : [{ step: after, condition: TriggerCondition.succeeded() }],
  });
}

function threeStepWorkflow(
  name: string,
  counter: string,
  autoContinue?: boolean,
): Workflow {
  return Workflow.create({
    name,
    autoContinue,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shellStep("first", counter),
          shellStep("second", counter, "first"),
          shellStep("third", counter, "second"),
        ],
      }),
    ],
  });
}

function memoryStore(): ControlPlaneStore {
  const data = new Map<string, Uint8Array>();
  return {
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
  };
}

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-park-restart-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function parkedRun(
  repoDir: string,
  workflow: Workflow,
  markers: ControlPlaneStore,
): Promise<{ runId: string; kinds: string[] }> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  const handover = new ServeHandover("serve-old");
  handover.useMarkerStore(markers);
  let runId: string | undefined;
  const kinds: string[] = [];
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    {
      workflowIdOrName: workflow.name,
      inputs: {},
      instanceId: "serve-old",
      handover: handover.forRun(() => 40),
    },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      kinds.push(event.kind);
      if (event.kind === "started" && event.parentRunId === undefined) {
        runId = event.runId;
      }
      if (event.kind === "step_started" && event.stepId === "first") {
        handover.begin();
      }
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  if (!runId) throw new Error("no run id observed");
  return { runId, kinds };
}

interface Serve {
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
}

async function newServe(repoDir: string): Promise<Serve> {
  const { repoDir: resolved, repoContext, datastoreConfig } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  const registry = new ActiveRunRegistry();
  const ctx = {
    repoDir: resolved,
    repoContext,
    datastoreConfig,
    authConfig: modeNone,
    activeRunRegistry: registry,
    instanceId: "serve-new",
    handover: new ServeHandover("serve-new"),
    serveOptions: { autoResume: false } as MergedServeOptions,
    auditEmitter: { emit: () => {} } as unknown as AuditEmitter,
  } as ConnectionContext;
  return { ctx, registry };
}

async function storedRun(serve: Serve, workflow: Workflow, runId: string) {
  return await serve.ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
}

async function ranSteps(counter: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(counter)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function finished(serve: Serve, runId: string): Promise<void> {
  await waitFor(
    () => serve.registry.get(runId) === undefined,
    "continued run deregistered",
  );
}

const gone = (_parker: RunParker) => Promise.resolve(false);

Deno.test({
  ...TEST,
  name:
    "park: stop then start: a run parked by a planned restart is continued by the next process under the same id, no step twice",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = threeStepWorkflow("park-stop-start", counter);
      const markers = memoryStore();

      const { runId, kinds } = await parkedRun(repoDir, workflow, markers);

      assertEquals(kinds.includes("parked"), true);
      assertEquals(kinds.includes("completed"), false);
      assertEquals(await ranSteps(counter), ["first"]);
      const serve = await newServe(repoDir);
      const parked = await storedRun(serve, workflow, runId);
      assert(parked?.isParked, `run is ${parked?.status}`);
      assertEquals(parked.parker?.instanceId, "serve-old");
      assertEquals(parked.parker?.eventSeq, 40);
      assertEquals(
        (await listParkedRuns(markers)).map((m) => m.runId),
        [runId],
      );

      const result = await continueInterruptedRuns(serve.ctx, "boot", {
        parkerAlive: gone,
      });
      assertEquals(result.continued, [runId]);
      await finished(serve, runId);

      const run = await storedRun(serve, workflow, runId);
      assertEquals(run?.status, "succeeded");
      assertEquals(await ranSteps(counter), ["first", "second", "third"]);
      assertEquals(run?.autoContinuation?.count, 0);
      const ended = serve.registry.findForAttach(runId);
      assertEquals(ended?.buffer.finished, true);
      assertEquals(serve.registry.get(runId), undefined);
      assertEquals(run?.autoContinuation?.resetSteps, []);
    }),
});

Deno.test({
  ...TEST,
  name:
    "park: rolling restart: the new process leaves a parked run while the process that parked it lives, then continues it",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = threeStepWorkflow("park-rolling", counter);
      const markers = memoryStore();
      const { runId } = await parkedRun(repoDir, workflow, markers);
      const serve = await newServe(repoDir);

      const parkers: RunParker[] = [];
      const waiting = await continueInterruptedRuns(serve.ctx, "boot", {
        parkerAlive: (parker) => {
          parkers.push(parker);
          return Promise.resolve(true);
        },
      });
      assertEquals(waiting.continued, []);
      assertEquals(waiting.deferred.map((t) => t.runId), [runId]);
      assertEquals(parkers[0].instanceId, "serve-old");
      assertEquals(await ranSteps(counter), ["first"]);

      const result = await continueInterruptedRuns(serve.ctx, "sweep", {
        targets: waiting.deferred,
        parkerAlive: gone,
      });
      assertEquals(result.continued, [runId]);
      await finished(serve, runId);
      assertEquals(await ranSteps(counter), ["first", "second", "third"]);
      await forgetParkedRun(markers, runId);
      assertEquals(await listParkedRuns(markers), []);
    }),
});

Deno.test({
  ...TEST,
  name:
    "park: a workflow with autoContinue false stays parked until an operator resumes it",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = threeStepWorkflow("park-opted-out", counter, false);
      const { runId } = await parkedRun(repoDir, workflow, memoryStore());
      const serve = await newServe(repoDir);

      const result = await continueInterruptedRuns(serve.ctx, "boot", {
        parkerAlive: gone,
      });

      assertEquals(result.continued, []);
      assertEquals(result.refused.map((r) => r.reason), ["opted_out"]);
      const run = await storedRun(serve, workflow, runId);
      assert(run?.isParked, `run is ${run?.status}`);
      assertEquals(await ranSteps(counter), ["first"]);
    }),
});

Deno.test({
  ...TEST,
  name: "park: a new leader continues a run parked by the leader it replaced",
  fn: () =>
    withRepo(async (repoDir) => {
      const counter = join(repoDir, "ran.txt");
      const workflow = threeStepWorkflow("park-lead", counter);
      const { runId } = await parkedRun(repoDir, workflow, memoryStore());
      const serve = await newServe(repoDir);

      const result = await continueInterruptedRuns(serve.ctx, "lead", {
        parkerAlive: gone,
      });

      assertEquals(result.continued, [runId]);
      await finished(serve, runId);
      assertEquals(
        (await storedRun(serve, workflow, runId))?.status,
        "succeeded",
      );
      assertEquals(await ranSteps(counter), ["first", "second", "third"]);
    }),
});
