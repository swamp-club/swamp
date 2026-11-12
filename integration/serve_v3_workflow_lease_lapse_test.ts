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
import { assert, assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { workflowRunCommand } from "../src/cli/commands/workflow_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  commandLanded,
  resetCommandLandedForTesting,
} from "../src/infrastructure/datastore_v3/command_landed.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { tryAcquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import {
  type Client,
  endCommand,
  type Scratch,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

// alice-token authenticates as user:caller
const ALICE_ALL: readonly GrantSpec[] = [
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "caller", actions: ["read", "write"], kind: "data", pattern: "*" },
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "workflow",
    pattern: "*",
  },
];

/** the requirement: a member cut off from serve hears so within this */
const ENDS_WITHIN_MS = 45_000;
const MAY_LAND_CODE = "datastore_v3_commit_may_land";

/** a serve whose connection is silently dropped: stalled requests never answer */
interface StallProxy {
  readonly origin: string;
  readonly requests: { at: number; line: string }[];
  /** commits serve has answered */
  answeredCommits: number;
  inFlight: number;
  stall: boolean;
  down(): Promise<void>;
}

function startStallProxy(target: string): StallProxy {
  let unstall: () => void = () => {};
  const unstalled = new Promise<void>((resolve) => unstall = resolve);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      proxy.requests.push({
        at: performance.now(),
        line: `${request.method} ${url.pathname}`,
      });
      proxy.inFlight++;
      try {
        const body = request.body === null
          ? undefined
          : new Uint8Array(await request.arrayBuffer());
        if (proxy.stall) {
          await unstalled;
          return new Response("closing", { status: 503 });
        }
        const headers = new Headers(request.headers);
        headers.delete("host");
        const response = await fetch(
          `${target}${url.pathname}${url.search}`,
          {
            method: request.method,
            headers,
            ...(body !== undefined
              ? { body: body as Uint8Array<ArrayBuffer> }
              : {}),
          },
        );
        const answer = await response.arrayBuffer();
        if (request.method === "POST" && url.pathname.endsWith("/commits")) {
          proxy.answeredCommits++;
        }
        return new Response(answer, {
          status: response.status,
          headers: response.headers,
        });
      } finally {
        proxy.inFlight--;
      }
    },
  );
  let closed = false;
  const proxy: StallProxy = {
    origin: `http://127.0.0.1:${server.addr.port}`,
    requests: [],
    answeredCommits: 0,
    inFlight: 0,
    stall: false,
    async down() {
      if (closed) return;
      closed = true;
      unstall();
      await server.shutdown();
    },
  };
  return proxy;
}

/** s1's method waits here; the later steps record that they ran */
interface Steps {
  s1Started: boolean;
  release(): void;
  readonly later: string[];
}

function registerSteps(type: ModelType): Steps {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => release = resolve);
  const steps: Steps = { s1Started: false, release, later: [] };
  modelRegistry.invalidateType(type);
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    methods: {
      noop: {
        description: "does nothing",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      block: {
        description: "runs until the test lets it finish, or it is cancelled",
        kind: "read",
        arguments: z.object({}),
        execute: async (_args, context) => {
          steps.s1Started = true;
          const cancelled = new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          await Promise.race([released, cancelled]);
          return {};
        },
      },
      mark: {
        description: "records that a later step started",
        kind: "read",
        arguments: z.object({}),
        execute: (_args, context) => {
          steps.later.push(context.methodName);
          return Promise.resolve({});
        },
      },
    },
  });
  return steps;
}

interface Outcome {
  readonly ended: boolean;
  readonly exitCode: number;
  readonly code: unknown;
  readonly message: string | undefined;
}

async function assertWriterFree(client: Client, origin: string) {
  const release = await tryAcquireV3WriterLock(
    serveUpstreamLocalRoot(client.repoDir, origin, ""),
  );
  assert(release !== undefined, "the command released the writer lock");
  await release();
}

/**
 * runs `workflow run` as the binary does, cuts serve off once s1 runs, and
 * turns a thrown error into the exit code main.ts gives it
 */
async function runCutOff(
  scratch: Scratch,
  options: {
    readonly s1FinishesAfterCut: boolean;
    /** the cut catches s1's running checkpoint in flight */
    readonly checkpointInFlight?: boolean;
  },
): Promise<{ outcome: Outcome; steps: Steps }> {
  const serve = await scratch.serve({ grants: ALICE_ALL, managedConfig: true });
  const proxy = startStallProxy(serve.origin);
  try {
    const client = await scratch.client("a", { managedConfig: true });
    const env = serveEnv(proxy, "alice-token");
    const steps = registerSteps(serve.modelType);
    const workflow = Workflow.create({
      name: "long-run",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "s1",
            task: StepTask.modelMethod("web", "block"),
          }),
          ...["s2", "s3", "s4"].map((name, i) =>
            Step.create({
              name,
              task: StepTask.modelMethod("web", "mark"),
              dependsOn: [{
                step: i === 0 ? "s1" : `s${i + 1}`,
                condition: TriggerCondition.succeeded(),
              }],
            })
          ),
        ],
      })],
    });
    await writeCommand(
      scratch,
      client,
      env,
      (repos) => repos.workflowRepo.save(workflow),
    );

    resetCommandLandedForTesting();
    const exitCodeBefore = Deno.exitCode;
    Deno.exitCode = 0;
    let thrown: unknown;
    let done = false;
    try {
      const run = withClientEnv(scratch, env, ["workflow", "run"], async () => {
        const root = registerCompletionTypes(new Command())
          .globalOption("--json", "JSON output")
          .command("cmd", workflowRunCommand);
        // as mod.ts does for a v3 checkout: it runs locally, serve its upstream
        setImplicitServeRouting(false);
        try {
          await root.parse([
            "cmd",
            workflow.name,
            "--json",
            "--repo-dir",
            client.repoDir,
          ]);
        } finally {
          resetImplicitServeRouting();
          await endCommand();
        }
      }).catch((error) => {
        thrown = error;
      }).finally(() => {
        done = true;
      });

      await waitFor(() => steps.s1Started, "s1 to start", {
        timeoutMs: 120_000,
        intervalMs: 20,
      });
      if (options.checkpointInFlight !== true) {
        // as in the field: s1's running checkpoint landed, nothing in flight
        const answeredAtStart = proxy.answeredCommits;
        await waitFor(
          () => proxy.answeredCommits > answeredAtStart && proxy.inFlight === 0,
          "s1's checkpoint to land",
          { timeoutMs: 30_000, intervalMs: 20 },
        );
      }
      proxy.stall = true;
      if (options.s1FinishesAfterCut) steps.release();
      let ended = true;
      try {
        await waitFor(() => done, "the command to end after the cut", {
          timeoutMs: ENDS_WITHIN_MS,
          intervalMs: 50,
        });
      } catch {
        ended = false;
      }
      // a command still running is let go so its exit can be recorded
      steps.release();
      await proxy.down();
      await run;
      await assertWriterFree(client, proxy.origin);
      const exitCode = thrown === undefined
        ? Deno.exitCode
        : exitCodeForError(thrown, {
          commandLanded: commandLanded(),
          workflowCommand: true,
        });
      return {
        outcome: {
          ended,
          exitCode,
          code: (thrown as { code?: unknown } | undefined)?.code,
          message: thrown instanceof Error ? thrown.message : undefined,
        },
        steps,
      };
    } finally {
      Deno.exitCode = exitCodeBefore;
    }
  } finally {
    await proxy.down();
  }
}

function assertCutOffOutcome(outcome: Outcome, steps: Steps) {
  const seen = JSON.stringify(outcome);
  assertEquals(steps.later, [], `no step after s1 started: ${seen}`);
  assert(outcome.ended, `the command ended within the bound: ${seen}`);
  assert(
    outcome.exitCode === 75 ||
      (outcome.exitCode === 1 && outcome.code === MAY_LAND_CODE),
    `exit 75, or 1 only for a commit that may have landed: ${seen}`,
  );
}

Deno.test({
  name:
    "serve upstream workflow cut off: a lease that lapses while s1's release is in flight ends the run with exit 75, and no later step starts (swamp-club#4679)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const { outcome, steps } = await runCutOff(scratch, {
        s1FinishesAfterCut: true,
      });
      assertCutOffOutcome(outcome, steps);
    });
  },
});

Deno.test({
  name:
    "serve upstream workflow cut off: a lease that lapses while s1 still runs ends the run with exit 75, and no later step starts (swamp-club#4679)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const { outcome, steps } = await runCutOff(scratch, {
        s1FinishesAfterCut: false,
      });
      assertCutOffOutcome(outcome, steps);
    });
  },
});

Deno.test({
  name:
    "serve upstream workflow cut off: a lease that lapses while s1 still runs, its checkpoint cut in flight, ends the run with exit 75 or may-land (swamp-club#4679)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const { outcome, steps } = await runCutOff(scratch, {
        s1FinishesAfterCut: false,
        checkpointInFlight: true,
      });
      assertCutOffOutcome(outcome, steps);
    });
  },
});
