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
 * A v3 checkout whose datastore is written through serve (swamp-club#3985),
 * opened the production way (`requireInitializedRepo*`) with serve's
 * address in the environment, against a real serve in a Worker. The
 * client's `.swamp.yaml` names the same v3 datastore as serve's on a bucket
 * it cannot reach, whose provider throws on any use.
 */

import "../src/domain/models/models.ts";
import { AsyncResource } from "node:async_hooks";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { resolveDatastoreForRepo } from "../src/cli/repo_context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import {
  SERVE_UPSTREAM_DIVERGED_CODE,
  ServeUpstreamDivergedError,
} from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import { v3ReplicatesAt } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { datastoreRecords } from "./usecase_v3_fixtures.ts";
import { captureLogs } from "./remote_secrets_baseline_harness.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";
import {
  type Client,
  dataOf,
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

const NO_SERVE: Record<string, string | undefined> = {};

type DefinitionId = Parameters<
  RepositoryContext["definitionRepo"]["delete"]
>[1];

/** The ids the parity script writes under, fixed so two runs agree. */
const API_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01" as DefinitionId;
const GONE_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a02" as DefinitionId;
const VPC_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a03";
const DB_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a04";

/**
 * Runs `fn` outside the root unit of work current where this was called:
 * another client's command never runs inside this one's root.
 */
function outsideRoot(): <T>(fn: () => Promise<T>) => Promise<T> {
  return AsyncResource.bind(
    <T>(fn: () => Promise<T>): Promise<T> => fn(),
  ) as <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The parity script: definition creates and a delete, two data saves of
 * one name, a save and a delete of another. Each step is its own command.
 */
async function runScript(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  type: ModelType,
  modelId: string,
): Promise<void> {
  const write = (fn: (repos: RepositoryContext) => Promise<unknown>) =>
    writeCommand(scratch, client, env, fn);
  await write((repos) =>
    repos.definitionRepo.save(
      type,
      Definition.create({ id: API_ID, name: "api", globalArguments: {} }),
    )
  );
  await write((repos) =>
    repos.definitionRepo.save(
      type,
      Definition.create({ id: GONE_ID, name: "gone", globalArguments: {} }),
    )
  );
  await write((repos) =>
    repos.unifiedDataRepo.save(type, modelId, dataOf("vpc", VPC_ID), json(1))
  );
  await write((repos) =>
    repos.unifiedDataRepo.save(type, modelId, dataOf("vpc", VPC_ID), json(2))
  );
  await write((repos) =>
    repos.unifiedDataRepo.save(type, modelId, dataOf("db", DB_ID), json("db"))
  );
  await write((repos) => repos.unifiedDataRepo.delete(type, modelId, "db"));
  await write((repos) => repos.definitionRepo.delete(type, GONE_ID));
}

/** What the parity script's records read back as in `client`. */
async function readBack(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  type: ModelType,
  modelId: string,
): Promise<Record<string, unknown>> {
  return await readCommand(scratch, client, env, async (repos) => ({
    api: (await repos.definitionRepo.findById(type, API_ID))?.name ?? null,
    gone: (await repos.definitionRepo.findById(type, GONE_ID))?.name ?? null,
    vpc: await latestOf(repos, type, modelId, "vpc"),
    db: await latestOf(repos, type, modelId, "db"),
    names: (await repos.unifiedDataRepo.findAllForModel(type, modelId))
      .map((data) => `${data.name}@${data.version}`).sort(),
  }));
}

/**
 * The data records a checkout holds (`data/...`), by path, with their
 * content; the save time a metadata file records is left out, since two
 * runs save at different times.
 */
async function dataRecords(repoDir: string): Promise<Map<string, string>> {
  const records = new Map<string, string>();
  for (const path of (await datastoreRecords(repoDir)).keys()) {
    if (!path.startsWith("data/")) continue;
    const text = await Deno.readTextFile(join(swampPath(repoDir), path));
    records.set(path, text.replace(/^createdAt: .*$/m, "createdAt: <saved>"));
  }
  return records;
}

/** Asserts nothing about a serve-mode client reached the datastore's storage. */
async function assertStorageUntouched(
  serve: Serve,
  client: Client,
  touched: readonly string[],
): Promise<void> {
  // The bucket's provider was only constructed to name its paths: no lock,
  // lease, storage, control plane, sync or verifier.
  assertEquals(touched, [], "the client used the bucket's provider");
  for (const dir of [".unreachable-store", ".unreachable-cache"]) {
    assert(
      !(await exists(join(client.repoDir, dir))),
      `the bucket's ${dir} was created`,
    );
  }
  // Its local root is no replicated copy: no Litestream.
  const root = serveUpstreamLocalRoot(client.repoDir, serve.origin, "");
  assert(await exists(join(root, "commits.db")), "the follower copy exists");
  assertEquals(v3ReplicatesAt(root), false, "the serve root replicates");
}

Deno.test({
  name:
    "serve upstream: a client's writes land at serve stamped with its principal, read back as a solo checkout's do, and never reach the storage",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ managedConfig: true });
      const bucket = scratch.bucket();
      const client = await scratch.client("a", {
        bucket,
        managedConfig: true,
      });
      const env = serveEnv(serve, "alice-token");
      const web = serve.models.web;
      const before = await serve.log();
      await runScript(scratch, client, env, serve.modelType, web);

      // Serve's log holds the client's seven commits, each stamped with the
      // caller's principal.
      const added = (await serve.log()).slice(before.length);
      assertEquals(added.length, 7, JSON.stringify(added, null, 2));
      for (const entry of added) {
        assertEquals(entry.principal, "user:caller", entry.partition);
      }
      const keys = added.flatMap((entry) => entry.keys);
      for (
        const suffix of [
          "/api.yaml",
          "/gone.yaml",
          `${web}/vpc/1/raw`,
          `${web}/vpc/2/raw`,
          `${web}/db/1/raw`,
        ]
      ) {
        assert(
          keys.some((key) => key.endsWith(suffix)),
          `no commit names ${suffix}: ${keys}`,
        );
      }

      // A solo checkout running the same script reads back the same.
      const solo = await scratch.client("solo", {
        solo: true,
        managedConfig: true,
      });
      await runScript(scratch, solo, NO_SERVE, serve.modelType, web);
      const expected = await readBack(
        scratch,
        solo,
        NO_SERVE,
        serve.modelType,
        web,
      );
      assertEquals(expected, {
        api: "api",
        gone: null,
        vpc: { version: 2, content: "2" },
        db: null,
        names: ["vpc@2"],
      });
      assertEquals(
        await readBack(scratch, client, env, serve.modelType, web),
        expected,
      );
      const records = await dataRecords(client.repoDir);
      assert(records.size > 0, "the client holds no data records");
      assertEquals(records, await dataRecords(solo.repoDir));

      await assertStorageUntouched(serve, client, bucket.touched());
    });
  },
});

Deno.test({
  name:
    "serve upstream: a second checkout reads the first's writes after catch-up, and the first reads the second's",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ managedConfig: true });
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket, managedConfig: true });
      const b = await scratch.client("b", { bucket, managedConfig: true });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;

      await writeCommand(scratch, a, env, async (repos) => {
        await repos.definitionRepo.save(
          type,
          Definition.create({ id: API_ID, name: "api", globalArguments: {} }),
        );
        await repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json("a"));
      });
      assertEquals(
        await readCommand(scratch, b, env, async (repos) => ({
          api: (await repos.definitionRepo.findByName(type, "api"))?.id,
          vpc: await latestOf(repos, type, web, "vpc"),
        })),
        { api: API_ID, vpc: { version: 1, content: '"a"' } },
      );

      await writeCommand(
        scratch,
        b,
        env,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json("b")),
      );
      assertEquals(
        await readCommand(
          scratch,
          a,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 2, content: '"b"' },
      );
      await assertStorageUntouched(serve, a, bucket.touched());
      await assertStorageUntouched(serve, b, bucket.touched());
    });
  },
});

Deno.test({
  name:
    "serve upstream: a serve-mode client never creates or locks its filesystem datastore's path",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const client = await scratch.client("a");
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;
      await writeCommand(
        scratch,
        client,
        env,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("vpc"), json(1)),
      );
      assertEquals(
        await readCommand(
          scratch,
          client,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 1, content: "1" },
      );
      assert(
        !(await exists(client.storagePath)),
        "the serve-mode client created its datastore's storage path",
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream: a write built on a head another client moved lands after catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket });
      const b = await scratch.client("b", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;

      // B's commit lands just as A's reaches serve: after A's last read, so
      // A's is built on the head before it and serve answers stale_seq.
      const outside = outsideRoot();
      let landedB = false;
      const proxy = startProxy(serve.origin, async (request) => {
        if (
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/commits") && !landedB
        ) {
          landedB = true;
          await outside(() =>
            writeInOpenCommand(
              scratch,
              b,
              env,
              (repos) =>
                repos.unifiedDataRepo.save(
                  type,
                  web,
                  dataOf("from-b"),
                  json("b"),
                ),
            )
          );
        }
        return undefined;
      });
      const envA = serveEnv(proxy, "alice-token");
      try {
        await writeCommand(
          scratch,
          a,
          envA,
          (repos) =>
            repos.unifiedDataRepo.save(type, web, dataOf("from-a"), json("a")),
        );
        // A's copy holds both.
        assertEquals(
          await readCommand(scratch, a, envA, async (repos) => [
            await latestOf(repos, type, web, "from-a"),
            await latestOf(repos, type, web, "from-b"),
          ]),
          [{ version: 1, content: '"a"' }, { version: 1, content: '"b"' }],
        );
      } finally {
        await proxy.close();
      }

      assert(landedB, "A's commit never reached serve");
      assertEquals(
        proxy.requests.filter((request) =>
          request.method === "POST" && request.path.endsWith("/commits")
        ).length,
        2,
        "A's commit was not sent again after serve's stale_seq",
      );
      const partition = (await serve.log()).filter((entry) =>
        entry.keys.some((key) => key.includes(`/${web}/`))
      );
      assertEquals(
        partition.map((entry) => ({
          seq: entry.seq,
          fromA: entry.keys.some((key) => key.includes("/from-a/")),
        })),
        [{ seq: 1, fromA: false }, { seq: 2, fromA: true }],
        "A's commit landed after B's, on the head B moved",
      );
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "serve upstream: commits a client may not read leave gaps it catches up past and writes after",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = [
      ...MEMBER,
      {
        user: "bob",
        actions: ["read", "write", "run"],
        kind: "model",
        pattern: "bobs",
      },
      { user: "bob", actions: ["read"], kind: "data", pattern: "bobs" },
    ];
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants, models: ["bobs"] });
      const bucket = scratch.bucket();
      const alice = await scratch.client("alice", { bucket });
      const bob = await scratch.client("bob", { bucket });
      const aliceEnv = serveEnv(serve, "alice-token");
      const bobEnv = serveEnv(serve, "bob-token");
      const type = serve.modelType;
      const { web, bobs } = serve.models;

      for (const round of [1, 2]) {
        await writeCommand(
          scratch,
          alice,
          aliceEnv,
          (repos) =>
            repos.unifiedDataRepo.save(
              type,
              web,
              dataOf("secret"),
              json(round),
            ),
        );
        await writeCommand(
          scratch,
          bob,
          bobEnv,
          (repos) =>
            repos.unifiedDataRepo.save(type, bobs, dataOf("mine"), json(round)),
        );
      }

      assertEquals(
        await readCommand(scratch, bob, bobEnv, async (repos) => ({
          mine: await latestOf(repos, type, bobs, "mine"),
          secret: await latestOf(repos, type, web, "secret"),
        })),
        { mine: { version: 2, content: "2" }, secret: null },
      );
      assertEquals(
        (await serve.log()).filter((entry) => entry.principal === "user:bob")
          .length,
        2,
      );
      // Alice, who may read both, sees Bob's writes too.
      assertEquals(
        await readCommand(
          scratch,
          alice,
          aliceEnv,
          (repos) => latestOf(repos, type, bobs, "mine"),
        ),
        { version: 2, content: "2" },
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream: a checkout switched to another token reads exactly what a fresh checkout with that token reads, and all again when switched back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Alice may read everything; Bob only behavior `bobs` and its data.
    const grants = [
      ...MEMBER,
      { user: "bob", actions: ["read"], kind: "model", pattern: "bobs" },
      { user: "bob", actions: ["read"], kind: "data", pattern: "bobs" },
    ];
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants, models: ["bobs"] });
      const bucket = scratch.bucket();
      const shared = await scratch.client("shared", { bucket });
      const aliceEnv = serveEnv(serve, "alice-token");
      const bobEnv = serveEnv(serve, "bob-token");
      const type = serve.modelType;
      const { web, bobs } = serve.models;
      const read = (client: Client, env: Record<string, string | undefined>) =>
        readCommand(scratch, client, env, async (repos) => ({
          secret: await latestOf(repos, type, web, "secret"),
          open: await latestOf(repos, type, bobs, "open"),
        }));

      // Alice writes a record only she may read and one Bob may read too.
      await writeCommand(scratch, shared, aliceEnv, async (repos) => {
        await repos.unifiedDataRepo.save(type, web, dataOf("secret"), json(1));
        await repos.unifiedDataRepo.save(type, bobs, dataOf("open"), json(1));
      });
      assertEquals(await read(shared, aliceEnv), {
        secret: { version: 1, content: "1" },
        open: { version: 1, content: "1" },
      });

      // The same checkout with Bob's token reads what a fresh checkout of
      // Bob's does: none of Alice's records, file for file.
      const freshBob = await scratch.client("fresh-bob", { bucket });
      const bobView = {
        secret: null,
        open: { version: 1, content: "1" },
      };
      assertEquals(await read(freshBob, bobEnv), bobView);
      assertEquals(await read(shared, bobEnv), bobView);
      assertEquals(
        await datastoreRecords(shared.repoDir),
        await datastoreRecords(freshBob.repoDir),
      );
      assert(
        ![...(await datastoreRecords(shared.repoDir)).keys()].some((path) =>
          path.includes(web)
        ),
        "a file of Alice's behavior is still in the checkout",
      );

      // Nothing is stale: a later write Bob may read reaches the checkout.
      const alice = await scratch.client("alice", { bucket });
      await writeCommand(
        scratch,
        alice,
        aliceEnv,
        (repos) =>
          repos.unifiedDataRepo.save(type, bobs, dataOf("open"), json(2)),
      );
      assertEquals(await read(shared, bobEnv), {
        secret: null,
        open: { version: 2, content: "2" },
      });
      await read(freshBob, bobEnv);
      assertEquals(
        await datastoreRecords(shared.repoDir),
        await datastoreRecords(freshBob.repoDir),
      );

      // Switched back to Alice's token, it reads everything again.
      const aliceView = {
        secret: { version: 1, content: "1" },
        open: { version: 2, content: "2" },
      };
      assertEquals(await read(shared, aliceEnv), aliceView);
      assertEquals(await read(alice, aliceEnv), aliceView);
      assertEquals(
        await datastoreRecords(shared.repoDir),
        await datastoreRecords(alice.repoDir),
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream: a checkout moved to another serve reads exactly what a fresh checkout of that serve reads, and the first again when moved back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serveA = await scratch.serve();
      const serveB = await scratch.serve();
      const bucket = scratch.bucket();
      const moved = await scratch.client("moved", { bucket });
      const envA = serveEnv(serveA, "alice-token");
      const envB = serveEnv(serveB, "alice-token");
      const read = (client: Client, env: Record<string, string | undefined>) =>
        readCommand(scratch, client, env, async (repos) => ({
          a: await latestOf(repos, serveA.modelType, serveA.models.web, "a"),
          b: await latestOf(repos, serveB.modelType, serveB.models.web, "b"),
        }));

      await writeCommand(
        scratch,
        moved,
        envA,
        (repos) =>
          repos.unifiedDataRepo.save(
            serveA.modelType,
            serveA.models.web,
            dataOf("a"),
            json(1),
          ),
      );
      const freshB = await scratch.client("fresh-b", { bucket });
      await writeCommand(
        scratch,
        freshB,
        envB,
        (repos) =>
          repos.unifiedDataRepo.save(
            serveB.modelType,
            serveB.models.web,
            dataOf("b"),
            json(1),
          ),
      );

      // Moved to serve B, it reads B's datastore only, file for file.
      const bView = { a: null, b: { version: 1, content: "1" } };
      assertEquals(await read(moved, envB), bView);
      assertEquals(await read(freshB, envB), bView);
      assertEquals(
        await datastoreRecords(moved.repoDir),
        await datastoreRecords(freshB.repoDir),
      );

      // Nothing is stale: B's next write reaches it.
      await writeCommand(
        scratch,
        freshB,
        envB,
        (repos) =>
          repos.unifiedDataRepo.save(
            serveB.modelType,
            serveB.models.web,
            dataOf("b"),
            json(2),
          ),
      );
      assertEquals(await read(moved, envB), {
        a: null,
        b: { version: 2, content: "2" },
      });

      // Moved back to A, whose copy it still holds, it reads A's only.
      const freshA = await scratch.client("fresh-a", { bucket });
      const aView = { a: { version: 1, content: "1" }, b: null };
      assertEquals(await read(moved, envA), aView);
      assertEquals(await read(freshA, envA), aView);
      assertEquals(
        await datastoreRecords(moved.repoDir),
        await datastoreRecords(freshA.repoDir),
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream: a checkout switched between its solo datastore and serve reads exactly what a fresh checkout of each reads",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const type = serve.modelType;
      const web = serve.models.web;
      const env = serveEnv(serve, "alice-token");
      const switched = await scratch.client("switched", { solo: true });
      // A second solo checkout of the same filesystem datastore.
      const freshSolo = await scratch.client("fresh-solo");
      const marker = join(freshSolo.repoDir, ".swamp.yaml");
      await Deno.writeTextFile(
        marker,
        (await Deno.readTextFile(marker)).replace(
          JSON.stringify(freshSolo.storagePath),
          JSON.stringify(switched.storagePath),
        ),
      );
      const freshServe = await scratch.client("fresh-serve");
      const read = (client: Client, e: Record<string, string | undefined>) =>
        readCommand(scratch, client, e, async (repos) => ({
          solo: await latestOf(repos, type, web, "solo"),
          served: await latestOf(repos, type, web, "served"),
        }));
      const save = (
        client: Client,
        e: Record<string, string | undefined>,
        name: string,
        value: number,
      ) =>
        writeCommand(
          scratch,
          client,
          e,
          (repos) =>
            repos.unifiedDataRepo.save(type, web, dataOf(name), json(value)),
        );

      await save(switched, NO_SERVE, "solo", 1);
      await save(freshServe, env, "served", 1);

      // Solo → serve: serve's records only.
      const serveView = { solo: null, served: { version: 1, content: "1" } };
      assertEquals(await read(switched, env), serveView);
      assertEquals(await read(freshServe, env), serveView);
      assertEquals(
        await datastoreRecords(switched.repoDir),
        await datastoreRecords(freshServe.repoDir),
      );

      // Serve → solo: the solo datastore's records only, with a write made
      // there meanwhile.
      await save(freshSolo, NO_SERVE, "solo", 2);
      const soloView = { solo: { version: 2, content: "2" }, served: null };
      assertEquals(await read(switched, NO_SERVE), soloView);
      assertEquals(await read(freshSolo, NO_SERVE), soloView);
      assertEquals(
        await datastoreRecords(switched.repoDir),
        await datastoreRecords(freshSolo.repoDir),
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream: serve, worker and the storage commands never take serve as their upstream",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const client = await scratch.client("a", { solo: true });
      const env = serveEnv({ origin: "http://127.0.0.1:9" }, "alice-token");
      const upstreamOf = (path: readonly string[]) =>
        withClientEnv(
          scratch,
          env,
          path,
          async () =>
            (await resolveDatastoreForRepo(client.repoDir)).serveUpstream
              ?.serverUrl,
        );
      assertEquals(await upstreamOf(["serve"]), undefined);
      assertEquals(await upstreamOf(["worker", "start"]), undefined);
      assertEquals(await upstreamOf(["datastore", "sync"]), undefined);
      assertEquals(await upstreamOf(["repo", "upgrade"]), undefined);
      assertEquals(await upstreamOf([]), undefined);
      assertEquals(await upstreamOf(["data", "get"]), "http://127.0.0.1:9");
      assertEquals(
        await upstreamOf(["datastore", "type", "search"]),
        "http://127.0.0.1:9",
      );

      // A serve-mode command says, at debug, that it runs here with serve
      // as the upstream; an excluded one says nothing.
      const said = async (path: readonly string[]) =>
        (await captureLogs(async () => {
          await upstreamOf(path);
        })).some((log) =>
          log.level === "debug" &&
          log.text.includes("Running locally with serve at") &&
          log.text.includes("http://127.0.0.1:9")
        );
      assertEquals(await said(["data", "get"]), true);
      assertEquals(await said(["serve"]), false);
    });
  },
});

Deno.test({
  name:
    "serve upstream: a member with only run and read on one behavior, and no admin, runs it through serve; another behavior is refused (swamp-club#3922)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants: GrantSpec[] = [
      { actions: ["run", "read"], kind: "model", pattern: "web" },
      { actions: ["read"], kind: "data", pattern: "web" },
    ];
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants, models: ["other"] });
      const client = await scratch.client("member");
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const { web, other } = serve.models;

      // A method run's data under the behavior's lock, as `model method run`
      // saves it: lands at serve, stamped with the member.
      await writeCommand(
        scratch,
        client,
        env,
        (repos) =>
          repos.unifiedDataRepo.save(type, web, dataOf("result"), json(1)),
      );
      const landed = (await serve.log()).filter((entry) =>
        entry.partition.includes(web)
      );
      assert(landed.length > 0, "the member's run did not reach serve");
      for (const entry of landed) {
        assertEquals(entry.principal, "user:caller", entry.partition);
      }
      assertEquals(
        await readCommand(
          scratch,
          client,
          env,
          (repos) => latestOf(repos, type, web, "result"),
        ),
        { version: 1, content: "1" },
      );

      // The same member on a behavior it holds no grant on: serve refuses.
      let refused: unknown;
      try {
        await writeCommand(
          scratch,
          client,
          env,
          (repos) =>
            repos.unifiedDataRepo.save(type, other, dataOf("result"), json(1)),
        );
      } catch (error) {
        refused = error;
      }
      assert(refused !== undefined, "a write to an ungranted behavior landed");
      assertEquals(
        (await serve.log()).some((entry) => entry.partition.includes(other)),
        false,
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream: an address that moves to another serve's datastore is refused on the first read and the first write, with nothing mixed into the copy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serveA = await scratch.serve();
      const serveB = await scratch.serve();
      const bucket = scratch.bucket();
      const client = await scratch.client("client", { bucket });
      let target = serveA.origin;
      const proxy = startProxy(() => target);
      const env = serveEnv(proxy, "alice-token");
      const read = () =>
        readCommand(scratch, client, env, async (repos) => ({
          vpc: await latestOf(
            repos,
            serveA.modelType,
            serveA.models.web,
            "vpc",
          ),
          db: await latestOf(repos, serveB.modelType, serveB.models.web, "db"),
        }));
      const aView = { vpc: { version: 3, content: "3" }, db: null };
      try {
        // Behind the address, serve A takes three saves of vpc.
        for (let version = 1; version <= 3; version++) {
          await writeCommand(
            scratch,
            client,
            env,
            (repos) =>
              repos.unifiedDataRepo.save(
                serveA.modelType,
                serveA.models.web,
                dataOf("vpc", VPC_ID),
                json(version),
              ),
          );
        }
        assertEquals(await read(), aView);

        // The address moves to serve B, with its own datastore, which takes
        // two saves of db.
        target = serveB.origin;
        const other = await scratch.client("other", { bucket });
        for (let version = 1; version <= 2; version++) {
          await writeCommand(
            scratch,
            other,
            env,
            (repos) =>
              repos.unifiedDataRepo.save(
                serveB.modelType,
                serveB.models.web,
                dataOf("db", DB_ID),
                json(version),
              ),
          );
        }
        const logB = (await serveB.log()).length;

        const readError = await assertRejects(
          read,
          ServeUpstreamDivergedError,
        );
        assertEquals(readError.code, SERVE_UPSTREAM_DIVERGED_CODE);
        assertEquals(readError.serveUrl, proxy.origin);
        assert(
          readError.message.includes(readError.copyDir),
          "the refusal names the copy",
        );
        const writeError = await assertRejects(
          () =>
            writeCommand(
              scratch,
              client,
              env,
              (repos) =>
                repos.unifiedDataRepo.save(
                  serveB.modelType,
                  serveB.models.web,
                  dataOf("db", DB_ID),
                  json(3),
                ),
            ),
          ServeUpstreamDivergedError,
        );
        assertEquals(writeError.code, SERVE_UPSTREAM_DIVERGED_CODE);
        assertEquals((await serveB.log()).length, logB, "B took the write");

        // Moved back to A, the copy holds A's log only.
        target = serveA.origin;
        assertEquals(await read(), aView);
      } finally {
        await proxy.close();
      }
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "serve upstream: a serve restored behind the copy's head in one partition is refused on a write, though the feed anchor still checks",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ models: ["other"] });
      const bucket = scratch.bucket();
      const client = await scratch.client("client", { bucket });
      const type = serve.modelType;
      const { web, other } = serve.models;
      // Serve answers web's partition as restored to its first commit:
      // reads end at head 1, and a commit past it is a stale seq.
      let restored = false;
      const isWeb = (request: Request) =>
        decodeURIComponent(new URL(request.url).pathname).includes(web);
      const proxy = startProxy(serve.origin, (request) => {
        if (!restored || !isWeb(request)) return Promise.resolve(undefined);
        if (request.method === "GET") {
          return Promise.resolve(Response.json({ head: 1, commits: [] }));
        }
        return Promise.resolve(
          Response.json({
            code: "stale_seq",
            seq: 1,
            message: "Partition head is 1",
          }, { status: 409 }),
        );
      });
      const env = serveEnv(proxy, "alice-token");
      const save = (modelId: string, version: number) =>
        writeCommand(
          scratch,
          client,
          env,
          (repos) =>
            repos.unifiedDataRepo.save(
              type,
              modelId,
              dataOf("vpc"),
              json(version),
            ),
        );
      try {
        await save(web, 1);
        await save(web, 2);
        // The last commit the feed carries, so the anchor, is other's.
        await save(other, 1);
        await readCommand(scratch, client, env, () => Promise.resolve());

        restored = true;
        const error = await assertRejects(
          () => save(web, 3),
          ServeUpstreamDivergedError,
        );
        assertEquals(error.code, SERVE_UPSTREAM_DIVERGED_CODE);
        assert(
          error.commit.partition.includes(web),
          `refused on ${error.commit.partition}, not web's partition`,
        );
        assertEquals(error.commit.seq, 2);
        assertEquals(error.divergence, { kind: "behind", serveHead: 1 });
        // The feed's anchor check read other's partition, and passed.
        assert(
          proxy.requests.some((request) =>
            request.method === "GET" &&
            decodeURIComponent(request.path).includes(other)
          ),
          "the feed anchor was not checked",
        );
      } finally {
        await proxy.close();
      }
      assertEquals(bucket.touched(), []);
    });
  },
});
