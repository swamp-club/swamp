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
import "../src/domain/models/models.ts";
import { AsyncResource } from "node:async_hooks";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { Command } from "@cliffy/command";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import {
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
} from "../src/cli/commands/model_method_run.ts";
import { workflowRunCommand } from "../src/cli/commands/workflow_run.ts";
import { workflowResumeCommand } from "../src/cli/commands/workflow_resume.ts";
import { setRunCheckpointIntervalForTesting } from "../src/infrastructure/persistence/workflow_run_checkpointer.ts";
import { dataGetCommand } from "../src/cli/commands/data_get.ts";
import { dataListCommand } from "../src/cli/commands/data_list.ts";
import {
  COMMIT_BATCH_FEATURE,
  SERVE_DATASTORE_FEATURES_HEADER,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import {
  type ReadableSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  type Client,
  dataOf,
  endCommand,
  json,
  latestOf,
  MEMBER,
  readCommand,
  type Scratch,
  type Serve,
  serveEnv,
  startProxy,
  withClientEnv,
  withScratch,
  writeCommand,
  writeInOpenCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const REQUEST_SPAN = "swamp.datastore.v3.serve.request";
const WRITER = "writer";
const CHUNKED_WRITER = "chunked-writer";
const WORKFLOW = "two-steps";
const SLOW_WRITER = "slow-writer";
const SLOW_CHUNKED_WRITER = "slow-chunked-writer";
/** two steps that outlast the checkpoint interval, the second chunked */
const SLOW_WORKFLOW = "two-slow-steps";
/** two steps in one level, each on its own behavior */
const PARALLEL_WORKFLOW = "two-parallel-steps";

const PARTITION_READ = "GET partitions/{partition}/commits";
const CHANGES = "GET changes";
const RELEASE = "DELETE locks/{leaseId}";
/** the lock, answered with the catch-up the copy lacks */
const LOCK = "POST locks";
const HAS = "POST chunks/has";
/** one commit alone, answered with the commit as serve stamped it */
const COMMIT = "POST partitions/{partition}/commits";
/** a flush's commits together, confirmed once, ending the command's lease */
const BATCH = "POST commits";
/** a step's start and its lock, sent together in either order */
const START_AND_LOCK = "start and lock";

/** each adjacent start commit and lock request as one, whichever went first */
function startsWithLocks(requests: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < requests.length; i++) {
    const pair = [requests[i], requests[i + 1]].sort().join();
    if (pair === [COMMIT, LOCK].sort().join()) {
      out.push(START_AND_LOCK);
      i++;
    } else {
      out.push(requests[i]);
    }
  }
  return out;
}

/** Over the 8 KiB inline limit, so the version is stored as a chunk. */
const CHUNKED_BYTES = 16 * 1024;

/** what a slow write waits on before it writes; unset, it does not wait */
let slowWrite: (() => Promise<void>) | undefined;
/** called as every write begins, slow or not, with the bytes it writes */
let onWrite: ((bytes: number) => void) | undefined;

/**
 * serve's thread knows the behavior type with only a read method; the member's
 * thread swaps in one whose method writes a single data version
 */
function registerWriter(type: ModelType): void {
  modelRegistry.invalidateType(type);
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    globalArguments: z.object({
      bytes: z.number().int().default(16),
      slow: z.boolean().default(false),
    }),
    resources: {
      out: {
        description: "One data version per run",
        schema: z.object({ body: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      peek: {
        description: "Reads nothing and writes no data",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      write: {
        description: "Writes one data version",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const { bytes, slow } = context.globalArgs as {
            bytes: number;
            slow: boolean;
          };
          onWrite?.(bytes);
          if (slow) await slowWrite?.();
          const handle = await context.writeResource!("out", "out", {
            body: "x".repeat(bytes),
          });
          return { dataHandles: [handle] };
        },
      },
      append: {
        description: "Writes the latest version's body with a mark added",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const latest = await context.readResource!("out") as
            | { body?: string }
            | null;
          const handle = await context.writeResource!("out", "out", {
            body: `${latest?.body ?? ""}+`,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
}

function makeRoot() {
  return registerCompletionTypes(new Command())
    .globalOption("--json", "JSON output");
}

type Root = ReturnType<typeof makeRoot>;

async function runCommand(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  commandPath: readonly string[],
  attach: (root: Root) => void,
  args: readonly string[],
): Promise<void> {
  await withClientEnv(scratch, env, commandPath, async () => {
    const root = makeRoot();
    attach(root);
    // as mod.ts does for a v3 checkout: it runs locally, serve its upstream
    setImplicitServeRouting(false);
    try {
      await root.parse([
        "cmd",
        ...args,
        "--json",
        "--repo-dir",
        client.repoDir,
      ]);
    } finally {
      resetImplicitServeRouting();
      await endCommand();
    }
  });
}

async function copyChunkFiles(repoDir: string): Promise<number> {
  const copies = join(repoDir, ".swamp", "_datastore_v3_copies");
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) await walk(join(dir, entry.name));
      else if (/^[0-9a-f]{64}$/.test(entry.name)) count++;
    }
  };
  for await (const copy of Deno.readDir(copies)) {
    const blobs = join(copies, copy.name, "_blobs");
    try {
      await walk(blobs);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return count;
}

function parentIdOf(span: ReadableSpan): string {
  return span.parentSpanId ?? "";
}

/** Member-to-serve requests, `METHOD route`, in the order they were sent. */
function requestsOf(spans: readonly ReadableSpan[]): string[] {
  return spans
    .filter((span) => span.name === REQUEST_SPAN)
    .sort((a, b) =>
      a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]
    )
    .map((span) =>
      `${span.attributes["http.request.method"]} ${
        span.attributes["http.route"]
      }`
    );
}

/**
 * serve as an older release answers: no batches, no commit stamped into its
 * reply, no catch-up with a lock, no anchor checked with the feed
 */
function legacyServe(origin: string) {
  return startProxy(origin, async (_request, forward) => {
    const response = await forward();
    const headers = new Headers(response.headers);
    const features = headers.get(SERVE_DATASTORE_FEATURES_HEADER);
    if (features !== null) {
      headers.set(
        SERVE_DATASTORE_FEATURES_HEADER,
        features.split(",").filter((f) => f !== COMMIT_BATCH_FEATURE).join(
          ",",
        ),
      );
    }
    if (!(headers.get("content-type") ?? "").includes("application/json")) {
      return new Response(response.body, { status: response.status, headers });
    }
    const body = await response.json();
    if (typeof body === "object" && body !== null) {
      for (const field of ["catchUp", "commit", "parentTxnId", "anchor"]) {
        delete (body as Record<string, unknown>)[field];
      }
    }
    headers.delete("content-length");
    return Response.json(body, { status: response.status, headers });
  });
}

interface Member {
  readonly scratch: Scratch;
  readonly serve: Serve;
  readonly client: Client;
  readonly env: Record<string, string | undefined>;
}

async function withMember(fn: (member: Member) => Promise<void>) {
  await withScratch(async (scratch) => {
    // definitions and workflows are shared through serve, as in team mode
    const serve = await scratch.serve({
      managedConfig: true,
      commitFeed: true,
      grants: [
        ...MEMBER,
        { actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
      ],
    });
    registerWriter(serve.modelType);
    const client = await scratch.client("member", {
      bucket: scratch.bucket(),
      managedConfig: true,
    });
    const env = serveEnv(serve, "alice-token");
    const step = (name: string, after?: string, model = WRITER) =>
      Step.create({
        name,
        task: StepTask.modelMethod(model, "write"),
        ...(after === undefined ? {} : {
          dependsOn: [{ step: after, condition: TriggerCondition.succeeded() }],
        }),
      });
    await writeCommand(scratch, client, env, async (repos) => {
      await repos.definitionRepo.save(
        serve.modelType,
        Definition.create({ name: WRITER, globalArguments: {} }),
      );
      await repos.definitionRepo.save(
        serve.modelType,
        Definition.create({
          name: CHUNKED_WRITER,
          globalArguments: { bytes: CHUNKED_BYTES },
        }),
      );
      await repos.definitionRepo.save(
        serve.modelType,
        Definition.create({
          name: SLOW_WRITER,
          globalArguments: { slow: true },
        }),
      );
      await repos.definitionRepo.save(
        serve.modelType,
        Definition.create({
          name: SLOW_CHUNKED_WRITER,
          globalArguments: { bytes: CHUNKED_BYTES, slow: true },
        }),
      );
      await repos.workflowRepo.save(Workflow.create({
        name: WORKFLOW,
        jobs: [Job.create({
          name: "main",
          steps: [step("one"), step("two", "one")],
        })],
      }));
      await repos.workflowRepo.save(Workflow.create({
        name: SLOW_WORKFLOW,
        jobs: [Job.create({
          name: "main",
          steps: [
            step("one", undefined, SLOW_WRITER),
            step("two", "one", SLOW_CHUNKED_WRITER),
          ],
        })],
      }));
      await repos.workflowRepo.save(Workflow.create({
        name: PARALLEL_WORKFLOW,
        jobs: [Job.create({
          name: "main",
          steps: [
            step("one", undefined, WRITER),
            step("two", undefined, CHUNKED_WRITER),
          ],
        })],
      }));
    });
    await fn({ scratch, serve, client, env });
  });
}

function methodRun(
  member: Member,
  model: string,
  method = "write",
): Promise<void> {
  return runCommand(
    member.scratch,
    member.client,
    member.env,
    ["model", "method", "run"],
    (root) => {
      root.command("cmd", createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX));
    },
    [model, method],
  );
}

/**
 * the requests of the second run of `command`: the first seeds the copy, so
 * the second is a member's steady state
 */
async function steadyState(
  member: Member,
  command: () => Promise<void>,
): Promise<string[]> {
  await methodRun(member, WRITER);
  await methodRun(member, CHUNKED_WRITER);
  await command();
  let requests: string[] = [];
  await withCapturedSpans(async (spans) => {
    await command();
    requests = requestsOf(spans);
  });
  return requests;
}

Deno.test({
  name: "team-mode method run: an inline write's requests to serve are pinned",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      assertEquals(
        await steadyState(member, () => methodRun(member, WRITER)),
        [
          LOCK, // answered with the catch-up the writer hold left to it
          BATCH, // the write, ending the lease
        ],
      );
    });
  },
});

Deno.test({
  name: "team-mode method run: a chunked write's requests to serve are pinned",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      assertEquals(
        await steadyState(member, () => methodRun(member, CHUNKED_WRITER)),
        [
          LOCK,
          HAS,
          BATCH,
        ],
      );
    });
  },
});

Deno.test({
  name:
    "team-mode method run: a read run takes the behavior's lock, so its requests to serve are pinned (swamp-club#4578)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      // as many requests as a lockless read's catch-up and commit
      assertEquals(
        await steadyState(member, () => methodRun(member, WRITER, "peek")),
        [
          LOCK, // answered with the catch-up the run would have asked for
          BATCH, // its method summary, ending the lease
        ],
      );
    });
  },
});

Deno.test({
  name: "team-mode workflow run: a two-step run's requests to serve are pinned",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A paced checkpoint firing mid-run on a slow host races a step's lock.
    setRunCheckpointIntervalForTesting(60 * 60 * 1000);
    try {
      await withMember(async (member) => {
        const run = () =>
          runCommand(
            member.scratch,
            member.client,
            member.env,
            ["workflow", "run"],
            (root) => {
              root.command("cmd", workflowRunCommand);
            },
            [WORKFLOW],
          );
        const step = [
          START_AND_LOCK, // the method waits for both
          BATCH, // its data and the run record, ending the lease
        ];
        assertEquals(startsWithLocks(await steadyState(member, run)), [
          CHANGES,
          BATCH, // the run record, the evaluated workflow and the snapshot
          ...step,
          ...step,
          LOCK, // the workflow's own lock, for its summary report's version
          HAS, // the report and the run record, over the inline limit by its end
          BATCH, // the summary report and the final record, ending that lease
        ]);
      });
    } finally {
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "team-mode workflow run: --skip-reports sends no lock for the workflow when no workflow-scope report is left to run (swamp-club#4578)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A paced checkpoint firing mid-run on a slow host races a step's lock.
    setRunCheckpointIntervalForTesting(60 * 60 * 1000);
    try {
      await withMember(async (member) => {
        const run = () =>
          runCommand(
            member.scratch,
            member.client,
            member.env,
            ["workflow", "run"],
            (root) => {
              root.command("cmd", workflowRunCommand);
            },
            [WORKFLOW, "--skip-reports"],
          );
        const step = [
          START_AND_LOCK, // the method waits for both
          BATCH, // its data and the run record, ending the lease
        ];
        assertEquals(startsWithLocks(await steadyState(member, run)), [
          CHANGES,
          BATCH, // the run record, the evaluated workflow and the snapshot
          ...step,
          ...step,
          HAS, // the run record, over the inline limit by its end
          COMMIT, // the final record on its own, with no report to ride
        ]);
      });
    } finally {
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "team-mode workflow resume: a retry of a failed run takes the workflow's lock for its summary report (swamp-club#4578)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    setRunCheckpointIntervalForTesting(60 * 60 * 1000);
    try {
      await withMember(async (member) => {
        const workflow = Workflow.create({
          name: "fails-its-check",
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "check",
              task: StepTask.assert("false", "never holds"),
            })],
          })],
        });
        await writeCommand(
          member.scratch,
          member.client,
          member.env,
          (repos) => repos.workflowRepo.save(workflow),
        );
        // the run and each retry fail their check, which is all this needs
        const failing = async (command: () => Promise<void>) => {
          const exitCode = Deno.exitCode;
          try {
            await command();
          } catch {
            // the failed check
          } finally {
            Deno.exitCode = exitCode;
          }
        };
        await failing(() =>
          runCommand(
            member.scratch,
            member.client,
            member.env,
            ["workflow", "run"],
            (root) => {
              root.command("cmd", workflowRunCommand);
            },
            [workflow.name],
          )
        );
        const failed = await readCommand(
          member.scratch,
          member.client,
          member.env,
          (repos) => repos.workflowRunRepo.findLatestByWorkflowId(workflow.id),
        );
        const resume = () =>
          failing(() =>
            runCommand(
              member.scratch,
              member.client,
              member.env,
              ["workflow", "resume"],
              (root) => {
                root.command("cmd", workflowResumeCommand);
              },
              [workflow.name, "--run", failed!.id],
            )
          );
        await resume();
        let requests: string[] = [];
        await withCapturedSpans(async (spans) => {
          await resume();
          requests = requestsOf(spans);
        });
        assertEquals(requests, [
          CHANGES,
          LOCK, // the run's claim
          COMMIT, // the run taken over
          RELEASE, // the claim
          COMMIT, // the retried step's outcome
          LOCK, // the workflow's own lock, for its summary report's version
          BATCH, // the summary report and the final record, ending that lease
        ]);
      });
    } finally {
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});

/** commits sent alone or together, a paced checkpoint's included */
function commitsIn(spans: readonly ReadableSpan[]): number {
  return requestsOf(spans).filter((r) => r === COMMIT || r === BATCH).length;
}

Deno.test({
  name:
    "team-mode workflow run: steps that outlast the checkpoint interval, one with a chunked output, have their requests to serve pinned",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    setRunCheckpointIntervalForTesting(500);
    try {
      await withMember(async (member) => {
        const run = () =>
          runCommand(
            member.scratch,
            member.client,
            member.env,
            ["workflow", "run"],
            (root) => {
              root.command("cmd", workflowRunCommand);
            },
            [SLOW_WORKFLOW],
          );
        let requests: string[] = [];
        await withCapturedSpans(async (spans) => {
          // a step that outlasts the interval sees a paced checkpoint land
          slowWrite = async () => {
            const before = commitsIn(spans);
            await waitFor(
              () => commitsIn(spans) > before,
              "a paced checkpoint during the step",
            );
          };
          await methodRun(member, WRITER);
          await methodRun(member, CHUNKED_WRITER);
          await run();
          const seen = spans.length;
          await run();
          requests = requestsOf(spans.slice(seen));
        });
        assertEquals(startsWithLocks(requests), [
          CHANGES,
          BATCH, // the run record, the evaluated workflow and the snapshot
          START_AND_LOCK, // step one's start and lock, together
          BATCH, // a paced checkpoint mid-step
          BATCH, // step one's data and the run record, ending the lease
          START_AND_LOCK,
          BATCH, // a paced checkpoint mid-step
          HAS,
          BATCH, // step two's chunked data and the run record
          LOCK, // the workflow's own lock, for its summary report's version
          HAS, // the report and the run record, over the inline limit by its end
          BATCH, // the summary report and the final record, ending that lease
        ]);
      });
    } finally {
      slowWrite = undefined;
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "team-mode: against a serve without batches, stamped replies, lock catch-ups or anchor checks, a write falls back to a request per step",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      const proxy = legacyServe(member.serve.origin);
      try {
        const legacy = { ...member, env: serveEnv(proxy, "alice-token") };
        assertEquals(
          await steadyState(legacy, () => methodRun(legacy, WRITER)),
          [
            LOCK, // the writer hold left its catch-up to the lock
            CHANGES, // which came with none, so it is read now
            PARTITION_READ, // with no verdict, the anchor on its own
            COMMIT,
            PARTITION_READ, // the commit came back unstamped
            RELEASE, // and the lease is released on its own
          ],
        );
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "team-mode method run: a write's requests to serve do not grow with history another member wrote (swamp-club#4457)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      const before = await steadyState(member, () => methodRun(member, WRITER));
      const other: Member = {
        ...member,
        client: await member.scratch.client("other", {
          bucket: member.scratch.bucket(),
          managedConfig: true,
        }),
      };
      for (let i = 0; i < 50; i++) await methodRun(other, WRITER);
      let after: string[] = [];
      await withCapturedSpans(async (spans) => {
        await methodRun(member, WRITER);
        after = requestsOf(spans);
      });
      assertEquals(after, before);
    });
  },
});

Deno.test({
  name: "team-mode reads: data get and data list requests to serve are pinned",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      const get = () =>
        runCommand(
          member.scratch,
          member.client,
          member.env,
          ["data", "get"],
          (root) => {
            root.command("cmd", dataGetCommand);
          },
          [WRITER, "out"],
        );
      const list = () =>
        runCommand(
          member.scratch,
          member.client,
          member.env,
          ["data", "list"],
          (root) => {
            root.command("cmd", dataListCommand);
          },
          [WRITER],
        );
      assertEquals(
        {
          get: await steadyState(member, get),
          list: await steadyState(member, list),
        },
        { get: [CHANGES], list: [CHANGES] },
      );
    });
  },
});

Deno.test({
  name:
    "team-mode method run: another member's commit landing after the writer hold's catch-up is what the method reads",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      await methodRun(member, WRITER);
      const other = await member.scratch.client("other", {
        bucket: member.scratch.bucket(),
        managedConfig: true,
      });
      const latest = () =>
        readCommand(
          member.scratch,
          member.client,
          member.env,
          async (repos) => {
            const writer = await repos.definitionRepo.findByName(
              member.serve.modelType,
              WRITER,
            );
            assert(writer !== null);
            return await latestOf(
              repos,
              member.serve.modelType,
              writer.id,
              "out",
            );
          },
        );
      const before = await latest();
      assert(before !== null);
      // The other member's write lands as this member asks for its lock: after
      // the writer hold's catch-up and the repository open, before the lock's.
      const outside = AsyncResource.bind(
        <T>(fn: () => Promise<T>): Promise<T> => fn(),
      ) as <T>(fn: () => Promise<T>) => Promise<T>;
      let landed = false;
      const proxy = startProxy(member.serve.origin, async (request) => {
        if (
          !landed && request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/locks")
        ) {
          landed = true;
          await outside(() =>
            writeInOpenCommand(
              member.scratch,
              other,
              member.env,
              async (repos) => {
                const writer = await repos.definitionRepo.findByName(
                  member.serve.modelType,
                  WRITER,
                );
                assert(writer !== null);
                const data = dataOf("out");
                await repos.unifiedDataRepo.save(
                  member.serve.modelType,
                  writer.id,
                  Data.fromData({
                    ...data.toData(),
                    ownerDefinition: {
                      ownerType: "model-method",
                      ownerRef: writer.id,
                    },
                  }),
                  json({ body: "from-other" }),
                );
              },
            )
          );
        }
        return undefined;
      });
      try {
        await methodRun(
          { ...member, env: serveEnv(proxy, "alice-token") },
          WRITER,
          "append",
        );
      } finally {
        await proxy.close();
      }
      assert(landed);
      const after = await latest();
      assertEquals(after?.version, before.version + 2);
      // built on the other member's version, not the one this checkout held
      assertEquals(JSON.parse(after?.content ?? "{}").body, "from-other+");
    });
  },
});

Deno.test({
  name:
    "team-mode reads: a catch-up fetches another member's new chunks together, not one at a time",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMember(async (member) => {
      await methodRun(member, WRITER);
      const other = await member.scratch.client("other", {
        bucket: member.scratch.bucket(),
        managedConfig: true,
      });
      await writeCommand(member.scratch, other, member.env, async (repos) => {
        const writer = await repos.definitionRepo.findByName(
          member.serve.modelType,
          WRITER,
        );
        assert(writer !== null);
        for (let i = 0; i < 4; i++) {
          const data = dataOf(`big-${i}`);
          await repos.unifiedDataRepo.save(
            member.serve.modelType,
            writer.id,
            Data.fromData({
              ...data.toData(),
              ownerDefinition: {
                ownerType: "model-method",
                ownerRef: writer.id,
              },
            }),
            json({ body: `${i}`.repeat(CHUNKED_BYTES) }),
          );
        }
      });
      let fetches: ReadableSpan[] = [];
      const parentNames = new Map<string, string>();
      await withCapturedSpans(async (spans) => {
        await runCommand(
          member.scratch,
          member.client,
          member.env,
          ["data", "list"],
          (root) => {
            root.command("cmd", dataListCommand);
          },
          [WRITER],
        );
        fetches = spans.filter((span) =>
          span.name === REQUEST_SPAN &&
          span.attributes["http.route"] === "chunks/{sha256}"
        );
        for (const span of spans) {
          parentNames.set(span.spanContext().spanId, span.name);
        }
      });
      assertEquals(fetches.length, 4);
      // all fetched ahead, together, before the page applied any of them
      assertEquals(
        fetches.map((span) => parentNames.get(parentIdOf(span))),
        Array(4).fill("swamp.datastore.v3.readmodel.prefetch"),
      );
      assertEquals(await copyChunkFiles(member.client.repoDir), 0);
      const paths = await readCommand(
        member.scratch,
        member.client,
        member.env,
        async (repos) => {
          const writer = await repos.definitionRepo.findByName(
            member.serve.modelType,
            WRITER,
          );
          assert(writer !== null);
          const found: [string, string][] = [];
          for (let i = 0; i < 4; i++) {
            const data = await repos.unifiedDataRepo.findByName(
              member.serve.modelType,
              writer.id,
              `big-${i}`,
            );
            assert(data !== null);
            found.push([
              `${i}`,
              repos.unifiedDataRepo.getContentPath(
                member.serve.modelType,
                writer.id,
                `big-${i}`,
                data.version,
              ),
            ]);
          }
          return found;
        },
      );
      for (const [i, path] of paths) {
        assertEquals(
          JSON.parse(await Deno.readTextFile(path)),
          { body: i.repeat(CHUNKED_BYTES) },
        );
      }
    });
  },
});

Deno.test({
  name:
    "team-mode workflow run: a parallel step's method runs only once its start is durable at serve (swamp-club#4319)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // No paced checkpoints, so every commit sent alone mid-run is a start.
    setRunCheckpointIntervalForTesting(60 * 60 * 1000);
    let landedStarts = 0;
    const early: string[] = [];
    try {
      await withMember(async (member) => {
        const proxy = startProxy(
          member.serve.origin,
          async (request, forward) => {
            const url = new URL(request.url);
            if (
              request.method !== "POST" ||
              !/\/partitions\/[^/]+\/commits$/.test(url.pathname)
            ) {
              return undefined;
            }
            // held long enough that a method not waiting for it runs first
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const response = await forward();
            if (response.ok) landedStarts++;
            return response;
          },
        );
        try {
          const proxied = { ...member, env: serveEnv(proxy, "alice-token") };
          // starts commit in step order, so step N's needs N landed
          onWrite = (bytes) => {
            const step = bytes === CHUNKED_BYTES ? 2 : 1;
            if (landedStarts < step) {
              early.push(`step ${step} ran with ${landedStarts} starts landed`);
            }
          };
          await runCommand(
            proxied.scratch,
            proxied.client,
            proxied.env,
            ["workflow", "run"],
            (root) => {
              root.command("cmd", workflowRunCommand);
            },
            [PARALLEL_WORKFLOW],
          );
        } finally {
          onWrite = undefined;
          await proxy.close();
        }
      });
      assertEquals(early, []);
    } finally {
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "team-mode workflow run: a step sends its lock request while its start is in flight, with no catch-up of its own",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // No paced checkpoints, so every commit sent alone mid-run is a start.
    setRunCheckpointIntervalForTesting(60 * 60 * 1000);
    const seen: string[] = [];
    let startsDone = 0;
    // start N is let go once N lock requests have arrived, before it or after
    let locks = 0;
    let starts = 0;
    const lockWaits: { readonly at: number; readonly arrived: () => void }[] =
      [];
    try {
      await withMember(async (member) => {
        await methodRun(member, WRITER);
        const proxy = startProxy(
          member.serve.origin,
          async (request, forward) => {
            const url = new URL(request.url);
            const start = request.method === "POST" &&
              /\/partitions\/[^/]+\/commits$/.test(url.pathname);
            if (request.method === "POST" && url.pathname.endsWith("/locks")) {
              seen.push(`lock after ${startsDone} starts landed`);
              locks++;
              for (const wait of lockWaits.filter((w) => w.at <= locks)) {
                wait.arrived();
              }
            } else if (
              request.method === "GET" && url.pathname.endsWith("/changes")
            ) {
              seen.push("changes");
            }
            if (!start) return undefined;
            // held until the step's lock arrives; a step that sends its lock
            // only after its start lands is let go by the bound instead
            const lockArrived = Promise.withResolvers<void>();
            const at = ++starts;
            if (locks >= at) lockArrived.resolve();
            else lockWaits.push({ at, arrived: lockArrived.resolve });
            let bound: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              lockArrived.promise,
              new Promise((resolve) => {
                bound = setTimeout(resolve, 10_000);
              }),
            ]);
            clearTimeout(bound);
            const response = await forward();
            if (response.ok) startsDone++;
            return response;
          },
        );
        try {
          const proxied = { ...member, env: serveEnv(proxy, "alice-token") };
          await runCommand(
            proxied.scratch,
            proxied.client,
            proxied.env,
            ["workflow", "run"],
            (root) => {
              root.command("cmd", workflowRunCommand);
            },
            [WORKFLOW],
          );
        } finally {
          await proxy.close();
        }
      });
      assertEquals(seen, [
        "changes", // before the workflow, its only catch-up
        // each step's lock goes out before its own start lands
        "lock after 0 starts landed",
        "lock after 1 starts landed",
        "lock after 2 starts landed", // the workflow's report lock
      ]);
    } finally {
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "team-mode workflow run: a step whose start serve cannot take never runs, and releases the lock it took alongside",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // No paced checkpoints, so every commit sent alone mid-run is a start.
    setRunCheckpointIntervalForTesting(60 * 60 * 1000);
    const seen: string[] = [];
    let wrote = 0;
    try {
      await withMember(async (member) => {
        await methodRun(member, WRITER);
        const proxy = startProxy(member.serve.origin, (request) => {
          const url = new URL(request.url);
          const route = `${request.method} ${
            url.pathname.replace(/^.*\/datastore\/[^/]+/, "")
          }`;
          seen.push(route);
          if (
            request.method === "POST" &&
            /\/partitions\/[^/]+\/commits$/.test(url.pathname)
          ) {
            return Promise.resolve(
              Response.json({ code: "unavailable", message: "down" }, {
                status: 503,
              }),
            );
          }
          return Promise.resolve(undefined);
        });
        try {
          const proxied = { ...member, env: serveEnv(proxy, "alice-token") };
          onWrite = () => {
            wrote++;
          };
          const error = await assertRejects(
            () =>
              runCommand(
                proxied.scratch,
                proxied.client,
                proxied.env,
                ["workflow", "run"],
                (root) => {
                  root.command("cmd", workflowRunCommand);
                },
                [WORKFLOW],
              ),
            Error,
          );
          assertStringIncludes(
            error.message,
            "could not commit the start of step one",
          );
        } finally {
          onWrite = undefined;
          await proxy.close();
        }
      });
      assertEquals(wrote, 0);
      // the lock taken alongside the refused start is given back, not left to
      // lapse
      const lock = seen.findIndex((r) => r.endsWith("/locks"));
      assert(lock >= 0, `no lock request in ${seen.join(", ")}`);
      assert(
        seen.slice(lock + 1).some((r) =>
          r.startsWith("DELETE ") || r === "POST /commits"
        ),
        `the lock was not released: ${seen.join(", ")}`,
      );
    } finally {
      setRunCheckpointIntervalForTesting(undefined);
    }
  },
});
