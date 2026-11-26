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
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type Client,
  latestOf,
  readCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server.ts";
import {
  methodRunHost,
  type MethodRunWorkerMessage,
  type MethodRunWorkerRequest,
} from "./serve_upstream_method_run.ts";
import {
  workflowRunHost,
  type WorkflowRunWorkerMessage,
  type WorkflowRunWorkerRequest,
} from "./serve_upstream_workflow_run.ts";
import { startProcessHost } from "./process_host.ts";

await initializeLogging({});

/**
 * How long a second process on a member's checkout may read a stale copy of
 * another behavior while the member runs a long write. Undefined waits for
 * the write to end; set it to the scoped feed-watch apply interval plus slack.
 */
const READER_LAG_BOUND_MS: number | undefined = undefined;

// alice-token authenticates as user:caller, bob-token as user:bob
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
const PRODUCER = "producer";
const PRODUCERS = ["producer1", "producer2", "producer3"] as const;

interface Observation {
  readonly repoDir: string;
  readonly via: string;
  readonly value: unknown;
}

/** what each method body saw, in the order it saw it */
let observed: Observation[] = [];
/** the body each behavior's next `stamp` writes */
const nextBody = new Map<string, string>();
/** a run in this checkout waits here once its write is allocated */
const holds = new Map<string, Promise<void>>();
const holding = new Set<string>();

function observe(repoDir: string, via: string, value: unknown): void {
  observed.push({ repoDir, via, value });
}

function lastSeen(client: Client, via: string): unknown {
  const matching = observed.filter((o) =>
    o.repoDir === client.repoDir && o.via === via
  );
  return matching.at(-1)?.value;
}

function bodiesOf(records: readonly unknown[]): Record<string, unknown> {
  const bodies: Record<string, unknown> = {};
  for (const record of records) {
    const r = record as {
      modelName?: string;
      name?: string;
      attributes?: { body?: unknown };
    };
    if (r.name !== "out" || r.modelName === undefined) continue;
    if (!r.modelName.startsWith(PRODUCER)) continue;
    bodies[r.modelName] = r.attributes?.body;
  }
  return bodies;
}

const ReadArgs = z.object({
  seen: z.string().optional(),
  latest: z.string().optional(),
  tag: z.string().optional(),
  own: z.string().optional(),
  found: z.array(z.unknown()).optional(),
});

/** one type for every behavior here; each method writes so it runs as a write */
function registerMethods(type: ModelType): void {
  modelRegistry.invalidateType(type);
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
        description: "Writes the body the test chose for this behavior",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!("out", "out", {
            body: nextBody.get(context.definition.name) ?? "unset",
          });
          await hold(context.repoDir);
          return { dataHandles: [handle] };
        },
      },
      readArg: {
        description: "Records the arguments its definition's CEL resolved",
        kind: "update",
        arguments: ReadArgs,
        execute: async (args, context) => {
          for (const [key, value] of Object.entries(ReadArgs.parse(args))) {
            observe(
              context.repoDir,
              key,
              key === "found" ? bodiesOf(value as unknown[]) : value,
            );
          }
          const definition = await context.definitionRepository.findByName(
            context.modelType,
            PRODUCER,
          );
          observe(
            context.repoDir,
            "definitionRepository",
            definition?.globalArguments.tag,
          );
          const handle = await context.writeResource!("out", "out", {
            body: "read",
          });
          await hold(context.repoDir);
          return { dataHandles: [handle] };
        },
      },
      readRepo: {
        description: "Reads the producer's latest through the repositories",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const producer = await context.definitionRepository.findByName(
            context.modelType,
            PRODUCER,
          );
          if (producer === null) throw new Error("no producer definition");
          const latest = await context.dataRepository.findByName(
            context.modelType,
            producer.id,
            "out",
          );
          const content = latest === null
            ? null
            : await context.dataRepository.getContent(
              context.modelType,
              producer.id,
              "out",
              latest.version,
            );
          observe(
            context.repoDir,
            "getContent",
            content === null
              ? null
              : JSON.parse(new TextDecoder().decode(content)).body,
          );
          const records = await context.readModelData!(PRODUCER, "out");
          const newest = records.filter((r) => r.name === "out")
            .sort((a, b) => b.version - a.version)[0];
          observe(context.repoDir, "readModelData", newest?.attributes.body);
          const handle = await context.writeResource!("out", "out", {
            body: "read",
          });
          return { dataHandles: [handle] };
        },
      },
      queryAll: {
        description: "Reads every producer's latest through data.query",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const records = await context.queryData!('name == "out"');
          observe(context.repoDir, "queryData", bodiesOf(records));
          const handle = await context.writeResource!("out", "out", {
            body: "read",
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
}

async function hold(repoDir: string): Promise<void> {
  const held = holds.get(repoDir);
  if (held === undefined) return;
  holding.add(repoDir);
  await held;
}

/** holds the next runs in this checkout at their allocated write until released */
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

interface Run {
  readonly done: () => boolean;
  readonly result: Promise<{ error?: string; exitCode: number }>;
}

/** a member's `model method run`, in a ProcessRuntime of its own */
function methodRun(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  model: string,
  method: string,
): Run {
  let done: Extract<MethodRunWorkerMessage, { kind: "done" }> | undefined;
  let failed: string | undefined;
  const member = startProcessHost(token, methodRunHost, (message) => {
    if (message.kind === "done") done = message;
    else if (message.kind === "failed") failed = message.error;
  });
  member.postMessage(
    {
      kind: "run",
      configDir: scratch.configDir,
      repoDir: client.repoDir,
      env: serveEnv(serve, token),
      modelType: serve.modelType.normalized,
      model,
      method,
    } satisfies MethodRunWorkerRequest,
  );
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
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  model: string,
  method: string,
): Promise<void> {
  const exitCode = Deno.exitCode;
  try {
    assertEquals(
      await methodRun(scratch, serve, client, token, model, method).result,
      { exitCode: 0 },
      `${model} ${method}`,
    );
  } finally {
    Deno.exitCode = exitCode;
  }
}

async function stamp(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  model: string,
  body: string,
): Promise<void> {
  nextBody.set(model, body);
  await runOk(scratch, serve, client, token, model, "stamp");
}

async function saveDefinitions(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  definitions: readonly Definition[],
): Promise<void> {
  await writeCommand(scratch, client, serveEnv(serve, token), async (repos) => {
    for (const definition of definitions) {
      await repos.definitionRepo.save(serve.modelType, definition);
    }
  });
}

interface Team {
  readonly scratch: Scratch;
  readonly serve: Serve;
  readonly a: Client;
  readonly b: Client;
}

async function withTeam(fn: (team: Team) => Promise<void>): Promise<void> {
  observed = [];
  nextBody.clear();
  holds.clear();
  holding.clear();
  await withScratch(async (scratch) => {
    const serve = await scratch.serve({
      grants: GRANTS,
      managedConfig: true,
      commitFeed: true,
    });
    registerMethods(serve.modelType);
    const a = await scratch.client("a", { managedConfig: true });
    const b = await scratch.client("b", { managedConfig: true });
    await fn({ scratch, serve, a, b });
  });
}

function consumer(
  id: string,
  methods: Record<string, Record<string, unknown>>,
): Definition {
  return Definition.create({
    id,
    name: CONSUMER,
    globalArguments: {},
    methods: Object.fromEntries(
      Object.entries(methods).map(([name, args]) => [name, {
        arguments: args,
      }]),
    ),
  });
}

function producer(name: string, id: string, tag = ""): Definition {
  return Definition.create({ id, name, globalArguments: { tag } });
}

Deno.test({
  name:
    "scoped apply reads: a member's method run resolves CEL over another behavior to the version another member just wrote",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        producer(PRODUCER, crypto.randomUUID()),
        consumer(crypto.randomUUID(), {
          readArg: {
            seen: "${{ model.producer.resource.out.out.attributes.body }}",
            latest: '${{ data.latest("producer", "out").attributes.body }}',
          },
        }),
      ]);
      await stamp(scratch, serve, b, B_TOKEN, PRODUCER, "one");
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      assertEquals(lastSeen(a, "seen"), "one");
      assertEquals(lastSeen(a, "latest"), "one");

      await stamp(scratch, serve, b, B_TOKEN, PRODUCER, "two");
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      assertEquals(lastSeen(a, "seen"), "two");
      assertEquals(lastSeen(a, "latest"), "two");
    });
  },
});

Deno.test({
  name:
    "scoped apply reads: a member's method body reading another behavior through getContent and readModelData sees the version another member just wrote",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        producer(PRODUCER, crypto.randomUUID()),
        consumer(crypto.randomUUID(), {}),
      ]);
      await stamp(scratch, serve, b, B_TOKEN, PRODUCER, "one");
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readRepo");
      assertEquals(lastSeen(a, "getContent"), "one");
      assertEquals(lastSeen(a, "readModelData"), "one");

      await stamp(scratch, serve, b, B_TOKEN, PRODUCER, "two");
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readRepo");
      assertEquals(lastSeen(a, "getContent"), "two");
      assertEquals(lastSeen(a, "readModelData"), "two");
    });
  },
});

Deno.test({
  name:
    "scoped apply reads: a data.query in a member's method run, in CEL or in the method body, sees every behavior another member wrote",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        ...PRODUCERS.map((name) => producer(name, crypto.randomUUID())),
        consumer(crypto.randomUUID(), {
          readArg: { found: "${{ data.query('name == \"out\"') }}" },
        }),
      ]);
      for (const name of PRODUCERS) {
        await stamp(scratch, serve, b, B_TOKEN, name, `${name}-one`);
      }
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "queryAll");
      const first = Object.fromEntries(
        PRODUCERS.map((name) => [name, `${name}-one`]),
      );
      assertEquals(lastSeen(a, "found"), first);
      assertEquals(lastSeen(a, "queryData"), first);

      for (const name of PRODUCERS) {
        await stamp(scratch, serve, b, B_TOKEN, name, `${name}-two`);
      }
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "queryAll");
      const second = Object.fromEntries(
        PRODUCERS.map((name) => [name, `${name}-two`]),
      );
      assertEquals(lastSeen(a, "found"), second);
      assertEquals(lastSeen(a, "queryData"), second);
    });
  },
});

const DEFINITION_READS = {
  readArg: {
    tag: "${{ model.producer.definition.globalArguments.tag }}",
    own: "own-1",
  },
};

Deno.test({
  name:
    "scoped apply reads: definitions another member changed are seen by a member's next method run when it opens",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      const producerId = crypto.randomUUID();
      const consumerId = crypto.randomUUID();
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        producer(PRODUCER, producerId, "t1"),
        consumer(consumerId, DEFINITION_READS),
      ]);
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      assertEquals(lastSeen(a, "tag"), "t1");
      assertEquals(lastSeen(a, "own"), "own-1");
      assertEquals(lastSeen(a, "definitionRepository"), "t1");

      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        producer(PRODUCER, producerId, "t2"),
        consumer(consumerId, {
          readArg: { ...DEFINITION_READS.readArg, own: "own-2" },
        }),
      ]);
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      assertEquals(lastSeen(a, "tag"), "t2");
      assertEquals(lastSeen(a, "own"), "own-2");
      assertEquals(lastSeen(a, "definitionRepository"), "t2");
    });
  },
});

Deno.test({
  name:
    "scoped apply reads: a definition another member changes while a member's method run waits for its lock is seen once the lock is held",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      const c = await scratch.client("c", { managedConfig: true });
      const producerId = crypto.randomUUID();
      const consumerId = crypto.randomUUID();
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        producer(PRODUCER, producerId, "t1"),
        consumer(consumerId, DEFINITION_READS),
      ]);
      await runOk(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
      assertEquals(lastSeen(a, "definitionRepository"), "t1");

      const exitCode = Deno.exitCode;
      const held = holdRuns(b);
      let waiting: Run | undefined;
      try {
        // b holds the consumer's lock until released
        const holder = methodRun(
          scratch,
          serve,
          b,
          B_TOKEN,
          CONSUMER,
          "readArg",
        );
        try {
          await waitFor(() => holding.has(b.repoDir), "b to hold the lock", {
            timeoutMs: 120_000,
          });
          const { busy } = await serve.lockStats();
          waiting = methodRun(scratch, serve, a, A_TOKEN, CONSUMER, "readArg");
          await waitFor(
            async () =>
              waiting!.done() || (await serve.lockStats()).busy > busy,
            "a's run to wait for b's lock",
            { timeoutMs: 120_000, intervalMs: 50 },
          );
          assertEquals(waiting.done(), false, "a's run waited for the lock");
          await saveDefinitions(scratch, serve, c, A_TOKEN, [
            producer(PRODUCER, producerId, "t3"),
          ]);
        } finally {
          held.release();
          assertEquals(await holder.result, { exitCode: 0 });
        }
        assertEquals(await waiting.result, { exitCode: 0 });
      } finally {
        held.release();
        Deno.exitCode = exitCode;
      }
      assertEquals(lastSeen(a, "definitionRepository"), "t3");
      assertEquals(lastSeen(a, "tag"), "t3");
    });
  },
});

Deno.test({
  name:
    "scoped apply reads: a second process reading a member's checkout during the member's long write sees another member's new version within the lag bound",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      const producerId = crypto.randomUUID();
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        producer(PRODUCER, producerId),
        consumer(crypto.randomUUID(), {}),
      ]);
      await stamp(scratch, serve, b, B_TOKEN, PRODUCER, "one");
      const readProducer = () =>
        readCommand(
          scratch,
          a,
          serveEnv(serve, A_TOKEN),
          (repos) => latestOf(repos, serve.modelType, producerId, "out"),
        );
      assertEquals((await readProducer())?.content, '{"body":"one"}');

      const exitCode = Deno.exitCode;
      const held = holdRuns(a);
      try {
        const long = methodRun(scratch, serve, a, A_TOKEN, CONSUMER, "stamp");
        try {
          await waitFor(() => holding.has(a.repoDir), "a's long write", {
            timeoutMs: 120_000,
          });
          await stamp(scratch, serve, b, B_TOKEN, PRODUCER, "two");
          if (READER_LAG_BOUND_MS !== undefined) {
            await waitFor(
              async () => (await readProducer())?.content === '{"body":"two"}',
              "the reader to see b's write while a's write runs",
              { timeoutMs: READER_LAG_BOUND_MS, intervalMs: 200 },
            );
            assertEquals(long.done(), false, "a's write still ran");
          }
        } finally {
          held.release();
          assertEquals(await long.result, { exitCode: 0 });
        }
      } finally {
        held.release();
        Deno.exitCode = exitCode;
      }
      await waitFor(
        async () => (await readProducer())?.content === '{"body":"two"}',
        "the reader to see b's write once a's write ended",
        { timeoutMs: 120_000, intervalMs: 200 },
      );
    });
  },
});

Deno.test({
  name:
    "scoped apply reads: a workflow run in a member sees every behavior and definition another member just wrote",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async ({ scratch, serve, a, b }) => {
      const consumerId = crypto.randomUUID();
      const producerIds = PRODUCERS.map(() => crypto.randomUUID());
      const workflow = Workflow.create({
        name: `reads-${crypto.randomUUID().slice(0, 8)}`,
        jobs: [Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "cel",
              task: StepTask.modelMethod(CONSUMER, "readArg"),
            }),
            Step.create({
              name: "query",
              task: StepTask.modelMethod(CONSUMER, "queryAll"),
              dependsOn: [{
                step: "cel",
                condition: TriggerCondition.succeeded(),
              }],
            }),
          ],
        })],
      });
      const readArgs = (own: string) => ({
        readArg: {
          seen: "${{ model.producer1.resource.out.out.attributes.body }}",
          found: "${{ data.query('name == \"out\"') }}",
          own,
        },
      });
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        ...PRODUCERS.map((name, i) => producer(name, producerIds[i])),
        consumer(consumerId, readArgs("own-1")),
      ]);
      await writeCommand(
        scratch,
        b,
        serveEnv(serve, B_TOKEN),
        (repos) => repos.workflowRepo.save(workflow),
      );
      for (const name of PRODUCERS) {
        await stamp(scratch, serve, b, B_TOKEN, name, `${name}-one`);
      }
      assertEquals(await runWorkflow(scratch, serve, a, workflow.name), {
        statuses: ["succeeded"],
        errors: [],
      });
      assertEquals(lastSeen(a, "seen"), "producer1-one");

      for (const name of PRODUCERS) {
        await stamp(scratch, serve, b, B_TOKEN, name, `${name}-two`);
      }
      await saveDefinitions(scratch, serve, b, B_TOKEN, [
        consumer(consumerId, readArgs("own-2")),
      ]);
      assertEquals(await runWorkflow(scratch, serve, a, workflow.name), {
        statuses: ["succeeded"],
        errors: [],
      });
      const second = Object.fromEntries(
        PRODUCERS.map((name) => [name, `${name}-two`]),
      );
      assertEquals(lastSeen(a, "seen"), "producer1-two");
      assertEquals(lastSeen(a, "own"), "own-2");
      assertEquals(lastSeen(a, "found"), second);
      assertEquals(lastSeen(a, "queryData"), second);
    });
  },
});

async function runWorkflow(
  scratch: Scratch,
  serve: Serve,
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
        configDir: scratch.configDir,
        repoDir: client.repoDir,
        env: serveEnv(serve, A_TOKEN),
        modelType: serve.modelType.normalized,
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
