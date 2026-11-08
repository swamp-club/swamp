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
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { z } from "zod";
import {
  acquireModelLocks,
  acquirePublishLocksOrDefer,
  createWorkflowRunLock,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  commandStopSignal,
  registerShutdownHandler,
  resetCommandStopForTesting,
} from "../src/infrastructure/process/shutdown_handlers.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { createSyncGate } from "../src/serve/sync_gate.ts";
import {
  endCommand,
  MEMBER,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

Deno.test({
  name:
    "serve upstream: a command told to stop while its data write is under way lets the write land, and the run is recorded cancelled (swamp-club#4512)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetCommandStopForTesting();
    try {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve({
          models: ["writer"],
          grants: [
            ...MEMBER,
            {
              actions: ["read", "write", "run"],
              kind: "workflow",
              pattern: "*",
            },
          ],
        });
        const alice = await scratch.client("a");
        const type = serve.modelType;
        const stopRequests: (() => void)[] = [];
        const shutdown = registerShutdownHandler({
          handler: () => {},
          stopsCatchUps: true,
        }, {
          os: "windows",
          listenForStopRequests: (handler) => {
            stopRequests.push(handler);
            return () => {};
          },
        });
        const controller = new AbortController();
        const writer = Definition.create({
          id: serve.models.writer,
          name: "writer",
          type: type.normalized,
        });
        modelRegistry.invalidateType(type);
        modelRegistry.register({
          type,
          version: "2026.01.01.1",
          globalArguments: z.object({}),
          resources: {
            record: {
              description: "the side effect's record",
              schema: z.object({ call: z.number() }),
              lifetime: "infinite",
              garbageCollection: 10,
            },
          },
          methods: {
            touch: {
              description: "is told to stop, then records its side effect",
              arguments: z.object({}),
              execute: async (_args, context) => {
                stopRequests[0]();
                controller.abort(new Error("run cancelled"));
                const handle = await context.writeResource!(
                  "record",
                  "record",
                  { call: 1 },
                );
                return { dataHandles: [handle] };
              },
            },
          },
        });
        try {
          await writeCommand(
            scratch,
            alice,
            serveEnv(serve, "alice-token"),
            async (repos) => {
              await repos.definitionRepo.save(type, writer);
              await repos.workflowRepo.save(Workflow.create({
                name: "stopped-write",
                jobs: [
                  Job.create({
                    name: "main",
                    steps: [
                      Step.create({
                        name: "only",
                        task: StepTask.modelMethod("writer", "touch"),
                      }),
                    ],
                  }),
                ],
              }));
            },
          );
          await withClientEnv(
            scratch,
            serveEnv(serve, "alice-token"),
            ["workflow", "run"],
            async () => {
              try {
                const ctx = await requireInitializedRepoUnlocked({
                  repoDir: alice.repoDir,
                  outputMode: "json",
                });
                let outcome: string | undefined;
                await executeWorkflowWithLocks(
                  alice.repoDir,
                  ctx.repoContext,
                  ctx.datastoreConfig,
                  {
                    workflowIdOrName: "stopped-write",
                    inputs: {},
                    initiatedBy: "user:caller",
                  },
                  controller.signal,
                  (event: WorkflowRunEvent) => {
                    if (event.kind === "cancelled") outcome = event.run.status;
                  },
                  ctx.syncService,
                  undefined,
                  { syncGate: createSyncGate() },
                );
                assert(commandStopSignal().aborted, "the stop fired");
                assertEquals(outcome, "cancelled");
                assertExists(
                  await ctx.repoContext.unifiedDataRepo.findByName(
                    type,
                    writer.id,
                    "record",
                  ),
                );
              } finally {
                await endCommand();
              }
            },
          );
          const landed = (await serve.log())
            .flatMap((entry) => entry.keys)
            .filter((key) => key.includes("/record/"));
          assert(landed.length > 0, "the write reached serve");
        } finally {
          shutdown.dispose();
          modelRegistry.invalidateType(type);
        }
      });
    } finally {
      resetCommandStopForTesting();
    }
  },
});

Deno.test({
  name:
    "serve upstream: once a command is told to stop, a publish and a run claim still take their locks and catch up, while a new model lock does not (swamp-club#4512)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    resetCommandStopForTesting();
    try {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve({
          grants: [
            ...MEMBER,
            {
              actions: ["read", "write", "run"],
              kind: "workflow",
              pattern: "*",
            },
          ],
        });
        const alice = await scratch.client("a");
        const type = serve.modelType;
        const model = {
          modelType: type.normalized,
          modelId: serve.models.web,
        };
        const stopRequests: (() => void)[] = [];
        const shutdown = registerShutdownHandler({
          handler: () => {},
          stopsCatchUps: true,
        }, {
          os: "windows",
          listenForStopRequests: (handler) => {
            stopRequests.push(handler);
            return () => {};
          },
        });
        try {
          await withClientEnv(
            scratch,
            serveEnv(serve, "alice-token"),
            ["model", "method"],
            async () => {
              try {
                const ctx = await requireInitializedRepoUnlocked({
                  repoDir: alice.repoDir,
                  outputMode: "json",
                });
                stopRequests[0]();
                await assertRejects(() =>
                  acquireModelLocks(
                    ctx.datastoreConfig,
                    [model],
                    alice.repoDir,
                    ctx.syncService,
                    ctx.repoContext.catalogStore,
                    () => {},
                    { repoContext: ctx.repoContext },
                  )
                );
                const publish = await acquirePublishLocksOrDefer(
                  ctx.datastoreConfig,
                  model,
                  [],
                  alice.repoDir,
                  ctx.syncService,
                  ctx.repoContext.catalogStore,
                  { repoContext: ctx.repoContext },
                );
                assertExists(publish, "the publish was not deferred");
                await publish.release();
                // a stopped resume puts its suspended run back under this claim
                const claim = await createWorkflowRunLock(
                  ctx.datastoreConfig,
                  crypto.randomUUID(),
                );
                await claim.acquire();
                await claim.release();
              } finally {
                await endCommand();
              }
            },
          );
        } finally {
          shutdown.dispose();
        }
      });
    } finally {
      resetCommandStopForTesting();
    }
  },
});
