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
 * Integration test for `swamp workflow run --server --detach`
 * (swamp-club#1090): the CLI's run client against serve's connection
 * dispatch and detached `workflow.run` handler, over a real WebSocket and a
 * real repository on disk. The workflow's one step waits on a gate the test
 * holds, so each assertion is made while the run is known to be running.
 */

import { join } from "@std/path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { runWorkflowOverServer } from "../src/cli/remote_run.ts";
import {
  createConnectionTeardown,
  handleMessage,
} from "../src/serve/connection.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-run-detach-" });
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

/** Serves `ctx` over WebSocket on a free port, as serve's connection does. */
function serveConnections(ctx: ConnectionContext) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      const activeRequests = new Map<string, AbortController>();
      socket.onmessage = (event) =>
        handleMessage(socket, ctx, activeRequests, event);
      socket.onclose = createConnectionTeardown({
        ctx,
        activeRequests,
        activeSubscriptions: new Set(),
        subscriptionTimers: new Map(),
        sessionTimeout: null,
        workerAttachment: undefined,
      });
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

/** Submits a detached run and returns the id the server started it under. */
async function submitDetached(
  server: string,
  workflowName: string,
): Promise<string> {
  let runId: string | undefined;
  for await (
    const event of runWorkflowOverServer({
      server,
      payload: { workflowIdOrName: workflowName, inputs: {} },
      detach: true,
    })
  ) {
    if (event.kind === "started") runId = event.runId as string;
  }
  assert(runId !== undefined, "the detached stream ended at started");
  return runId;
}

/**
 * Follows a run by id over `run.attach` and returns its event kinds.
 * `onAttached` runs once serve has accepted the attach, so a caller holding
 * the run open can release it knowing the run cannot finish first.
 */
function attachUntilDone(
  server: string,
  runId: string,
  onAttached: () => void,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const kinds: string[] = [];
    const socket = new WebSocket(server);
    socket.onopen = () =>
      socket.send(JSON.stringify({
        type: "run.attach",
        id: "attach-1",
        payload: { runId, afterSeq: 0 },
      }));
    socket.onmessage = (message) => {
      const frame = JSON.parse(message.data as string) as {
        type: string;
        event?: { kind: string };
        error?: { message: string };
      };
      if (frame.type === "run.attached") onAttached();
      if (frame.type === "event" && frame.event) kinds.push(frame.event.kind);
      if (frame.type === "done") {
        socket.close();
        resolve(kinds);
      }
      if (frame.type === "error") {
        socket.close();
        reject(new Error(frame.error?.message ?? "run.attach failed"));
      }
    };
    socket.onerror = () => reject(new Error("run.attach socket failed"));
  });
}

Deno.test({
  name:
    "workflow run --detach: returns the id of a recorded run that keeps running on the server (swamp-club#1090)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const modelType = ModelType.create(
        `test/run-detach-${crypto.randomUUID()}`,
      );
      let methodStarts = 0;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      modelRegistry.register({
        type: modelType,
        version: "2026.01.01.1",
        globalArguments: z.object({}),
        resources: {},
        methods: {
          wait: {
            description: "waits until the test opens the gate",
            arguments: z.object({}),
            execute: async () => {
              methodStarts++;
              await gate;
              return { dataHandles: [] };
            },
          },
        },
      });

      try {
        const workflow = Workflow.create({
          name: `run-detach-${crypto.randomUUID()}`,
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "slow",
              task: StepTask.model("waiter", "wait"),
            })],
          })],
        });
        await new YamlWorkflowRepository(repoDir).save(workflow);
        const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
          await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
        await repoContext.definitionRepo.save(
          modelType,
          Definition.create({ name: "waiter", type: modelType.normalized }),
        );

        const registry = new ActiveRunRegistry({ maxConcurrent: 2 });
        const server = serveConnections({
          repoDir: resolved,
          repoContext,
          datastoreConfig,
          syncService,
          authConfig: { mode: "none", restrictedCommands: [] },
          activeRunRegistry: registry,
        } as unknown as ConnectionContext);
        const recordedStatus = async (runId: string) =>
          (await repoContext.workflowRunRepo.findById(
            createWorkflowId(workflow.id),
            createWorkflowRunId(runId),
          ))?.status;

        try {
          // The client returns while the step is still waiting, and the id it
          // returns already names a recorded run.
          const first = await submitDetached(server.url, workflow.name);
          assertEquals(await recordedStatus(first), "running");
          await waitFor(() => methodStarts === 1, "the first run's step");
          assert(registry.get(first) !== undefined);

          // A second run of the same workflow overlaps the first.
          const second = await submitDetached(server.url, workflow.name);
          assert(second !== first);
          assertEquals(await recordedStatus(second), "running");
          assertEquals(registry.size, 2);

          // Serve's run limit is the only backpressure a detached caller has.
          await assertRejects(
            () => submitDetached(server.url, workflow.name),
            UserError,
            "Too many concurrent runs",
          );

          // The returned id reattaches to the run, from its first event. The
          // step is released only once serve has accepted the attach, so
          // the run is still active when it does (swamp-club#3638).
          const kinds = await attachUntilDone(server.url, first, openGate);
          assertEquals(kinds[0], "validating_inputs");
          assert(kinds.includes("started"));
          assertEquals(kinds.at(-1), "completed");

          await waitFor(() => registry.size === 0, "both runs to finish");
          assertEquals(methodStarts, 2);
          assertEquals(await recordedStatus(first), "succeeded");
          assertEquals(await recordedStatus(second), "succeeded");
        } finally {
          openGate();
          await waitFor(() => registry.size === 0, "runs to finish");
          await server.shutdown();
        }
      } finally {
        modelRegistry.invalidateType(modelType);
      }
    });
  },
});
