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
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import {
  commandLanded,
  resetCommandLandedForTesting,
} from "../src/infrastructure/datastore_v3/command_landed.ts";
import { ServeLeaseLapsedError } from "../src/infrastructure/datastore_v3/serve_lock.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { tryAcquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import {
  type Client,
  dataOf,
  endCommand,
  json,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const DATA_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a71";

/** a serve whose answers can stop: stalled requests never answer */
interface StallProxy {
  readonly origin: string;
  readonly requests: string[];
  stall: ((request: Request) => boolean) | undefined;
  down(): Promise<void>;
  close(): Promise<void>;
}

function startStallProxy(target: string): StallProxy {
  let unstall: () => void = () => {};
  const unstalled = new Promise<void>((resolve) => unstall = resolve);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      proxy.requests.push(`${request.method} ${url.pathname}`);
      const body = request.body === null
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
      if (proxy.stall?.(request) === true) {
        await unstalled;
        return new Response("closing", { status: 503 });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(`${target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(body !== undefined
          ? { body: body as Uint8Array<ArrayBuffer> }
          : {}),
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    },
  );
  let closed = false;
  const proxy: StallProxy = {
    origin: `http://127.0.0.1:${server.addr.port}`,
    requests: [],
    stall: undefined,
    async down() {
      if (closed) return;
      closed = true;
      unstall();
      await server.shutdown();
    },
    async close() {
      await proxy.down();
    },
  };
  return proxy;
}

const isCommit = (request: Request) =>
  request.method === "POST" &&
  new URL(request.url).pathname.endsWith("/commits");

function envOf(proxy: StallProxy): Record<string, string | undefined> {
  // short, so a stalled request gives up within the test
  return { ...serveEnv(proxy, "alice-token"), SWAMP_SERVE_TIMEOUT_MS: "1000" };
}

/** one command saving the behavior's data, as a step's commit does */
async function save(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  proxy: StallProxy,
  by: string,
): Promise<number> {
  return await withClientEnv(
    scratch,
    envOf(proxy),
    ["model", "method"],
    async () => {
      try {
        const ctx = await requireInitializedRepoUnlocked({
          repoDir: client.repoDir,
          outputMode: "json",
        });
        return await runCommandInRootUnit(
          ctx.repoContext,
          { push: undefined },
          async () =>
            (await ctx.repoContext.unifiedDataRepo.save(
              serve.modelType,
              serve.models.web,
              dataOf("out", DATA_ID),
              json({ by }),
            )).version,
        );
      } finally {
        await endCommand();
      }
    },
  );
}

async function assertWriterFree(client: Client, proxy: StallProxy) {
  const release = await tryAcquireV3WriterLock(
    serveUpstreamLocalRoot(client.repoDir, proxy.origin, ""),
  );
  assert(release !== undefined, "the command released the writer lock");
  await release();
}

Deno.test({
  name:
    "serve upstream stalled: a commit serve never answers ends the command without another request and frees the writer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const proxy = startStallProxy(serve.origin);
      try {
        const client = await scratch.client("a");
        assertEquals(await save(scratch, serve, client, proxy, "seed"), 1);

        resetCommandLandedForTesting();
        proxy.stall = isCommit;
        const sentBefore = proxy.requests.length;
        const error = await assertRejects(() =>
          save(scratch, serve, client, proxy, "stalled")
        );
        const sent = proxy.requests.slice(sentBefore);
        assertEquals(
          sent.filter((r) => r.startsWith("POST") && r.endsWith("/commits"))
            .length,
          1,
          `one commit was sent: ${sent.join(", ")}`,
        );
        assert(
          sent.at(-1)!.endsWith("/commits"),
          `nothing was sent after the stalled commit: ${sent.join(", ")}`,
        );
        // serve may have taken it: not a blind retry
        assertEquals(commandLanded(), true);
        assertEquals(exitCodeForError(error, { commandLanded: true }), 1);
        await assertWriterFree(client, proxy);

        proxy.stall = undefined;
        resetCommandLandedForTesting();
        // a later process settles the kept entry first; in this one process
        // its writer still counts as live, so only the next save is checked
        const after = await save(scratch, serve, client, proxy, "after");
        const outs = (await serve.log())
          .flatMap((entry) => entry.keys)
          .filter((key) => key.includes("/out/") && key.endsWith("/raw"));
        assertEquals(new Set(outs).size, outs.length, "nothing landed twice");
        assert(outs.length === after, outs.join(", "));
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "serve upstream stalled: a lease left unrenewed lapses, and the rest of the command fails without asking serve again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const proxy = startStallProxy(serve.origin);
      try {
        const client = await scratch.client("a");
        assertEquals(await save(scratch, serve, client, proxy, "seed"), 1);
        resetCommandLandedForTesting();
        await withClientEnv(
          scratch,
          envOf(proxy),
          ["model", "method"],
          async () => {
            try {
              const ctx = await requireInitializedRepoUnlocked({
                repoDir: client.repoDir,
                outputMode: "json",
              });
              const type = serve.modelType.normalized;
              const locks = await acquireModelLocks(
                ctx.datastoreConfig,
                [{ modelType: type, modelId: serve.models.web }],
                client.repoDir,
                ctx.syncService,
                ctx.repoContext.catalogStore,
                () => {},
                { repoContext: ctx.repoContext },
              );
              try {
                // serve blackholed: renewals, and everything after, hang
                proxy.stall = () => true;
                await waitFor(
                  () => locks.leaseLost!.aborted,
                  "the lease to lapse",
                  { timeoutMs: 60_000 },
                );
                const lapsed = locks.leaseLost!.reason;
                assertInstanceOf(lapsed, ServeLeaseLapsedError);
                const sentAtLapse = proxy.requests.length;
                await assertRejects(() =>
                  runCommandInRootUnit(
                    ctx.repoContext,
                    { push: undefined },
                    async () => {
                      await ctx.repoContext.unifiedDataRepo.save(
                        serve.modelType,
                        serve.models.web,
                        dataOf("out", DATA_ID),
                        json({ by: "late" }),
                      );
                    },
                  )
                );
                assertEquals(
                  proxy.requests.slice(sentAtLapse),
                  [],
                  "nothing was sent once the lease lapsed unrenewed",
                );
                assertEquals(
                  exitCodeForError(lapsed, { commandLanded: commandLanded() }),
                  75,
                );
              } finally {
                await locks.release();
              }
            } finally {
              await endCommand();
            }
          },
        );
        await assertWriterFree(client, proxy);
      } finally {
        await proxy.close();
      }
    });
  },
});
