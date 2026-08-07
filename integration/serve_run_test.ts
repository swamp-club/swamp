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
 * Integration tests for running workflows through `swamp serve` with the
 * `--server` client path: a real serve connection handler over a real repo,
 * the wire codec, the terminal `done` frame, and renderer compatibility of
 * deserialized events.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  repoInit,
  withDefaults,
} from "../src/libswamp/mod.ts";
import { UserError } from "../src/domain/errors.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { handleConnection } from "../src/serve/connection.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { runWorkflowOverServer } from "../src/cli/remote_run.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { RunCancelRegistry } from "../src/serve/run_cancel_registry.ts";
import { createWorkflowRunRenderer } from "../src/presentation/renderers/workflow_run.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withServeRepo(
  fn: (args: { repoDir: string; url: string }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-serve-run-" });
  let shutdown: (() => Promise<void>) | null = null;
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        { path: repoDir, force: false, version: "20260101.120000.0" },
      ),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );

    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "serve-run-demo",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "echo",
              task: StepTask.directExecution(
                "command/shell",
                "serve-run-shell",
                "execute",
                { run: "echo serve-run-ok" },
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    const connectionCtx = {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      datastoreResolver: new DefaultDatastorePathResolver(
        resolvedRepoDir,
        datastoreConfig,
      ),
      syncService,
      authConfig: {
        mode: "none" as const,
        admins: [],
        allowedCollectives: [],
        allowedUsers: [],
        oauthProvider: "https://swamp-club.com",
        groupsField: "collectives",
        restrictedModelTypes: [],
        restrictedCommands: [],
      },
    };

    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(req);
          handleConnection(socket, connectionCtx, null);
          return response;
        }
        return new Response("Not found", { status: 404 });
      },
    );
    shutdown = () => server.shutdown();
    await fn({ repoDir, url: `ws://127.0.0.1:${server.addr.port}` });
  } finally {
    await shutdown?.();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "serve run: a workflow runs over the wire, events satisfy the renderer, done terminates",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async ({ url }) => {
      const kinds: string[] = [];
      const renderer = createWorkflowRunRenderer("log", {
        workflowName: "serve-run-demo",
      });
      const handlers = renderer.handlers();

      for await (
        const event of runWorkflowOverServer({
          server: url,
          payload: { workflowIdOrName: "serve-run-demo" },
        })
      ) {
        kinds.push(event.kind);
        // Feed the SAME renderer a local run uses — this is the
        // renderer-compatibility contract for the wire codec.
        const handler =
          (handlers as Record<string, (e: unknown) => void>)[event.kind];
        handler?.(event as unknown as WorkflowRunEvent);
      }

      assertEquals(kinds.includes("started"), true);
      assertEquals(kinds.includes("step_completed"), true);
      assertEquals(kinds.at(-1), "completed");
      assertEquals(renderer.workflowFailed(), false);
    });
  },
});

Deno.test({
  name:
    "serve run: an unknown workflow surfaces through the renderer exactly like a local run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async ({ url }) => {
      // Unknown workflows yield an `error` EVENT (not an error frame), and
      // the renderer's error handler throws — identical to local behavior.
      const renderer = createWorkflowRunRenderer("log", {
        workflowName: "no-such-workflow",
      });
      const handlers = renderer.handlers() as Record<
        string,
        (e: unknown) => void
      >;
      const error = await assertRejects(async () => {
        for await (
          const event of runWorkflowOverServer({
            server: url,
            payload: { workflowIdOrName: "no-such-workflow" },
          })
        ) {
          handlers[event.kind]?.(event as unknown as WorkflowRunEvent);
        }
      }, UserError);
      assertStringIncludes(error.message, "not found");
    });
  },
});

// ── Detached run path (with ActiveRunRegistry) ──────────────────────────

async function withDetachedServeRepo(
  registryOpts: { maxConcurrent?: number; maxPerPrincipal?: number },
  fn: (args: {
    repoDir: string;
    url: string;
    registry: ActiveRunRegistry;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-serve-detach-" });
  let shutdown: (() => Promise<void>) | null = null;
  const registry = new ActiveRunRegistry(registryOpts);
  try {
    await consumeStream(
      repoInit(
        createLibSwampContext({}),
        createRepoInitDeps("20260101.120000.0"),
        { path: repoDir, force: false, version: "20260101.120000.0" },
      ),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );

    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "detach-demo",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "echo",
              task: StepTask.directExecution(
                "command/shell",
                "detach-shell",
                "execute",
                { run: "echo detach-ok" },
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    const connectionCtx = {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      datastoreResolver: new DefaultDatastorePathResolver(
        resolvedRepoDir,
        datastoreConfig,
      ),
      syncService,
      authConfig: {
        mode: "none" as const,
        admins: [],
        allowedCollectives: [],
        allowedUsers: [],
        oauthProvider: "https://swamp-club.com",
        groupsField: "collectives",
        restrictedModelTypes: [],
        restrictedCommands: [],
      },
      activeRunRegistry: registry,
      cancelRegistry: new RunCancelRegistry(),
    };

    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(req);
          handleConnection(socket, connectionCtx, null);
          return response;
        }
        return new Response("Not found", { status: 404 });
      },
    );
    shutdown = () => server.shutdown();
    await fn({
      repoDir,
      url: `ws://127.0.0.1:${server.addr.port}`,
      registry,
    });
  } finally {
    await shutdown?.();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "serve detached: workflow runs through the detached path, events stream, completion settles",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withDetachedServeRepo({}, async ({ url, registry }) => {
      const kinds: string[] = [];
      for await (
        const event of runWorkflowOverServer({
          server: url,
          payload: { workflowIdOrName: "detach-demo" },
        })
      ) {
        kinds.push(event.kind);
      }

      assertEquals(kinds.includes("started"), true);
      assertEquals(kinds.at(-1), "completed");

      await registry.drainAll(5_000);
      assertEquals(registry.size, 0);
    });
  },
});

Deno.test({
  name:
    "serve detached: rejected registration returns error, no run in registry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withDetachedServeRepo(
      { maxConcurrent: 1 },
      async ({ url, registry }) => {
        // Start run 1 without consuming all events (let it detach),
        // then try run 2 while the slot is full.
        const iterable = runWorkflowOverServer({
          server: url,
          payload: { workflowIdOrName: "detach-demo" },
        });
        const iter = iterable[Symbol.asyncIterator]();

        // Read first event (started) — run is now registered
        const first = await iter.next();
        assertEquals(first.done, false);
        assertEquals(registry.size, 1);

        // Try a second run while slot is full
        const error = await assertRejects(async () => {
          for await (
            const _ of runWorkflowOverServer({
              server: url,
              payload: { workflowIdOrName: "detach-demo" },
            })
          ) { /* consume */ }
        }, UserError);

        // Verify rejection message contains no numeric limit
        assertEquals(error.message.includes("100"), false);
        assertEquals(error.message.includes("limit:"), false);
        assertStringIncludes(error.message, "Too many concurrent runs");

        // Drain the first run
        let done = false;
        while (!done) {
          const r = await iter.next();
          done = r.done ?? false;
        }
        await registry.drainAll(5_000);
        assertEquals(registry.size, 0);
      },
    );
  },
});
