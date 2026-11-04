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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { hostname } from "node:os";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  OWNER_STOPPED_STEP_ERROR,
  WorkflowRun,
} from "../src/domain/workflows/workflow_run.ts";
import { StepStart } from "../src/domain/workflows/step_start.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { appendToOpenUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import {
  createWorkflowRunClaims,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import {
  cancelAllLocalRuns,
  cancelLocalRun,
  openCancelWriter,
  ownerHoldsWriter,
  stopOwnersBeforeWriter,
} from "../src/cli/commands/workflow_cancel.ts";
import { createContext } from "../src/cli/context.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  type Client,
  endCommand,
  MEMBER,
  readCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";
import type { RunOwnerRequest } from "./serve_upstream_run_owner_worker.ts";

await initializeLogging({});

const GRANTS: readonly GrantSpec[] = [
  ...MEMBER,
  { actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
];
const OWNER_PID = 99_999_998;
const GONE_PID = 99_999_999;
const STARTED_AT = "2026-11-02T10:00:01.000Z";

function deployWorkflow(): Workflow {
  return Workflow.create({
    name: `deploy-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "apply",
        task: StepTask.model("writer", "write", {}),
      })],
    })],
  });
}

/** a journalled step reads pending, its start only in the journal */
async function startedRun(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  { journalled = false }: { journalled?: boolean } = {},
): Promise<{ workflow: Workflow; run: WorkflowRun }> {
  const workflow = deployWorkflow();
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "running",
    startedAt: "2026-11-02T10:00:00.000Z",
    pid: OWNER_PID,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-11-02T10:00:00.000Z",
      steps: [
        journalled
          ? { stepName: "apply", status: "pending" }
          : { stepName: "apply", status: "running", startedAt: STARTED_AT },
      ],
    }],
    tags: {},
  });
  await writeCommand(scratch, client, env, async (repos) => {
    await repos.workflowRepo.save(workflow);
    await repos.workflowRunRepo.save(workflow.id, run);
  });
  // a start commits only after its run's record has
  if (journalled) {
    await writeCommand(scratch, client, env, async (repos) => {
      assertEquals(
        await appendToOpenUnitOfWork(repos, [
          await repos.workflowRunRepo.writeStepStart(StepStart.create({
            workflowId: workflow.id,
            runId: run.id,
            jobName: "main",
            stepName: "apply",
            startedAt: Date.parse(STARTED_AT),
          })),
        ]),
        "committed",
      );
    });
  }
  const tracker = RunTrackerStore.fromSwampDir(swampPath(client.repoDir));
  try {
    tracker.register(ActiveRun.createWorkflowRun({
      id: run.id,
      workflowName: workflow.name,
      pid: OWNER_PID,
      hostname: hostname(),
    }));
  } finally {
    tracker.close();
  }
  return { workflow, run };
}

async function holdWriter(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
): Promise<{ stop(): Promise<void> }> {
  const worker = new Worker(
    new URL("./serve_upstream_run_owner_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const messages: string[] = [];
  worker.onmessage = (event: MessageEvent<string>) =>
    void messages.push(event.data);
  const reply = async (expected: string) => {
    await waitFor(
      () => messages.some((m) => m === expected || m.startsWith("failed")),
      `the run owner to answer ${expected}`,
      { timeoutMs: 60_000 },
    );
    const failed = messages.find((m) => m.startsWith("failed"));
    if (failed !== undefined) {
      worker.terminate();
      throw new Error(failed);
    }
  };
  await reply("loaded");
  worker.postMessage(
    {
      kind: "hold",
      configDir: scratch.configDir,
      repoDir: client.repoDir,
      env,
    } satisfies RunOwnerRequest,
  );
  await reply("held");
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      worker.postMessage({ kind: "stop" } satisfies RunOwnerRequest);
      try {
        await reply("stopped");
      } finally {
        worker.terminate();
      }
    },
  };
}

async function statusAtServe(
  scratch: Scratch,
  serve: Serve,
  workflow: Workflow,
  run: WorkflowRun,
): Promise<WorkflowRun | null> {
  const reader = await scratch.client(`r-${crypto.randomUUID().slice(0, 8)}`);
  return await readCommand(
    scratch,
    reader,
    serveEnv(serve, "alice-token"),
    (repos) => repos.workflowRunRepo.findById(workflow.id, run.id),
  );
}

for (const all of [false, true]) {
  Deno.test({
    name: `serve upstream cancel: ${
      all ? "--all" : "a cancel by workflow name"
    } in a member's checkout stops the checkout's own run owner holding the writer before it takes the writer, and serve's copy reads the run cancelled`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve({ grants: GRANTS });
        const client = await scratch.client("a");
        // short, so a cancel that waits on the owner's writer fails fast
        const env = {
          ...serveEnv(serve, "alice-token"),
          SWAMP_LOCK_TIMEOUT_MS: "5000",
        };
        const { workflow, run } = await startedRun(scratch, client, env);
        const owner = await holdWriter(scratch, client, env);
        try {
          const result = await withClientEnv(
            scratch,
            env,
            ["workflow", "cancel"],
            async () => {
              assertEquals(await ownerHoldsWriter(client.repoDir), true);
              const killed: number[] = [];
              const preStop = await stopOwnersBeforeWriter(
                createContext({ json: true }, ["workflow", "cancel"]),
                all ? { repoDir: client.repoDir, all: true } : {
                  repoDir: client.repoDir,
                  all: false,
                  workflowIdOrName: workflow.name,
                },
                {
                  killProcess: async (pid) => {
                    killed.push(pid);
                    await owner.stop();
                    return true;
                  },
                },
              );
              await endCommand();
              assertEquals(killed, [OWNER_PID]);
              const targets = preStop.kind === "all"
                ? preStop.active
                : [{ run: preStop.run, workflow: preStop.workflow }];
              assertEquals(targets.map((t) => t.run.id), [run.id]);

              const writer = await openCancelWriter(
                () =>
                  requireInitializedRepoUnlocked({
                    repoDir: client.repoDir,
                    outputMode: "json",
                  }),
                () => new UserError("the cancel was answered with writer busy"),
              );
              const tracker = RunTrackerStore.fromSwampDir(
                swampPath(client.repoDir),
              );
              try {
                return await runCommandInRootUnit(
                  writer.repoContext,
                  { push: undefined },
                  () =>
                    cancelAllLocalRuns(targets, "No longer needed", {
                      runRepo: writer.repoContext.workflowRunRepo,
                      findEvaluatedWorkflow: () => Promise.resolve(null),
                      runTracker: tracker,
                      runClaims: createWorkflowRunClaims(
                        writer.datastoreConfig,
                      ),
                      outputRepo: writer.repoContext.outputRepo,
                      preStopped: preStop.stopped,
                      killProcess: () =>
                        Promise.reject(new Error("stopped twice")),
                    }),
                );
              } finally {
                tracker.close();
                await endCommand();
              }
            },
          );
          assertEquals(result.cancelled, [{
            runId: run.id,
            workflowName: workflow.name,
            previousStatus: "running",
          }]);
          const atServe = await statusAtServe(scratch, serve, workflow, run);
          assertEquals(atServe?.status, "cancelled");
          assertEquals(atServe?.tags.cancel_reason, "No longer needed");
          assertEquals(
            atServe?.jobs[0].steps[0].error,
            OWNER_STOPPED_STEP_ERROR,
          );
        } finally {
          await owner.stop();
        }
      });
    },
  });
}

Deno.test({
  name:
    "serve upstream cancel: in a member's checkout, a run whose owner died holding the writer, with its step's start in the journal alone, settles cancelled through serve with that step owner-stopped",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const env = {
        ...serveEnv(serve, "alice-token"),
        SWAMP_LOCK_TIMEOUT_MS: "5000",
      };
      const { workflow, run } = await startedRun(scratch, client, env, {
        journalled: true,
      });
      await plantV3WriterLease(
        serveUpstreamLocalRoot(client.repoDir, serve.origin, ""),
        { pid: GONE_PID, ttlMs: 10 * 60_000 },
      );

      const settled = await withClientEnv(
        scratch,
        env,
        ["workflow", "cancel"],
        async () => {
          const writer = await openCancelWriter(
            () =>
              requireInitializedRepoUnlocked({
                repoDir: client.repoDir,
                outputMode: "json",
              }),
            () => new UserError("the cancel was answered with writer busy"),
          );
          const tracker = RunTrackerStore.fromSwampDir(
            swampPath(client.repoDir),
          );
          try {
            return await runCommandInRootUnit(
              writer.repoContext,
              { push: undefined },
              () =>
                cancelLocalRun(run, workflow, "No longer needed", {
                  runRepo: writer.repoContext.workflowRunRepo,
                  findEvaluatedWorkflow: () => Promise.resolve(null),
                  runTracker: tracker,
                  runClaims: createWorkflowRunClaims(writer.datastoreConfig),
                  outputRepo: writer.repoContext.outputRepo,
                  preStopped: new Set([OWNER_PID]),
                  killProcess: () => Promise.reject(new Error("stopped twice")),
                }),
            );
          } finally {
            tracker.close();
            await endCommand();
          }
        },
      );
      assertEquals(settled?.status, "cancelled");
      const atServe = await statusAtServe(scratch, serve, workflow, run);
      assertEquals(atServe?.status, "cancelled");
      assertEquals(atServe?.jobs[0].steps[0].status, "failed");
      assertEquals(atServe?.jobs[0].steps[0].error, OWNER_STOPPED_STEP_ERROR);
    });
  },
});
