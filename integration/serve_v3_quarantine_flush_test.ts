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
 * A grant revoked while a member worked offline (swamp-club#4195), end to
 * end: serve in a Worker, and checkouts reaching it through a proxy that
 * can be taken down. The member's flush finds the change refused for the
 * grant it lost: it is quarantined in the member's outbox and handed to
 * serve. A non-admin cannot accept it; an admin lands it, as the member,
 * and the member's next command settles its entry.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertOfflineRunAllowed,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
  v3LocationOf,
} from "../src/cli/repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { serveUpstreamAt } from "../src/infrastructure/datastore_v3/serve_upstream_registry.ts";
import { resetServeLeasesForTesting } from "../src/infrastructure/datastore_v3/serve_lease_registry.ts";
import { resetLeaseRenewalsForTesting } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { resetServeOfflineForTesting } from "../src/infrastructure/datastore_v3/serve_offline.ts";
import { ServeUpstreamError } from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import { v3DatastoreFor } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  type DatastoreOutboxEntryStatus,
  outboxEntryStatusesOf,
} from "../src/libswamp/datastores/status.ts";
import {
  type Client,
  dataOf,
  endCommand,
  json,
  MEMBER,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

const DATA_ID = "5a0c2e1f-3d4e-4f60-9b7c-8d9e0f1a2b3c";

/** Bob may read every behavior and its data. */
const BOB_READS: readonly GrantSpec[] = [
  { user: "bob", actions: ["read"], kind: "model", pattern: "*" },
  { user: "bob", actions: ["read"], kind: "data", pattern: "*" },
];

/** Bob may also write them, until it is revoked. */
const BOB_WRITES: readonly GrantSpec[] = [
  {
    user: "bob",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "bob", actions: ["read", "write"], kind: "data", pattern: "*" },
];

/** Alice (the harness's caller) is a member and an admin. */
const ALICE_ADMIN: readonly GrantSpec[] = [
  ...MEMBER,
  { actions: ["admin"], kind: "access", pattern: "*" },
];

/** A proxy in front of serve that can be taken down and brought back. */
interface Proxy {
  readonly origin: string;
  down(): Promise<void>;
  up(): void;
}

function startProxy(target: string): Proxy {
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let port = 0;
  const proxy: Proxy = {
    origin: "",
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
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: response.headers,
          });
        },
      );
      port = server.addr.port;
      (proxy as { origin: string }).origin = `http://127.0.0.1:${port}`;
    },
  };
  proxy.up();
  return proxy;
}

/**
 * One writing command in `client`, opened as `model method run` opens it:
 * no lease registered, no offline mode, as a new process starts.
 */
async function command<T>(
  scratch: Pick<Scratch, "configDir">,
  client: Pick<Client, "repoDir">,
  env: Record<string, string | undefined>,
  fn: (
    ctx: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>,
  ) => Promise<T>,
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

/** A read-kind run's save of `out` on web: allowed offline without a lease. */
async function readKindSave(
  ctx: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>,
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
  return (await ctx.repoContext.unifiedDataRepo.save(
    serve.modelType,
    serve.models.web,
    dataOf("out", DATA_ID),
    json({ by }),
  )).version;
}

/** The kept entries of `client`'s outbox, as `datastore status` lists them. */
async function keptEntries(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
): Promise<DatastoreOutboxEntryStatus[]> {
  return await withClientEnv(
    scratch,
    env,
    ["datastore", "status"],
    async () => {
      try {
        const resolution = await resolveDatastoreForRepo(client.repoDir);
        const v3 = v3DatastoreFor(
          client.repoDir,
          await v3LocationOf(resolution),
        );
        return outboxEntryStatusesOf((await v3.outbox.entries()).entries);
      } finally {
        await endCommand();
      }
    },
  );
}

/** Asks serve, as `client`'s caller, to accept the kept change `txnId`. */
async function accept(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  txnId: string,
): Promise<Record<string, unknown>> {
  return await decide(scratch, client, env, txnId, "accept");
}

/** Asks serve, as `client`'s caller, to discard the kept change `txnId`. */
async function discard(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  txnId: string,
): Promise<Record<string, unknown>> {
  return await decide(scratch, client, env, txnId, "discard");
}

/** Asks serve, as `client`'s caller, to accept or discard `txnId`. */
async function decide(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  txnId: string,
  action: "accept" | "discard",
): Promise<Record<string, unknown>> {
  return await withClientEnv(
    scratch,
    env,
    ["datastore", "quarantine"],
    async () => {
      try {
        const resolution = await resolveDatastoreForRepo(client.repoDir);
        const root = (await v3LocationOf(resolution)).path;
        const serveClient = serveUpstreamAt(root)!.client();
        try {
          const signal = new AbortController().signal;
          return action === "accept"
            ? await serveClient.acceptQuarantine(txnId, signal)
            : await serveClient.discardQuarantine(txnId, signal);
        } finally {
          serveClient.close();
        }
      } finally {
        await endCommand();
      }
    },
  );
}

Deno.test({
  name:
    "serve quarantine: a grant revoked while offline quarantines the change and hands it to serve; an admin lands it as its author and the author's next command settles it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: [...ALICE_ADMIN, ...BOB_WRITES],
      });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const proxy = startProxy(serve.origin);
      try {
        const bobEnv = serveEnv(proxy, "bob-token");
        const aliceEnv = serveEnv(proxy, "alice-token");
        assertEquals(
          await command(
            scratch,
            bob,
            bobEnv,
            (ctx) => readKindSave(ctx, serve, "online"),
          ),
          1,
        );

        await proxy.down();
        assertEquals(
          await command(
            scratch,
            bob,
            bobEnv,
            (ctx) => readKindSave(ctx, serve, "offline"),
          ),
          2,
        );
        // Revoked while bob is offline.
        await serve.setGrants([...ALICE_ADMIN, ...BOB_READS]);
        proxy.up();

        // Bob's next command flushes: refused for the grant he lost.
        await command(scratch, bob, bobEnv, () => Promise.resolve());
        const kept = await keptEntries(scratch, bob, bobEnv);
        assertEquals(kept.map((entry) => entry.state), ["quarantined"]);
        const txnId = kept[0].txnId;
        assert(
          !(await serve.log()).some((entry) => entry.txnId === txnId),
          "serve refused the change",
        );

        // Bob cannot accept his own change.
        const refused = await assertRejects(
          () => accept(scratch, bob, bobEnv, txnId),
          ServeUpstreamError,
        );
        assertEquals(refused.status, 403);

        // Alice, an admin, lands it as bob.
        const accepted = await accept(scratch, alice, aliceEnv, txnId);
        assertEquals(accepted.principal, "user:bob");
        assertEquals(accepted.acceptedBy, "user:caller");
        const landed = (await serve.log()).find((entry) =>
          entry.txnId === txnId
        );
        assertEquals(landed?.principal, "user:bob");

        // Bob's next command finds it landed and settles it.
        await command(scratch, bob, bobEnv, () => Promise.resolve());
        assertEquals(await keptEntries(scratch, bob, bobEnv), []);
      } finally {
        await proxy.down();
      }
    });
  },
});

Deno.test({
  name:
    "serve quarantine: a change an admin discards never lands; the author's next command keeps its entry as rejected and never sends it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: [...ALICE_ADMIN, ...BOB_WRITES],
      });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const proxy = startProxy(serve.origin);
      try {
        const bobEnv = serveEnv(proxy, "bob-token");
        const aliceEnv = serveEnv(proxy, "alice-token");
        await command(
          scratch,
          bob,
          bobEnv,
          (ctx) => readKindSave(ctx, serve, "online"),
        );
        await proxy.down();
        await command(
          scratch,
          bob,
          bobEnv,
          (ctx) => readKindSave(ctx, serve, "offline"),
        );
        await serve.setGrants([...ALICE_ADMIN, ...BOB_READS]);
        proxy.up();
        await command(scratch, bob, bobEnv, () => Promise.resolve());
        const kept = await keptEntries(scratch, bob, bobEnv);
        assertEquals(kept.map((entry) => entry.state), ["quarantined"]);
        const txnId = kept[0].txnId;

        // Bob cannot discard it; alice, an admin, does.
        const refused = await assertRejects(
          () => discard(scratch, bob, bobEnv, txnId),
          ServeUpstreamError,
        );
        assertEquals(refused.status, 403);
        const discarded = await discard(scratch, alice, aliceEnv, txnId);
        assertEquals(discarded.state, "discarded");

        // Bob's next command keeps it as rejected, declined at serve.
        await command(scratch, bob, bobEnv, () => Promise.resolve());
        const declined = await keptEntries(scratch, bob, bobEnv);
        assertEquals(declined.map((entry) => entry.state), ["rejected"]);
        assertEquals(declined[0].txnId, txnId);
        assertEquals(declined[0].reason, "discarded at serve by an admin");

        // Even with the grant back, it is never sent again.
        await serve.setGrants([...ALICE_ADMIN, ...BOB_WRITES]);
        await command(scratch, bob, bobEnv, () => Promise.resolve());
        assertEquals(
          (await keptEntries(scratch, bob, bobEnv)).map((entry) => entry.state),
          ["rejected"],
        );
        assert(
          !(await serve.log()).some((entry) => entry.txnId === txnId),
          "a discarded change never lands",
        );
      } finally {
        await proxy.down();
      }
    });
  },
});
