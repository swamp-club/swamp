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
 * the member under test runs the real `model method run` in a ProcessRuntime of
 * its own; what its read model applied is read from its state file between
 * commands, or while its run is held at its write
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
} from "../src/cli/commands/model_method_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { PartitionKey } from "../src/domain/datastore_v3/partition_key.ts";
import {
  type MethodContext,
  modelRegistry,
} from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { SCOPED_BACKLOG_MAX_ENV_VAR } from "../src/infrastructure/datastore_v3/scoped_read_model.ts";
import { READ_MODEL_STATE_FILE } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import {
  scopedSyncReadTripwireForTesting,
  setScopedFeedApplyMsForTesting,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  type Client,
  endCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server.ts";
import {
  workflowRunHost,
  type WorkflowRunWorkerMessage,
  type WorkflowRunWorkerRequest,
} from "./serve_upstream_workflow_run.ts";
import { type ProcessHost, startProcessHost } from "./process_host.ts";

await initializeLogging({});

const A_TOKEN = "alice-token";
const B_TOKEN = "bob-token";
const GRANTS: readonly GrantSpec[] = ["caller", "bob"].flatMap((user) =>
  [
    { user, actions: ["read", "write", "run"], kind: "model", pattern: "*" },
    { user, actions: ["read", "write"], kind: "data", pattern: "*" },
    { user, actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
  ] satisfies GrantSpec[]
);

const CONSUMER = "consumer";
const PRODUCERS = ["producer1", "producer2"] as const;

/** the behavior a sync-reading method reads, by id */
let readTarget: string | undefined;
/** a run in this checkout waits here once its write is allocated */
const holds = new Map<string, Promise<void>>();
const holding = new Set<string>();
/** what each sync-reading method body saw */
const seen: { readonly via: string; readonly value: unknown }[] = [];

function registerMethods(type: ModelType): void {
  modelRegistry.invalidateType(type);
  const write = async (context: MethodContext) => {
    const handle = await context.writeResource!("out", "out", {
      body: crypto.randomUUID(),
    });
    const held = holds.get(context.repoDir);
    if (held !== undefined) {
      holding.add(context.repoDir);
      await held;
    }
    return { dataHandles: [handle] };
  };
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    globalArguments: z.object({ tag: z.string().default("") }),
    resources: {
      out: {
        description: "One data version per run",
        schema: z.object({ body: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      stamp: {
        description: "Writes one version",
        kind: "update",
        arguments: z.object({}),
        execute: (_args, context) => write(context),
      },
      syncPeek: {
        description: "Reads another behavior synchronously, with no barrier",
        kind: "update",
        arguments: z.object({}),
        execute: (_args, context) => {
          const items = context.dataRepository.findAllForModelSync(
            context.modelType,
            readTarget!,
          );
          seen.push({ via: "syncPeek", value: items.length });
          return write(context);
        },
      },
      barrierPeek: {
        description: "Reads another behavior after its async read's barrier",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          await context.dataRepository.findAllForModel(
            context.modelType,
            readTarget!,
          );
          const items = context.dataRepository.findAllForModelSync(
            context.modelType,
            readTarget!,
          );
          seen.push({ via: "barrierPeek", value: items.length });
          return write(context);
        },
      },
    },
  });
}

type MethodRunRequest = {
  readonly configDir: string;
  readonly repoDir: string;
  readonly env: Record<string, string | undefined>;
  readonly model: string;
  readonly method: string;
  readonly feedApplyMs?: number;
};

type MethodRunMessage =
  | {
    readonly kind: "done";
    readonly error?: string;
    readonly exitCode: number;
  }
  | { readonly kind: "failed"; readonly error: string };

/** a member's `model method run`, with the sync-read tripwire on */
const methodRunHost: ProcessHost<MethodRunRequest, MethodRunMessage> =
  (post) => (request) => {
    (async () => {
      await initializeLogging({});
      using _tripwire = scopedSyncReadTripwireForTesting();
      using _interval = request.feedApplyMs === undefined
        ? undefined
        : setScopedFeedApplyMsForTesting(request.feedApplyMs);
      let error: string | undefined;
      Deno.exitCode = 0;
      try {
        await withClientEnv(
          { configDir: request.configDir },
          request.env,
          ["model", "method", "run"],
          async () => {
            const root = registerCompletionTypes(new Command())
              .globalOption("--json", "JSON output")
              .command(
                "cmd",
                createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX),
              );
            setImplicitServeRouting(false);
            try {
              await root.parse([
                "cmd",
                request.model,
                request.method,
                "--json",
                "--repo-dir",
                request.repoDir,
              ]);
            } finally {
              resetImplicitServeRouting();
              await endCommand();
            }
          },
        );
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      post({
        kind: "done",
        ...(error === undefined ? {} : { error }),
        exitCode: Deno.exitCode,
      });
    })().catch((error) =>
      post({
        kind: "failed",
        error: error instanceof Error
          ? error.stack ?? error.message
          : String(error),
      })
    );
  };

interface Run {
  readonly done: () => boolean;
  readonly result: Promise<{ error?: string; exitCode: number }>;
}

function methodRun(
  team: Team,
  client: Client,
  token: string,
  model: string,
  method: string,
  options: {
    readonly env?: Record<string, string>;
    readonly feedApplyMs?: number;
  } = {},
): Run {
  let done: Extract<MethodRunMessage, { kind: "done" }> | undefined;
  let failed: string | undefined;
  const member = startProcessHost(token, methodRunHost, (message) => {
    if (message.kind === "done") done = message;
    else failed = message.error;
  });
  member.postMessage({
    configDir: team.scratch.configDir,
    repoDir: client.repoDir,
    env: { ...serveEnv(team.serve, token), ...options.env },
    model,
    method,
    ...(options.feedApplyMs === undefined
      ? {}
      : { feedApplyMs: options.feedApplyMs }),
  });
  const result = (async () => {
    try {
      await waitFor(
        () => done !== undefined || failed !== undefined,
        `${token}'s ${model} ${method}`,
        { timeoutMs: 240_000, intervalMs: 50 },
      );
    } finally {
      member.terminate();
    }
    if (done === undefined) throw new Error(`member failed: ${failed}`);
    return {
      ...(done.error === undefined ? {} : { error: done.error }),
      exitCode: done.exitCode,
    };
  })();
  return { done: () => done !== undefined || failed !== undefined, result };
}

async function runOk(
  team: Team,
  client: Client,
  token: string,
  model: string,
  method: string,
  options?: { readonly env?: Record<string, string> },
): Promise<void> {
  const exitCode = Deno.exitCode;
  try {
    assertEquals(
      await methodRun(team, client, token, model, method, options).result,
      { exitCode: 0 },
      `${model} ${method}`,
    );
  } finally {
    Deno.exitCode = exitCode;
  }
}

function holdRuns(client: Client): { release: () => void } {
  let release = () => {};
  holds.set(client.repoDir, new Promise<void>((resolve) => release = resolve));
  return {
    release: () => {
      holds.delete(client.repoDir);
      holding.delete(client.repoDir);
      release();
    },
  };
}

interface Team {
  readonly scratch: Scratch;
  readonly serve: Serve;
  readonly a: Client;
  readonly b: Client;
  readonly ids: Record<string, string>;
}

async function withTeam(fn: (team: Team) => Promise<void>): Promise<void> {
  holds.clear();
  holding.clear();
  seen.length = 0;
  await withScratch(async (scratch) => {
    const serve = await scratch.serve({
      grants: GRANTS,
      managedConfig: true,
      commitFeed: true,
    });
    registerMethods(serve.modelType);
    const a = await scratch.client("a", { managedConfig: true });
    const b = await scratch.client("b", { managedConfig: true });
    const ids = Object.fromEntries(
      [CONSUMER, ...PRODUCERS].map((name) => [name, crypto.randomUUID()]),
    );
    const team = { scratch, serve, a, b, ids };
    await saveDefinitions(team, "t1");
    // a's first command applies the whole feed: its read model never completed
    await runOk(team, a, A_TOKEN, CONSUMER, "stamp");
    await fn(team);
  });
}

async function saveDefinitions(
  team: Pick<Team, "scratch" | "serve" | "b" | "ids">,
  tag: string,
  names: readonly string[] = [CONSUMER, ...PRODUCERS],
): Promise<void> {
  await writeCommand(
    team.scratch,
    team.b,
    serveEnv(team.serve, B_TOKEN),
    async (repos) => {
      for (const name of names) {
        await repos.definitionRepo.save(
          team.serve.modelType,
          Definition.create({
            id: team.ids[name],
            name,
            globalArguments: { tag },
          }),
        );
      }
    },
  );
}

/** what the member's read model has applied, read from its state file */
function applied(team: Team, client: Client): {
  readonly cursor: number;
  seqOf(name: string): number;
  configSeqOf(name: string): number;
} {
  const db = new DatabaseSync(
    join(readModelStateDir(client.repoDir), READ_MODEL_STATE_FILE),
    { readOnly: true },
  );
  try {
    const cursor = (db.prepare(
      "SELECT value FROM meta WHERE key = 'cursor'",
    ).get() as { value: number } | undefined)?.value ?? 0;
    const seqs = new Map(
      (db.prepare(
        "SELECT partition, applied_seq FROM partition_progress",
      ).all() as { partition: string; applied_seq: number }[]).map((row) => [
        row.partition,
        row.applied_seq,
      ]),
    );
    return {
      cursor,
      seqOf: (name) =>
        seqs.get(
          PartitionKey.forModel(team.serve.modelType.normalized, team.ids[name])
            .toString(),
        ) ?? 0,
      configSeqOf: (name) =>
        seqs.get(`config--model--${encodeURIComponent(name)}`) ?? 0,
    };
  } finally {
    db.close();
  }
}

/** each partition's head at serve */
async function headsAtServe(team: Team): Promise<{
  seqOf(name: string): number;
  configSeqOf(name: string): number;
}> {
  const heads = new Map<string, number>();
  for (const entry of await team.serve.log()) {
    heads.set(
      entry.partition,
      Math.max(heads.get(entry.partition) ?? 0, entry.seq),
    );
  }
  return {
    seqOf: (name) =>
      heads.get(
        PartitionKey.forModel(team.serve.modelType.normalized, team.ids[name])
          .toString(),
      ) ?? 0,
    configSeqOf: (name) =>
      heads.get(`config--model--${encodeURIComponent(name)}`) ?? 0,
  };
}

async function stampProducers(team: Team): Promise<void> {
  for (const name of PRODUCERS) {
    await runOk(team, team.b, B_TOKEN, name, "stamp");
  }
}

Deno.test({
  name:
    "scoped apply: a member's method run applies what it locks and every definition, not the behaviors another member wrote; a workflow run applies them all",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const { a, b } = team;
      const before = applied(team, a);
      await stampProducers(team);
      await saveDefinitions(team, "t2", [PRODUCERS[0]]);
      const atB = await headsAtServe(team);

      await runOk(team, a, A_TOKEN, CONSUMER, "stamp");
      const scoped = applied(team, a);
      for (const name of PRODUCERS) {
        assertEquals(scoped.seqOf(name), before.seqOf(name), name);
        assert(atB.seqOf(name) > before.seqOf(name), `${name} was written`);
      }
      assertEquals(scoped.cursor, before.cursor, "the cursor stays behind");
      assert(scoped.seqOf(CONSUMER) > before.seqOf(CONSUMER));
      assertEquals(
        scoped.configSeqOf(PRODUCERS[0]),
        atB.configSeqOf(PRODUCERS[0]),
        "the definition another member changed is applied",
      );

      const workflow = Workflow.create({
        name: `scoped-${crypto.randomUUID().slice(0, 8)}`,
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "stamp",
            task: StepTask.modelMethod(CONSUMER, "stamp"),
          })],
        })],
      });
      await writeCommand(
        team.scratch,
        b,
        serveEnv(team.serve, B_TOKEN),
        (repos) => repos.workflowRepo.save(workflow),
      );
      assertEquals(await runWorkflow(team, a, workflow.name), {
        statuses: ["succeeded"],
        errors: [],
      });
      const whole = applied(team, a);
      for (const name of PRODUCERS) {
        assertEquals(whole.seqOf(name), atB.seqOf(name), name);
      }
    });
  },
});

Deno.test({
  name:
    "scoped apply: a member whose read model lags past the backlog bound applies the whole feed when its method run opens, before its unit commits",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (const bound of [undefined, "1"]) {
      await withTeam(async (team) => {
        const { a } = team;
        const before = applied(team, a);
        await stampProducers(team);
        const exitCode = Deno.exitCode;
        const held = holdRuns(a);
        try {
          const run = methodRun(team, a, A_TOKEN, CONSUMER, "stamp", {
            env: bound === undefined
              ? {}
              : { [SCOPED_BACKLOG_MAX_ENV_VAR]: bound },
          });
          try {
            await waitFor(() => holding.has(a.repoDir), "a's write to hold", {
              timeoutMs: 120_000,
            });
            const during = applied(team, a);
            for (const name of PRODUCERS) {
              if (bound === undefined) {
                assertEquals(during.seqOf(name), before.seqOf(name), name);
              } else {
                assert(during.seqOf(name) > before.seqOf(name), name);
              }
            }
          } finally {
            held.release();
            assertEquals(await run.result, { exitCode: 0 });
          }
        } finally {
          held.release();
          Deno.exitCode = exitCode;
        }
      });
    }
  },
});

Deno.test({
  name:
    "scoped apply: a long method run applies the whole feed at its interval, and ends cleanly with the interval apply stopped",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const { a } = team;
      const before = applied(team, a);
      const exitCode = Deno.exitCode;
      const held = holdRuns(a);
      try {
        const run = methodRun(team, a, A_TOKEN, CONSUMER, "stamp", {
          feedApplyMs: 200,
        });
        try {
          await waitFor(() => holding.has(a.repoDir), "a's write to hold", {
            timeoutMs: 120_000,
          });
          await stampProducers(team);
          await waitFor(
            () =>
              PRODUCERS.every((name) =>
                applied(team, a).seqOf(name) > before.seqOf(name)
              ),
            "a's interval apply to bring b's writes",
            { timeoutMs: 120_000, intervalMs: 100 },
          );
          assertEquals(run.done(), false, "a's write still runs");
        } finally {
          held.release();
          assertEquals(await run.result, { exitCode: 0 });
        }
      } finally {
        held.release();
        Deno.exitCode = exitCode;
      }
      // the run's own commit, sent while its unit was open, is in its files
      assert(applied(team, a).seqOf(CONSUMER) >= before.seqOf(CONSUMER));
    });
  },
});

Deno.test({
  name:
    "scoped apply: a sync read of another behavior with unapplied commits trips in a test build; one after the async read's barrier reads it current",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const { a } = team;
      readTarget = team.ids[PRODUCERS[0]];
      try {
        await stampProducers(team);
        const exitCode = Deno.exitCode;
        let tripped: { error?: string; exitCode: number };
        try {
          tripped = await methodRun(team, a, A_TOKEN, CONSUMER, "syncPeek")
            .result;
        } finally {
          Deno.exitCode = exitCode;
        }
        assertStringIncludes(
          tripped.error ?? "",
          "A sync read in a scoped command found partition",
        );
        assertEquals(seen, []);

        await runOk(team, a, A_TOKEN, CONSUMER, "barrierPeek");
        assertEquals(seen, [{ via: "barrierPeek", value: 1 }]);
      } finally {
        readTarget = undefined;
      }
    });
  },
});

async function runWorkflow(
  team: Team,
  client: Client,
  workflowName: string,
): Promise<{ statuses: readonly string[]; errors: readonly string[] }> {
  let done: Extract<WorkflowRunWorkerMessage, { kind: "done" }> | undefined;
  let failed: string | undefined;
  const member = startProcessHost(A_TOKEN, workflowRunHost, (message) => {
    if (message.kind === "done") done = message;
    else if (message.kind === "failed") failed = message.error;
  });
  try {
    member.postMessage(
      {
        kind: "run",
        configDir: team.scratch.configDir,
        repoDir: client.repoDir,
        env: serveEnv(team.serve, A_TOKEN),
        modelType: team.serve.modelType.normalized,
        workflowName,
        principal: "user:caller",
        count: 1,
      } satisfies WorkflowRunWorkerRequest,
    );
    await waitFor(
      () => done !== undefined || failed !== undefined,
      "a's workflow run",
      { timeoutMs: 240_000, intervalMs: 50 },
    );
  } finally {
    member.terminate();
  }
  if (done === undefined) throw new Error(`member failed: ${failed}`);
  return { statuses: done.statuses, errors: done.errors };
}
