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
import { closeV3DatastoresAfterFailure } from "../src/cli/v3_teardown.ts";
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
  commandMayHaveLanded,
  resetCommandLandedForTesting,
} from "../src/infrastructure/datastore_v3/command_landed.ts";
import { listWriterMarkerFiles } from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { tryAcquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  type ReadableSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  exitCodeForError,
  renderError,
} from "../src/presentation/output/error_output.ts";
import {
  type Client,
  endCommand,
  type Scratch,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server.ts";

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

/** a hang, not a latency bound: each case waits out the real lease */
const ENDS_WITHIN_MS = 240_000;
const MAY_LAND_CODE = "datastore_v3_commit_may_land";
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** a serve whose connection is silently dropped: stalled requests never answer */
interface StallProxy {
  readonly origin: string;
  /** run-partition commits answered since `arm` */
  answeredRunCommits: number;
  inFlight: number;
  stall: boolean;
  /** from now, the first run-partition commit cuts serve off as it is sent */
  armed: boolean;
  down(): Promise<void>;
}

/** a single commit names its partition in the path, a batch in its header */
function commitsRunPartition(url: URL, body: Uint8Array | undefined): boolean {
  if (url.pathname.includes("/partitions/run--")) return true;
  if (!url.pathname.endsWith("/commits") || body === undefined) return false;
  if (body.byteLength < 4) return false;
  const length = new DataView(body.buffer, body.byteOffset).getUint32(0);
  try {
    const header = JSON.parse(
      new TextDecoder().decode(body.subarray(4, 4 + length)),
    ) as { items?: { partition?: unknown }[] };
    return header.items?.some((item) =>
      typeof item.partition === "string" && item.partition.startsWith("run--")
    ) ?? false;
  } catch {
    return false;
  }
}

function startStallProxy(target: string): StallProxy {
  let unstall: () => void = () => {};
  const unstalled = new Promise<void>((resolve) => unstall = resolve);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      proxy.inFlight++;
      try {
        const body = request.body === null
          ? undefined
          : new Uint8Array(await request.arrayBuffer());
        const runCommit = request.method === "POST" &&
          url.pathname.endsWith("/commits") && commitsRunPartition(url, body);
        if (runCommit && proxy.armed && !proxy.stall) proxy.stall = true;
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
        if (runCommit) proxy.answeredRunCommits++;
        return new Response(
          NULL_BODY_STATUSES.has(response.status) ? null : answer,
          { status: response.status, headers: response.headers },
        );
      } finally {
        proxy.inFlight--;
      }
    },
  );
  let closed = false;
  const proxy: StallProxy = {
    origin: `http://127.0.0.1:${server.addr.port}`,
    answeredRunCommits: 0,
    inFlight: 0,
    stall: false,
    armed: false,
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
  /** called as s1 starts, before anything after its start is sent */
  onS1Start: () => void;
  release(): void;
  readonly later: string[];
}

function registerSteps(type: ModelType): Steps {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => release = resolve);
  const steps: Steps = {
    s1Started: false,
    onS1Start: () => {},
    release,
    later: [],
  };
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
          steps.onS1Start();
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
  readonly shownCode: unknown;
  readonly message: string | undefined;
  readonly mayHaveLanded: boolean;
  readonly markerKept: boolean;
  readonly teardownRecoveries: number;
}

async function assertWriterFree(client: Client, origin: string) {
  const release = await tryAcquireV3WriterLock(
    serveUpstreamLocalRoot(client.repoDir, origin, ""),
  );
  assert(release !== undefined, "the command released the writer lock");
  await release();
}

/** the code main.ts reports for the error, as its JSON output shows it */
function renderedCode(
  error: unknown,
  context: Parameters<typeof renderError>[3],
): unknown {
  const printed: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    renderError(error, "json", "behavior", context);
  } finally {
    console.error = consoleError;
  }
  return (JSON.parse(printed.join("\n")) as { code?: unknown }).code;
}

function droppedWorkRecoveries(spans: readonly ReadableSpan[]): number {
  return spans.filter((span) =>
    span.name === "swamp.datastore.v3.readmodel.recover" &&
    span.attributes["swamp.datastore.v3.readmodel.recover.entry"] ===
      "dropped_work"
  ).length;
}

/**
 * runs `workflow run` as the binary does, cuts serve off once s1 runs, and
 * turns a thrown error into the exit code and code main.ts gives it
 */
async function runCutOff(
  scratch: Scratch,
  options: {
    readonly s1FinishesAfterCut: boolean;
    /** the cut catches the first run checkpoint after s1 starts in flight */
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
    steps.onS1Start = () => {
      if (options.checkpointInFlight === true) proxy.armed = true;
      proxy.answeredRunCommits = 0;
    };
    const exitCodeBefore = Deno.exitCode;
    Deno.exitCode = 0;
    let thrown: unknown;
    let done = false;
    let teardownRecoveries = 0;
    try {
      const run = withCapturedSpans(async (spans) => {
        try {
          await withClientEnv(scratch, env, ["workflow", "run"], async () => {
            const root = registerCompletionTypes(new Command())
              .globalOption("--json", "JSON output")
              .command("cmd", workflowRunCommand);
            setImplicitServeRouting(false);
            try {
              await root.parse([
                "cmd",
                workflow.name,
                "--json",
                "--repo-dir",
                client.repoDir,
              ]);
            } catch (error) {
              // as mod.ts tears down a failed command
              await flushDatastoreSync();
              thrown = await closeV3DatastoresAfterFailure(error);
            } finally {
              resetImplicitServeRouting();
              await endCommand();
            }
          });
        } catch (error) {
          thrown = error;
        } finally {
          teardownRecoveries = droppedWorkRecoveries(spans);
          done = true;
        }
      });

      await waitFor(() => steps.s1Started, "s1 to start", {
        timeoutMs: 120_000,
        intervalMs: 20,
      });
      if (options.checkpointInFlight !== true) {
        await waitFor(
          () => proxy.answeredRunCommits > 0 && proxy.inFlight === 0,
          "s1's checkpoint to land",
          { timeoutMs: 60_000, intervalMs: 20 },
        );
        proxy.stall = true;
      } else {
        await waitFor(() => proxy.stall, "s1's checkpoint to be cut off", {
          timeoutMs: 60_000,
          intervalMs: 20,
        });
      }
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
      const context = {
        commandLanded: commandLanded(),
        commandMayHaveLanded: commandMayHaveLanded(),
        workflowCommand: true,
      };
      const exitCode = thrown === undefined
        ? Deno.exitCode
        : exitCodeForError(thrown, context);
      const code = (thrown as { code?: unknown } | undefined)?.code;
      return {
        outcome: {
          ended,
          exitCode,
          code,
          shownCode: thrown === undefined
            ? undefined
            : renderedCode(thrown, context),
          message: thrown instanceof Error ? thrown.message : undefined,
          mayHaveLanded: context.commandMayHaveLanded,
          markerKept: (await listWriterMarkerFiles(client.repoDir)).length > 0,
          teardownRecoveries,
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
  assert(outcome.ended, `the command ended: ${seen}`);
  assert(
    outcome.exitCode === 75 ||
      (outcome.exitCode === 1 && outcome.shownCode === MAY_LAND_CODE),
    `exit 75, or 1 only for a commit that may have landed: ${seen}`,
  );
  assertEquals(
    outcome.teardownRecoveries,
    0,
    `teardown left the dropped work to the next command: ${seen}`,
  );
  assert(outcome.markerKept, `the dropped-work marker is kept: ${seen}`);
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
