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
import {
  commandLanded,
  resetCommandLandedForTesting,
} from "../src/infrastructure/datastore_v3/command_landed.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { walk } from "@std/fs";
import { join, SEPARATOR } from "@std/path";
import {
  acquireModelLocks,
  assertOfflineRunAllowed,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
  v3LocationOf,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import {
  OfflineConfigEditError,
  OfflineLeaseRequiredError,
} from "../src/domain/datastore_v3/offline_write_policy.ts";
import { ServeNotLeaderError } from "../src/domain/datastore_v3/serve_leader.ts";
import { setServeReadRefusalBudgetForTesting } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { setLockCatchUpMaxCommitsForTesting } from "../src/infrastructure/datastore_v3/serve_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { captureLogs } from "./remote_secrets_baseline_harness.ts";
import {
  acquireExplicitLease,
} from "../src/infrastructure/datastore_v3/explicit_model_leases.ts";
import { serveUpstreamAt } from "../src/infrastructure/datastore_v3/serve_upstream_registry.ts";
import { resetServeLeasesForTesting } from "../src/infrastructure/datastore_v3/serve_lease_registry.ts";
import { resetLeaseRenewalsForTesting } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import {
  resetServeOfflineForTesting,
  type ServeOfflineNotice,
  setServeOfflineNoticeWriter,
} from "../src/infrastructure/datastore_v3/serve_offline.ts";
import { runAsUserConfigEdit } from "../src/infrastructure/datastore_v3/config_edit_scope.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import {
  type CommitOutbox,
  outboxKeyOf,
} from "../src/domain/datastore_v3/commit_outbox.ts";
import { v3DatastoreFor } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { outboxEntryStatusesOf } from "../src/libswamp/datastores/status.ts";
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
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

type CommandContext = Awaited<
  ReturnType<typeof requireInitializedRepoUnlocked>
>;

const DATA_ID = "4f9b1f0e-2c3d-4e5f-8a6b-7c8d9e0f1a2b";

const TEAM: readonly GrantSpec[] = [
  ...MEMBER,
  {
    user: "bob",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "bob", actions: ["read", "write"], kind: "data", pattern: "*" },
];

interface OfflineProxy {
  readonly origin: string;
  dateShiftMs: number;
  answer:
    | ((
      request: Request,
      forward: () => Promise<Response>,
    ) => Promise<Response | undefined>)
    | undefined;
  down(): Promise<void>;
  up(): void;
  close(): Promise<void>;
}

function startOfflineProxy(target: string): OfflineProxy {
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let port = 0;
  const proxy: OfflineProxy = {
    origin: "",
    dateShiftMs: 0,
    answer: undefined,
    async down() {
      const running = server;
      server = undefined;
      await running?.shutdown();
    },
    up() {
      server = Deno.serve(
        { port, hostname: "127.0.0.1", onListen: () => {} },
        async (request) => {
          const url = new URL(request.url);
          const body = request.body === null
            ? undefined
            : new Uint8Array(await request.arrayBuffer());
          const forward = async () => {
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
            const replyHeaders = new Headers(response.headers);
            if (proxy.dateShiftMs !== 0) {
              replyHeaders.set(
                "date",
                new Date(Date.now() + proxy.dateShiftMs).toUTCString(),
              );
            }
            return new Response(await response.arrayBuffer(), {
              status: response.status,
              headers: replyHeaders,
            });
          };
          return await proxy.answer?.(request, forward) ?? await forward();
        },
      );
      port = server.addr.port;
      (proxy as { origin: string }).origin = `http://127.0.0.1:${port}`;
    },
    async close() {
      await proxy.down();
    },
  };
  proxy.up();
  return proxy;
}

async function withProxy(
  serve: Serve,
  fn: (proxy: OfflineProxy) => Promise<void>,
): Promise<void> {
  const proxy = startOfflineProxy(serve.origin);
  try {
    await fn(proxy);
  } finally {
    await proxy.close();
  }
}

async function command<T>(
  scratch: Pick<Scratch, "configDir">,
  client: Pick<Client, "repoDir">,
  env: Record<string, string | undefined>,
  fn: (ctx: CommandContext) => Promise<T>,
): Promise<T> {
  resetServeLeasesForTesting();
  resetLeaseRenewalsForTesting();
  resetServeOfflineForTesting();
  return await withClientEnv(scratch, env, ["model", "method"], async () => {
    try {
      const ctx = await requireInitializedRepoUnlocked({
        repoDir: client.repoDir,
        outputMode: "json",
      });
      return await runInRootUnitOfWork(
        ctx.repoContext,
        { flush: undefined },
        () => fn(ctx),
      );
    } finally {
      await endCommand();
    }
  });
}

async function saveOut(
  ctx: CommandContext,
  serve: Serve,
  by: string,
): Promise<number> {
  return (await ctx.repoContext.unifiedDataRepo.save(
    serve.modelType,
    serve.models.web,
    dataOf("out", DATA_ID),
    json({ by }),
  )).version;
}

async function readKindSave(
  ctx: CommandContext,
  serve: Serve,
  by: string,
): Promise<number> {
  await assertOfflineRunAllowed(ctx.datastoreConfig, {
    modelType: serve.modelType.normalized,
    modelId: serve.models.web,
    behaviorName: "web",
    methodName: "describe",
    methodKind: "read",
  });
  return await saveOut(ctx, serve, by);
}

/**
 * `deferred`: the writer hold leaves its catch-up to the lock, as a changing
 * `model method run` does, and the run is judged again once the lock is held
 */
async function lockedSave(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  env: Record<string, string | undefined>,
  by: string,
  options: { readonly deferred?: boolean; readonly read?: boolean } = {},
): Promise<number> {
  resetServeLeasesForTesting();
  resetLeaseRenewalsForTesting();
  resetServeOfflineForTesting();
  return await withClientEnv(scratch, env, ["model", "method"], async () => {
    try {
      const ctx = await requireInitializedRepoUnlocked({
        repoDir: client.repoDir,
        outputMode: "json",
        ...(options.deferred === true ? { catchUpAtLock: true } : {}),
      });
      const run = {
        modelType: serve.modelType.normalized,
        modelId: serve.models.web,
        behaviorName: "web",
        methodName: options.read === true ? "describe" : "update",
        methodKind: options.read === true ? "read" : "update",
      } as const;
      await assertOfflineRunAllowed(ctx.datastoreConfig, run);
      const locks = await acquireModelLocks(
        ctx.datastoreConfig,
        [{ modelType: serve.modelType.normalized, modelId: serve.models.web }],
        client.repoDir,
        ctx.syncService,
        ctx.repoContext.catalogStore,
        () => {},
        { repoContext: ctx.repoContext },
      );
      if (options.deferred === true) {
        try {
          await assertOfflineRunAllowed(ctx.datastoreConfig, run);
        } catch (error) {
          await locks.release();
          throw error;
        }
      }
      return await runCommandInRootUnit(
        ctx.repoContext,
        // the lock's own push, as a behavior run passes it: offline work that
        // queues must still resolve
        { push: () => locks.pushWritten([]), release: locks.release },
        () => saveOut(ctx, serve, by),
      );
    } finally {
      await endCommand();
    }
  });
}

async function takeLease(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  env: Record<string, string | undefined>,
): Promise<{ leaseId: string; fence: number }> {
  return await withClientEnv(scratch, env, ["model", "lease"], async () => {
    try {
      const resolution = await resolveDatastoreForRepo(client.repoDir);
      const root = (await v3LocationOf(resolution)).path;
      const serveClient = serveUpstreamAt(root)!.client();
      try {
        const taken = await acquireExplicitLease(
          root,
          serveClient,
          `data/${serve.modelType.normalized}/${serve.models.web}/.lock`,
          3_600_000,
          5_000,
          new AbortController().signal,
        );
        return { leaseId: taken.lease.leaseId, fence: taken.lease.fence! };
      } finally {
        serveClient.close();
      }
    } finally {
      await endCommand();
    }
  });
}

async function servedVersions(serve: Serve): Promise<number[]> {
  const versions: number[] = [];
  for (const entry of await serve.log()) {
    // A version's metadata key is both put and recorded: counted once.
    for (const key of new Set(entry.keys)) {
      const match = key.match(/\/out\/(\d+)\/metadata\.yaml$/);
      if (match !== null) versions.push(Number(match[1]));
    }
  }
  return versions;
}

async function latestBy(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  env: Record<string, string | undefined>,
): Promise<{ version: number; by: string } | null> {
  resetServeOfflineForTesting();
  const latest = await readCommand(
    scratch,
    client,
    env,
    (repos) => latestOf(repos, serve.modelType, serve.models.web, "out"),
  );
  if (latest === null) return null;
  return {
    version: latest.version,
    by: (JSON.parse(latest.content) as { by: string }).by,
  };
}

async function versionBy(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  env: Record<string, string | undefined>,
  version: number,
): Promise<string | null> {
  resetServeOfflineForTesting();
  const content = await readCommand(
    scratch,
    client,
    env,
    (repos) =>
      repos.unifiedDataRepo.getContent(
        serve.modelType,
        serve.models.web,
        "out",
        version,
      ),
  );
  return content === null
    ? null
    : (JSON.parse(new TextDecoder().decode(content)) as { by: string }).by;
}

Deno.test({
  name:
    "serve offline: under an explicit lease, two offline commands queue distinct versions and succeed, and the next writing command lands them under the lease",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        assertEquals(
          await command(
            scratch,
            alice,
            env,
            (ctx) => saveOut(ctx, serve, "online"),
          ),
          1,
        );
        const lease = await takeLease(scratch, serve, alice, env);

        await proxy.down();
        const notices: ServeOfflineNotice[] = [];
        setServeOfflineNoticeWriter((notice) => notices.push(notice));
        try {
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "offline 1"),
            2,
          );
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "offline 2"),
            3,
          );
          assertEquals(await servedVersions(serve), [1]);
          const queued = notices.filter((notice) =>
            notice.notice === "datastore_offline_queued"
          );
          assertEquals(
            queued.map((notice) =>
              notice.notice === "datastore_offline_queued" ? notice.queued : 0
            ),
            [1, 1],
          );

          proxy.up();
          await command(scratch, alice, env, () => Promise.resolve());
          assertEquals(await servedVersions(serve), [1, 2, 3]);
          const flushed = notices.find((notice) =>
            notice.notice === "datastore_offline_flush"
          );
          assertEquals(
            flushed?.notice === "datastore_offline_flush"
              ? flushed.landed
              : undefined,
            2,
          );
        } finally {
          setServeOfflineNoticeWriter(undefined);
        }
        const fenced = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => /\/out\/[23]\//.test(key))
        );
        assert(fenced.every((entry) => entry.leaseFence === lease.fence));
        assertEquals(await latestBy(scratch, serve, alice, env), {
          version: 3,
          by: "offline 2",
        });
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: a command under an explicit lease that loses serve before its commit stops with nothing landed, and the next command queues offline under the lease and flushes once serve is back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        assertEquals(
          await command(
            scratch,
            alice,
            env,
            (ctx) => saveOut(ctx, serve, "online"),
          ),
          1,
        );
        await takeLease(scratch, serve, alice, env);

        resetCommandLandedForTesting();
        const cut = await assertRejects(() =>
          command(scratch, alice, env, async (ctx) => {
            await proxy.down();
            return await saveOut(ctx, serve, "cut");
          })
        );
        assertEquals(commandLanded(), false);
        assertEquals(exitCodeForError(cut, { commandLanded: false }), 75);
        assertEquals(await servedVersions(serve), [1]);

        assertEquals(
          await lockedSave(scratch, serve, alice, env, "offline"),
          2,
        );
        assertEquals(await servedVersions(serve), [1]);

        proxy.up();
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2]);
        assertEquals(await latestBy(scratch, serve, alice, env), {
          version: 2,
          by: "offline",
        });
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: a second offline command never reuses the version a queued one holds, even once the checkout's files of it are gone",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await takeLease(scratch, serve, alice, env);
        await proxy.down();
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "offline 1"),
          2,
        );
        // As the interrupted-writer recovery leaves a killed command's
        // checkout: the queued version's files are gone.
        const queued: string[] = [];
        for await (
          const entry of walk(alice.repoDir, { includeFiles: false })
        ) {
          if (entry.path.endsWith(`${SEPARATOR}out${SEPARATOR}2`)) {
            queued.push(entry.path);
          }
        }
        assert(queued.length > 0);
        for (const path of queued) await Deno.remove(path, { recursive: true });
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "offline 2"),
          3,
        );
        proxy.up();
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2, 3]);
      });
    });
  },
});

/**
 * answers a partition read as a follower whose copy lags: with serve's head, or
 * `head` when given, and none of the commits past `through`
 */
async function laggingCommitReads(
  request: Request,
  forward: () => Promise<Response>,
  lag: { readonly through: number; readonly head?: number },
): Promise<Response | undefined> {
  if (
    request.method !== "GET" ||
    !/\/partitions\/.*\/commits$/.test(new URL(request.url).pathname)
  ) {
    return undefined;
  }
  const reply = await forward();
  const real = await reply.json() as {
    head: number;
    commits: { seq: number }[];
  };
  return Response.json({
    ...real,
    head: lag.head ?? real.head,
    commits: real.commits.filter((commit) => commit.seq <= lag.through),
  }, { status: reply.status, headers: reply.headers });
}

Deno.test({
  name:
    "serve offline flush: an offline write queued after a may-land commit that landed lands past it, flushed through a copy behind serve's head, never rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await takeLease(scratch, serve, alice, env);

        // The commit lands, but the client hears a follower that lost its
        // leader in flight, and cannot read whether it landed.
        let forwarded = false;
        proxy.answer = async (request, forward) => {
          const path = new URL(request.url).pathname;
          const write = request.method === "POST" && /\/commits$/.test(path);
          const read = request.method === "GET" &&
            /\/partitions\/.*\/commits$/.test(path);
          if (!write && !read) return undefined;
          if (write && !forwarded) {
            forwarded = true;
            await forward();
          }
          return Response.json(
            {
              code: "serve_not_leader",
              message: "This serve node lost its leader; try again",
              ...(write ? { inFlight: true } : {}),
            },
            { status: 503, headers: { "retry-after": "1" } },
          );
        };
        setServeReadRefusalBudgetForTesting(300);
        try {
          await assertRejects(() =>
            lockedSave(scratch, serve, alice, env, "may land", {
              deferred: true,
            })
          );
        } finally {
          setServeReadRefusalBudgetForTesting(undefined);
        }
        assertEquals(await servedVersions(serve), [1, 2]);

        // Allocated above the unconfirmed version, not on it.
        await proxy.down();
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "offline", {
            deferred: true,
          }),
          3,
        );
        assertEquals(await servedVersions(serve), [1, 2]);

        proxy.up();
        proxy.answer = (request, forward) =>
          laggingCommitReads(request, forward, { through: 1 });
        const notices: ServeOfflineNotice[] = [];
        setServeOfflineNoticeWriter((notice) => notices.push(notice));
        try {
          await command(scratch, alice, env, () => Promise.resolve());
        } finally {
          setServeOfflineNoticeWriter(undefined);
        }
        const flush = notices.find((notice) =>
          notice.notice === "datastore_offline_flush"
        );
        assert(flush?.notice === "datastore_offline_flush");
        assertEquals([flush.rejected, flush.rejectedWrites], [0, []]);
        assertEquals(await servedVersions(serve), [1, 2, 3]);
        proxy.answer = undefined;
        assertEquals(
          await versionBy(scratch, serve, alice, env, 3),
          "offline",
        );
      });
    });
  },
});

async function withOutbox<T>(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  fn: (outbox: CommitOutbox) => Promise<T>,
): Promise<T> {
  return await withClientEnv(
    scratch,
    env,
    ["datastore", "status"],
    async () => {
      try {
        await requireInitializedRepoUnlocked({
          repoDir: client.repoDir,
          outputMode: "json",
        });
        const location = await v3LocationOf(
          await resolveDatastoreForRepo(client.repoDir),
        );
        return await fn(v3DatastoreFor(client.repoDir, location).outbox);
      } finally {
        await endCommand();
      }
    },
  );
}

Deno.test({
  name:
    "serve offline flush: a change an older flush stranded as rejected for a live version is queued again by the next flush and lands, renumbered past what serve holds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await proxy.down();
        assertEquals(
          await command(
            scratch,
            alice,
            env,
            (ctx) => readKindSave(ctx, serve, "stranded"),
          ),
          2,
        );
        // As an older swamp left it: rejected with serve's message, no code.
        const listed = await withOutbox(scratch, alice, env, async (box) => {
          const { entries } = await box.entries();
          await box.markState(
            entries.map((entry) => outboxKeyOf(entry.commit)),
            "rejected",
            "Data out version 2 is already live; only an append re-records it",
          );
          return outboxEntryStatusesOf((await box.entries()).entries);
        });
        assertEquals(listed.length, 1);
        assertEquals(listed[0].retryable, true);
        assertEquals(
          listed[0].writes?.map((write) => [write.name, write.version]),
          [["out", 2]],
        );
        // Version 2 is live at serve, as the old message said.
        assertEquals(
          await writeCommand(
            scratch,
            bob,
            serveEnv(serve, "bob-token"),
            async (repos) =>
              (await repos.unifiedDataRepo.save(
                serve.modelType,
                serve.models.web,
                dataOf("out", DATA_ID),
                json({ by: "bob" }),
              )).version,
          ),
          2,
        );
        proxy.up();

        const notices: ServeOfflineNotice[] = [];
        setServeOfflineNoticeWriter((notice) => notices.push(notice));
        try {
          await command(scratch, alice, env, () => Promise.resolve());
        } finally {
          setServeOfflineNoticeWriter(undefined);
        }
        const flush = notices.find((notice) =>
          notice.notice === "datastore_offline_flush"
        );
        assert(flush?.notice === "datastore_offline_flush");
        assertEquals([flush.landed, flush.rejected], [1, 0]);
        // above bob's 2; a restatement of bob's version may take one number
        const served = await servedVersions(serve);
        assertEquals(served.slice(0, 2), [1, 2]);
        const by = await Promise.all(
          served.slice(2).map((version) =>
            versionBy(scratch, serve, alice, env, version)
          ),
        );
        assert(by.includes("stranded"));
        assertEquals(
          await versionBy(scratch, serve, alice, env, 2),
          "bob",
        );
        assertEquals(
          await withOutbox(
            scratch,
            alice,
            env,
            async (box) => (await box.entries()).entries.length,
          ),
          0,
        );
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: without a lease a changing run is refused with the code before it starts, a read-kind run and reads work, locked or not, a definition edit is refused, and a read-only command never flushes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );

        await proxy.down();
        const refused = await command(scratch, alice, env, async (ctx) => {
          const error = await assertRejects(
            () =>
              assertOfflineRunAllowed(ctx.datastoreConfig, {
                modelType: serve.modelType.normalized,
                modelId: serve.models.web,
                behaviorName: "web",
                methodName: "update",
                methodKind: undefined,
              }),
            OfflineLeaseRequiredError,
          );
          await assertRejects(
            () => runAsUserConfigEdit(() => Promise.resolve()),
            OfflineConfigEditError,
          );
          return error;
        });
        assertEquals(exitCodeForError(refused), 75);
        assertEquals(
          await command(
            scratch,
            alice,
            env,
            (ctx) => readKindSave(ctx, serve, "read offline"),
          ),
          2,
        );
        assertEquals(await latestBy(scratch, serve, alice, env), {
          version: 2,
          by: "read offline",
        });
        // the behavior's local lock only, as the lock a team-mode read takes
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "locked read offline", {
            read: true,
          }),
          3,
        );

        proxy.up();
        await latestBy(scratch, serve, alice, env);
        assertEquals(await servedVersions(serve), [1]);
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2, 3]);
      });
    });
  },
});

for (
  const { label, shiftMs, latest } of [
    {
      label: "clearly later becomes latest",
      shiftMs: 10 * 60_000,
      latest: { version: 3, by: "alice offline" },
    },
    {
      label: "clearly earlier leaves latest, restated",
      shiftMs: -10 * 60_000,
      latest: { version: 4, by: "bob online" },
    },
    {
      label: "within the window leaves latest, restated",
      shiftMs: 2 * 60_000,
      latest: { version: 4, by: "bob online" },
    },
  ] as const
) {
  Deno.test({
    name:
      `serve offline: a rebased offline write that was observed ${label}, by serve's clock`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve({ grants: TEAM });
        const alice = await scratch.client("a");
        const bob = await scratch.client("b");
        const bobEnv = serveEnv(serve, "bob-token");
        await withProxy(serve, async (proxy) => {
          proxy.dateShiftMs = shiftMs;
          const env = serveEnv(proxy, "alice-token");
          await command(
            scratch,
            alice,
            env,
            (ctx) => saveOut(ctx, serve, "first"),
          );

          await proxy.down();
          assertEquals(
            await command(
              scratch,
              alice,
              env,
              (ctx) => readKindSave(ctx, serve, "alice offline"),
            ),
            2,
          );
          assertEquals(
            await writeCommand(
              scratch,
              bob,
              bobEnv,
              async (repos) =>
                (await repos.unifiedDataRepo.save(
                  serve.modelType,
                  serve.models.web,
                  dataOf("out", DATA_ID),
                  json({ by: "bob online" }),
                )).version,
            ),
            2,
          );

          proxy.up();
          await command(scratch, alice, env, () => Promise.resolve());
          const served = await servedVersions(serve);
          assertEquals(served.slice(0, 3), [1, 2, 3]);
          assertEquals(await latestBy(scratch, serve, bob, bobEnv), latest);
          assertEquals(await latestBy(scratch, serve, alice, env), latest);
          assertEquals(
            await versionBy(scratch, serve, alice, env, 2),
            "bob online",
          );
        });
      });
    },
  });
}

Deno.test({
  name:
    "serve offline: entries queued under a lease an admin force-released meanwhile land rebased, after the newer data, never over it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: [
          ...TEAM,
          { user: "bob", actions: ["admin"], kind: "access", pattern: "*" },
        ],
      });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const bobEnv = serveEnv(serve, "bob-token");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "first"),
        );
        const lease = await takeLease(scratch, serve, alice, env);

        await proxy.down();
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "alice offline"),
          2,
        );
        // Bob, an admin, force-releases alice's lease at serve, as
        // `datastore lock release --force --behavior` does; alice's
        // checkout still records it.
        await withClientEnv(
          scratch,
          bobEnv,
          ["datastore", "lock"],
          async () => {
            try {
              const resolution = await resolveDatastoreForRepo(bob.repoDir);
              const root = (await v3LocationOf(resolution)).path;
              const client = serveUpstreamAt(root)!.client();
              try {
                const ended = await client.forceReleaseLock(
                  `data/${serve.modelType.normalized}/${serve.models.web}/.lock`,
                  new AbortController().signal,
                );
                assertEquals([ended.released, ended.heldBy], [
                  true,
                  "user:caller",
                ]);
                assert(lease.leaseId.length > 0);
              } finally {
                client.close();
              }
            } finally {
              await endCommand();
            }
          },
        );
        assertEquals(
          await writeCommand(
            scratch,
            bob,
            bobEnv,
            async (repos) =>
              (await repos.unifiedDataRepo.save(
                serve.modelType,
                serve.models.web,
                dataOf("out", DATA_ID),
                json({ by: "bob online" }),
              )).version,
          ),
          2,
        );

        proxy.up();
        await command(scratch, alice, env, () => Promise.resolve());
        const served = await servedVersions(serve);
        assertEquals(served.slice(0, 3), [1, 2, 3]);
        const landed = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => key.endsWith("/out/3/metadata.yaml"))
        );
        assertEquals(landed.length, 1);
        assertEquals(landed[0].leaseFence, undefined);
        assertEquals(await latestBy(scratch, serve, bob, bobEnv), {
          version: 4,
          by: "bob online",
        });
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: a flush cut off after serve took a commit resumes without landing it twice",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "first"),
        );
        await takeLease(scratch, serve, alice, env);
        await proxy.down();
        await lockedSave(scratch, serve, alice, env, "offline 1");
        await lockedSave(scratch, serve, alice, env, "offline 2");

        proxy.up();
        let commits = 0;
        proxy.answer = async (request, forward) => {
          if (
            request.method !== "POST" ||
            !new URL(request.url).pathname.endsWith("/commits")
          ) {
            return undefined;
          }
          commits++;
          const reply = await forward();
          if (commits !== 2) return reply;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("cut off"));
              },
            }),
            { status: reply.status, headers: reply.headers },
          );
        };
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(commits, 2);
        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());

        const log = await serve.log();
        const txnIds = log.map((entry) => entry.txnId);
        assertEquals(new Set(txnIds).size, txnIds.length);
        assertEquals(await servedVersions(serve), [1, 2, 3]);
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: a later command reads what an earlier one queued, by name, by version, in its model's listing and in the catalog, and still does after a read-only command reaches serve",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await takeLease(scratch, serve, alice, env);
        await proxy.down();
        await lockedSave(scratch, serve, alice, env, "queued");

        const reads = async () => {
          resetServeOfflineForTesting();
          return await readCommand(scratch, alice, env, async (repos) => {
            const latest = await repos.unifiedDataRepo.findByName(
              serve.modelType,
              serve.models.web,
              "out",
            );
            const versions = await repos.unifiedDataRepo.listVersions(
              serve.modelType,
              serve.models.web,
              "out",
            );
            const listed = await repos.unifiedDataRepo.findAllForModel(
              serve.modelType,
              serve.models.web,
            );
            // The fixture's saves carry no modelName tag, so the catalog
            // row's model name is empty.
            const row = repos.catalogStore.findLatestRow("", "out");
            return {
              latest: latest?.version,
              versions,
              listed: listed.filter((data) => data.name === "out")
                .map((data) => data.version),
              catalog: row?.version,
            };
          });
        };
        const expected = {
          latest: 2,
          versions: [1, 2],
          listed: [2],
          catalog: 2,
        };
        assertEquals(await reads(), expected);
        proxy.up();
        assertEquals(await reads(), expected);
        assertEquals(await servedVersions(serve), [1]);
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: three offline writes observed within five minutes before a version that landed meanwhile all leave that version latest after one flush",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const bobEnv = serveEnv(serve, "bob-token");
      await withProxy(serve, async (proxy) => {
        // Serve's clock, as alice last saw it, runs two minutes behind
        // hers: her offline work is observed two minutes before Bob's.
        proxy.dateShiftMs = -2 * 60_000;
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "first"),
        );

        await proxy.down();
        for (const by of ["offline 1", "offline 2", "offline 3"]) {
          await command(
            scratch,
            alice,
            env,
            (ctx) => readKindSave(ctx, serve, by),
          );
        }
        await writeCommand(
          scratch,
          bob,
          bobEnv,
          (repos) =>
            repos.unifiedDataRepo.save(
              serve.modelType,
              serve.models.web,
              dataOf("out", DATA_ID),
              json({ by: "bob online" }),
            ),
        );

        proxy.up();
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(
          (await latestBy(scratch, serve, bob, bobEnv))?.by,
          "bob online",
        );
        assertEquals(
          (await latestBy(scratch, serve, alice, env))?.by,
          "bob online",
        );
        const served = await servedVersions(serve);
        assertEquals(served.slice(0, 2), [1, 2]);
        const contents: (string | null)[] = [];
        for (const version of served) {
          contents.push(await versionBy(scratch, serve, bob, bobEnv, version));
        }
        for (const by of ["offline 1", "offline 2", "offline 3"]) {
          assert(contents.includes(by), `${by} landed`);
        }
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: a writing command offline leaves the repo's existing config for a later online command to adopt, without a warning",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM, managedConfig: true });
      const alice = await scratch.client("a", { managedConfig: true });
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        // Read online first, so the copy has read the feed; a read-only
        // command adopts nothing.
        await readCommand(scratch, alice, env, () => Promise.resolve());
        const vaultId = crypto.randomUUID();
        const vaultDir = join(alice.repoDir, "vaults", "local_encryption");
        await Deno.mkdir(vaultDir, { recursive: true });
        await Deno.writeTextFile(
          join(vaultDir, `${vaultId}.yaml`),
          `id: ${vaultId}\nname: default\ntype: local_encryption\n`,
        );
        await proxy.down();
        const logs = await captureLogs(async () => {
          await command(
            scratch,
            alice,
            env,
            (ctx) => readKindSave(ctx, serve, "offline"),
          );
        });
        const adoption = logs.filter((log) =>
          log.level === "warning" && log.text.includes("config tier")
        );
        assertEquals(adoption, []);
      });
    });
  },
});

Deno.test({
  name:
    "serve offline: a read-only command says in json mode that it reads the copy as last seen, as a writing command says it works offline",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await proxy.down();
        const notices: ServeOfflineNotice[] = [];
        try {
          resetServeOfflineForTesting();
          setServeOfflineNoticeWriter((notice) => notices.push(notice));
          await readCommand(scratch, alice, env, () => Promise.resolve());
        } finally {
          setServeOfflineNoticeWriter(undefined);
        }
        assertEquals(notices.map((notice) => notice.notice), [
          "datastore_offline",
        ]);
        const [notice] = notices;
        assert(notice.notice === "datastore_offline");
        assertEquals(notice.serveUrl, proxy.origin);
        assert(notice.lastContactAt !== undefined);
      });
    });
  },
});

Deno.test({
  name:
    "serve offline, catch-up left to the lock: a lock that finds serve unreachable takes the checkout offline; under an explicit lease the command queues, and the next lands it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        assertEquals(
          await command(
            scratch,
            alice,
            env,
            (ctx) => saveOut(ctx, serve, "online"),
          ),
          1,
        );
        const lease = await takeLease(scratch, serve, alice, env);

        await proxy.down();
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "offline", {
            deferred: true,
          }),
          2,
        );
        assertEquals(await servedVersions(serve), [1]);

        proxy.up();
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2]);
        const fenced = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => /\/out\/2\//.test(key))
        );
        assert(fenced.every((entry) => entry.leaseFence === lease.fence));
      });
    });
  },
});

Deno.test({
  name:
    "serve offline, catch-up left to the lock: without a lease a changing run is refused with the code once its lock finds serve unreachable, before it changes anything",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await proxy.down();
        const refused = await assertRejects(
          () =>
            lockedSave(scratch, serve, alice, env, "offline", {
              deferred: true,
            }),
          OfflineLeaseRequiredError,
        );
        assertEquals(exitCodeForError(refused), 75);
        proxy.up();
        assertEquals(await servedVersions(serve), [1]);
      });
    });
  },
});

/**
 * serve grants locks, answered without their catch-up, but a read of its
 * changes feed loses the connection after its headers
 */
function dropChangesReads(proxy: OfflineProxy): string[] {
  const dropped: string[] = [];
  proxy.answer = async (request, forward) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && /\/locks$/.test(path)) {
      const granted = await forward();
      const body = await granted.json();
      delete body.catchUp;
      return Response.json(body, {
        status: granted.status,
        headers: granted.headers,
      });
    }
    if (request.method !== "GET" || !/\/changes$/.test(path)) {
      return undefined;
    }
    dropped.push(path);
    const answered = await forward();
    await answered.body?.cancel();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection lost"));
        },
      }),
      { status: answered.status, headers: answered.headers },
    );
  };
  return dropped;
}

Deno.test({
  name:
    "serve offline at the lock's catch-up: under a live explicit lease a lock granted whose catch-up loses serve takes the checkout offline, the command queues, and the next lands it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        const lease = await takeLease(scratch, serve, alice, env);

        const dropped = dropChangesReads(proxy);
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "offline", {
            deferred: true,
          }),
          2,
        );
        assert(dropped.length > 0);
        assertEquals(await servedVersions(serve), [1]);

        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2]);
        const fenced = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => /\/out\/2\//.test(key))
        );
        assert(fenced.every((entry) => entry.leaseFence === lease.fence));
      });
    });
  },
});

Deno.test({
  name:
    "serve offline at the lock's catch-up: without an explicit lease a lock granted whose catch-up loses serve exits 75 as unreachable, before it changes anything",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        const dropped = dropChangesReads(proxy);
        const refused = await assertRejects(() =>
          lockedSave(scratch, serve, alice, env, "offline", {
            deferred: true,
          })
        );
        assert(dropped.length > 0);
        assertEquals(exitCodeForError(refused), 75);
        assertEquals(
          (refused as { code?: string }).code,
          "datastore_v3_serve_unreachable",
        );
        proxy.answer = undefined;
        assertEquals(await servedVersions(serve), [1]);
      });
    });
  },
});

Deno.test({
  name:
    "serve online, catch-up at the lock: a copy further behind than a lock may catch up releases the lock, catches up outside it and takes it again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const bobEnv = serveEnv(serve, "bob-token");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "alice"),
        );
        for (let i = 0; i < 3; i++) {
          await writeCommand(scratch, bob, bobEnv, async (repos) => {
            await repos.unifiedDataRepo.save(
              serve.modelType,
              serve.models.web,
              dataOf("out", DATA_ID),
              json({ by: `bob ${i}` }),
            );
          });
        }
        const locks: string[] = [];
        proxy.answer = (request) => {
          const path = new URL(request.url).pathname;
          if (/\/locks(\/|$)/.test(path)) {
            locks.push(request.method);
          }
          return Promise.resolve(undefined);
        };
        setLockCatchUpMaxCommitsForTesting(1);
        try {
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "alice again", {
              deferred: true,
            }),
            5,
          );
        } finally {
          setLockCatchUpMaxCommitsForTesting();
        }
        const asks = locks.filter((method) => method === "POST");
        assertEquals(asks.length, 2);
        assert(locks.indexOf("DELETE") < locks.lastIndexOf("POST"));
        assertEquals(await servedVersions(serve), [1, 2, 3, 4, 5]);
      });
    });
  },
});

/** a follower with no leader: reads pass, a lock or commit is refused */
function refuseWritesWithoutLeader(
  proxy: OfflineProxy,
  options: { readonly inFlight?: boolean } = {},
): string[] {
  const refused: string[] = [];
  proxy.answer = (request) => {
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" || !/\/(locks|commits)(\/|$)/.test(path)
    ) {
      return Promise.resolve(undefined);
    }
    refused.push(`${request.method} ${path}`);
    return Promise.resolve(Response.json(
      {
        code: "serve_not_leader",
        message: "This serve node does not lead the datastore; try again",
        ...(options.inFlight === true ? { inFlight: true } : {}),
      },
      { status: 503, headers: { "retry-after": "5" } },
    ));
  };
  return refused;
}

Deno.test({
  name:
    "serve offline, no leader: under an explicit lease a lock refused as not the leader takes the checkout offline at once, the command queues, and the next lands it under the lease",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        const lease = await takeLease(scratch, serve, alice, env);

        const refused = refuseWritesWithoutLeader(proxy);
        const notices: ServeOfflineNotice[] = [];
        setServeOfflineNoticeWriter((notice) => notices.push(notice));
        const started = performance.now();
        try {
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "no leader", {
              deferred: true,
            }),
            2,
          );
        } finally {
          setServeOfflineNoticeWriter(undefined);
        }
        assert(performance.now() - started < 15_000);
        // the bind's renewal only: the lock goes offline on its refusal
        assertEquals(leaseRenewals(refused), 1);
        assertEquals(await servedVersions(serve), [1]);
        const offline = notices.find((notice) =>
          notice.notice === "datastore_offline"
        );
        assert(
          offline?.notice === "datastore_offline" &&
            offline.message.includes("no leader"),
        );
        assert(
          notices.some((notice) =>
            notice.notice === "datastore_offline_queued"
          ),
        );

        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2]);
        const fenced = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => /\/out\/2\//.test(key))
        );
        assert(fenced.every((entry) => entry.leaseFence === lease.fence));
        assertEquals(await latestBy(scratch, serve, alice, env), {
          version: 2,
          by: "no leader",
        });
      });
    });
  },
});

Deno.test({
  name:
    "serve offline, no leader: without a lease a lock refused as not the leader is not queued and fails as serve_not_leader with exit 75",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        refuseWritesWithoutLeader(proxy);
        setServeReadRefusalBudgetForTesting(300);
        let error: Error;
        try {
          error = await assertRejects(
            () =>
              lockedSave(scratch, serve, alice, env, "no leader", {
                deferred: true,
              }),
            ServeNotLeaderError,
          );
        } finally {
          setServeReadRefusalBudgetForTesting(undefined);
        }
        assertEquals(exitCodeForError(error), 75);
        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1]);
      });
    });
  },
});

/** counts the lease renewals (PUT locks/{id}) the proxy saw */
function leaseRenewals(refused: readonly string[]): number {
  return refused.filter((call) => /^PUT .*\/locks\/[^/]+$/.test(call))
    .length;
}

Deno.test({
  name:
    "serve offline, no leader: under an explicit lease a renewal refused as forwarded in flight takes the checkout offline after one renewal, and the command queues",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        const lease = await takeLease(scratch, serve, alice, env);
        const refused = refuseWritesWithoutLeader(proxy, { inFlight: true });
        const notices: ServeOfflineNotice[] = [];
        setServeOfflineNoticeWriter((notice) => notices.push(notice));
        try {
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "in flight", {
              deferred: true,
            }),
            2,
          );
        } finally {
          setServeOfflineNoticeWriter(undefined);
        }
        // the bind's renewal only: the lock goes offline on its refusal
        assertEquals(leaseRenewals(refused), 1);
        assert(
          notices.some((notice) =>
            notice.notice === "datastore_offline_queued"
          ),
        );
        assertEquals(await servedVersions(serve), [1]);

        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2]);
        const fenced = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => /\/out\/2\//.test(key))
        );
        assert(fenced.every((entry) => entry.leaseFence === lease.fence));
      });
    });
  },
});

Deno.test({
  name:
    "serve offline, no leader: without a lease a lock refused as forwarded in flight is not queued and fails with exit 75",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        refuseWritesWithoutLeader(proxy, { inFlight: true });
        setServeReadRefusalBudgetForTesting(300);
        let error: ServeNotLeaderError;
        try {
          error = await assertRejects(
            () =>
              lockedSave(scratch, serve, alice, env, "in flight", {
                deferred: true,
              }),
            ServeNotLeaderError,
          );
        } finally {
          setServeReadRefusalBudgetForTesting(undefined);
        }
        assert(error.inFlight);
        assertEquals(exitCodeForError(error), 75);
        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1]);
      });
    });
  },
});

Deno.test({
  name:
    "serve offline, frozen leader: under an explicit lease a renewal serve never answers takes the checkout offline within 15 s after one renewal, and the command queues",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        const lease = await takeLease(scratch, serve, alice, env);
        // a leader stopped mid-reply: the renewal is accepted, never answered
        const hung: string[] = [];
        const unhang: Array<() => void> = [];
        proxy.answer = (request) => {
          const path = new URL(request.url).pathname;
          if (request.method !== "PUT" || !/\/locks\/[^/]+$/.test(path)) {
            return Promise.resolve(undefined);
          }
          hung.push(`${request.method} ${path}`);
          return new Promise((resolve) =>
            unhang.push(() => resolve(new Response(null, { status: 503 })))
          );
        };
        const notices: ServeOfflineNotice[] = [];
        setServeOfflineNoticeWriter((notice) => notices.push(notice));
        let outcome:
          | { readonly version: number }
          | { readonly error: unknown }
          | undefined;
        const saving = lockedSave(scratch, serve, alice, env, "frozen", {
          deferred: true,
        }).then(
          (version) => outcome = { version },
          (error) => outcome = { error },
        );
        try {
          await waitFor(
            () => outcome !== undefined,
            "the leased write to go offline and queue",
            { timeoutMs: 15_000 },
          );
        } finally {
          for (const release of unhang) release();
          await saving;
          setServeOfflineNoticeWriter(undefined);
        }
        assertEquals(outcome, { version: 2 });
        assertEquals(leaseRenewals(hung), 1);
        assert(
          notices.some((notice) =>
            notice.notice === "datastore_offline_queued"
          ),
        );
        assertEquals(await servedVersions(serve), [1]);

        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2]);
        const fenced = (await serve.log()).filter((entry) =>
          entry.keys.some((key) => /\/out\/2\//.test(key))
        );
        assert(fenced.every((entry) => entry.leaseFence === lease.fence));
      });
    });
  },
});

Deno.test({
  name:
    "serve offline, frozen leader: a command whose bind-time renewal times out never sends the entries it inherited, and queues its own write within 15 s",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      const alice = await scratch.client("a");
      await withProxy(serve, async (proxy) => {
        const env = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          alice,
          env,
          (ctx) => saveOut(ctx, serve, "online"),
        );
        await takeLease(scratch, serve, alice, env);
        await proxy.down();
        assertEquals(
          await lockedSave(scratch, serve, alice, env, "inherited"),
          2,
        );
        proxy.up();
        // a leader stopped mid-reply: renewals and commits are accepted, never
        // answered
        const hung: string[] = [];
        const unhang: Array<() => void> = [];
        proxy.answer = (request) => {
          const path = new URL(request.url).pathname;
          const renewal = request.method === "PUT" &&
            /\/locks\/[^/]+$/.test(path);
          const commit = request.method === "POST" && /\/commits$/.test(path);
          if (!renewal && !commit) return Promise.resolve(undefined);
          hung.push(`${request.method} ${path}`);
          return new Promise((resolve) =>
            unhang.push(() => resolve(new Response(null, { status: 503 })))
          );
        };
        let outcome:
          | { readonly version: number }
          | { readonly error: unknown }
          | undefined;
        const saving = lockedSave(scratch, serve, alice, env, "frozen", {
          deferred: true,
        }).then(
          (version) => outcome = { version },
          (error) => outcome = { error },
        );
        try {
          await waitFor(
            () => outcome !== undefined,
            "the leased write to go offline and queue",
            { timeoutMs: 15_000 },
          );
        } finally {
          for (const release of unhang) release();
          await saving;
        }
        assertEquals(outcome, { version: 3 });
        assertEquals(
          hung.filter((call) => call.startsWith("POST ")),
          [],
          "no inherited entry was sent",
        );
        assertEquals(leaseRenewals(hung), 1);
        assertEquals(await servedVersions(serve), [1]);

        proxy.answer = undefined;
        await command(scratch, alice, env, () => Promise.resolve());
        assertEquals(await servedVersions(serve), [1, 2, 3]);
      });
    });
  },
});

for (const inFlight of [false, true]) {
  Deno.test({
    name:
      `serve offline, no leader: a command whose bind-time renewal is refused as not the leader${
        inFlight ? ", forwarded in flight," : ""
      } never sends the entries it inherited, and queues its own write`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withScratch(async (scratch) => {
        const serve = await scratch.serve({ grants: TEAM });
        const alice = await scratch.client("a");
        await withProxy(serve, async (proxy) => {
          const env = serveEnv(proxy, "alice-token");
          await command(
            scratch,
            alice,
            env,
            (ctx) => saveOut(ctx, serve, "online"),
          );
          await takeLease(scratch, serve, alice, env);
          await proxy.down();
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "inherited"),
            2,
          );
          proxy.up();
          const refused = refuseWritesWithoutLeader(proxy, { inFlight });
          assertEquals(
            await lockedSave(scratch, serve, alice, env, "no leader", {
              deferred: true,
            }),
            3,
          );
          assertEquals(
            refused.filter((call) => call.startsWith("POST ")),
            [],
            "no inherited entry was sent",
          );
          assertEquals(leaseRenewals(refused), 1);
          assertEquals(await servedVersions(serve), [1]);

          proxy.answer = undefined;
          await command(scratch, alice, env, () => Promise.resolve());
          assertEquals(await servedVersions(serve), [1, 2, 3]);
        });
      });
    },
  });
}
