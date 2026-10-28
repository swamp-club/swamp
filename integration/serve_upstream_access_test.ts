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
 * A serve-mode checkout follows its member's read access (swamp-club#4089):
 * serve names it on every reply, and when it changes the next command
 * rebuilds the copy and the checkout's files from serve. Against a real
 * serve in a Worker, opened the production way; serve's grants change as a
 * reload of its access data changes them.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { configure, type LogRecord } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import {
  Definition,
  type DefinitionId,
} from "../src/domain/definitions/definition.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { SERVE_DATASTORE_ACCESS_HEADER } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import {
  SERVE_UPSTREAM_STATE_FILE,
  type ServeCopyAccess,
  ServeUpstreamState,
} from "../src/infrastructure/datastore_v3/serve_upstream_state.ts";
import { datastoreRecords } from "./usecase_v3_fixtures.ts";
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
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const VPC_ID = "4c1f0b6e-2d6a-4a9b-8f3e-1b2c3d4e5f60";
const KEY_ID = "4c1f0b6e-2d6a-4a9b-8f3e-1b2c3d4e5f61";
const API_ID = "4c1f0b6e-2d6a-4a9b-8f3e-1b2c3d4e5f62" as DefinitionId;

/** Alice is a member; bob may read behavior web and its data. */
const BOB_WEB: readonly GrantSpec[] = [
  ...MEMBER,
  { user: "bob", actions: ["read"], kind: "model", pattern: "web" },
  { user: "bob", actions: ["read"], kind: "data", pattern: "web" },
];

/** As {@link BOB_WEB}, and bob may read behavior secret and its data too. */
const BOB_BOTH: readonly GrantSpec[] = [
  ...BOB_WEB,
  { user: "bob", actions: ["read"], kind: "model", pattern: "secret" },
  { user: "bob", actions: ["read"], kind: "data", pattern: "secret" },
];

/** As {@link BOB_WEB}, and bob may save web's data. */
const BOB_WRITES_WEB: readonly GrantSpec[] = [
  ...BOB_WEB,
  { user: "bob", actions: ["run"], kind: "model", pattern: "web" },
  { user: "bob", actions: ["write"], kind: "data", pattern: "web" },
];

/** The id and read access of the copy `client` holds of `serve`. */
function copyState(
  client: Client,
  serve: Pick<Serve, "origin">,
): { copyId: string; access: ServeCopyAccess } {
  const state = ServeUpstreamState.open(
    join(
      serveUpstreamLocalRoot(client.repoDir, serve.origin, ""),
      SERVE_UPSTREAM_STATE_FILE,
    ),
  );
  try {
    return { copyId: state.copyId(), access: state.access() };
  } finally {
    state.close();
  }
}

/** The checkout files of `client` that belong to behavior `modelId`. */
async function filesOf(client: Client, modelId: string): Promise<string[]> {
  return [...(await datastoreRecords(client.repoDir)).keys()].filter((path) =>
    path.includes(modelId)
  );
}

/** Alice saves version 1 of vpc on web and of key on secret. */
async function seed(
  scratch: Scratch,
  serve: Serve,
  alice: Client,
): Promise<{ type: ModelType; web: string; secret: string }> {
  const env = serveEnv(serve, "alice-token");
  const type = serve.modelType;
  const { web, secret } = serve.models;
  await writeCommand(
    scratch,
    alice,
    env,
    (repos) =>
      repos.unifiedDataRepo.save(type, web, dataOf("vpc", VPC_ID), json(1)),
  );
  await writeCommand(
    scratch,
    alice,
    env,
    (repos) =>
      repos.unifiedDataRepo.save(type, secret, dataOf("key", KEY_ID), json(1)),
  );
  return { type, web, secret };
}

/** Runs `fn`, returning what it returns and the warnings serve mode logged. */
async function withWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["datastore", "v3", "serve"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    const result = await fn();
    return {
      result,
      warnings: records.map((record) => record.message.map(String).join("")),
    };
  } finally {
    await initializeLogging({ _reset: true });
  }
}

Deno.test({
  name:
    "serve access: a widened grant brings back the compacted records it now allows, on the command after the one that sees it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: BOB_WEB,
        models: ["secret"],
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket });
      const { type, web, secret } = await seed(scratch, serve, alice);
      await serve.compact();

      const bob = await scratch.client("b", { bucket });
      const bobEnv = serveEnv(serve, "bob-token");
      const read = () =>
        readCommand(scratch, bob, bobEnv, async (repos) => ({
          vpc: await latestOf(repos, type, web, "vpc"),
          key: await latestOf(repos, type, secret, "key"),
        }));
      assertEquals(await read(), {
        vpc: { version: 1, content: "1" },
        key: null,
      });
      const built = copyState(bob, serve);

      await serve.setGrants(BOB_BOTH);
      // The command that sees the change reads on as it is, and says so.
      const seen = await withWarnings(read);
      assertEquals(
        seen.result.key,
        null,
        "the base was loaded under the old grants",
      );
      assertEquals(seen.warnings.length, 1);
      assertStringIncludes(seen.warnings[0], "the next command rebuilds");
      assertEquals(copyState(bob, serve).copyId, built.copyId);

      // The next one rebuilds the copy and holds the record it now allows.
      assertEquals(await read(), {
        vpc: { version: 1, content: "1" },
        key: { version: 1, content: "1" },
      });
      const rebuilt = copyState(bob, serve);
      assert(rebuilt.copyId !== built.copyId, "the copy was rebuilt");
      assertEquals(rebuilt.access.built, rebuilt.access.seen);
      assert(rebuilt.access.built !== built.access.built);
      assert((await filesOf(bob, secret)).length > 0);
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "serve access: a narrowed grant removes the records and checkout files the member may no longer read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: BOB_BOTH,
        models: ["secret"],
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket });
      const { type, web, secret } = await seed(scratch, serve, alice);

      const bob = await scratch.client("b", { bucket });
      const bobEnv = serveEnv(serve, "bob-token");
      const read = () =>
        readCommand(scratch, bob, bobEnv, async (repos) => ({
          vpc: await latestOf(repos, type, web, "vpc"),
          key: await latestOf(repos, type, secret, "key"),
        }));
      assertEquals(await read(), {
        vpc: { version: 1, content: "1" },
        key: { version: 1, content: "1" },
      });
      assert((await filesOf(bob, secret)).length > 0);

      await serve.setGrants(BOB_WEB);
      await read();
      assertEquals(await read(), {
        vpc: { version: 1, content: "1" },
        key: null,
      });
      assertEquals(await filesOf(bob, secret), []);
      assert((await filesOf(bob, web)).length > 0);
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "serve access: a reload that changes only another member's grants keeps the copy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: BOB_WEB,
        models: ["secret"],
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket });
      const { type, web } = await seed(scratch, serve, alice);

      const bob = await scratch.client("b", { bucket });
      const bobEnv = serveEnv(serve, "bob-token");
      const read = () =>
        readCommand(
          scratch,
          bob,
          bobEnv,
          (repos) => latestOf(repos, type, web, "vpc"),
        );
      await read();
      const before = copyState(bob, serve);
      assert(before.access.built !== undefined, "serve named bob's access");

      await serve.setGrants([
        ...BOB_WEB,
        { user: "carol", actions: ["read"], kind: "data", pattern: "*" },
      ]);
      const after = await withWarnings(async () => {
        await read();
        return await read();
      });
      assertEquals(after.result, { version: 1, content: "1" });
      assertEquals(after.warnings, []);
      assertEquals(copyState(bob, serve), before);
    });
  },
});

Deno.test({
  name:
    "serve access: a change in the middle of a command warns once and the command finishes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: BOB_BOTH,
        models: ["secret"],
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket });
      const { type, web } = await seed(scratch, serve, alice);

      const bob = await scratch.client("b", { bucket });
      const bobEnv = serveEnv(serve, "bob-token");
      await readCommand(scratch, bob, bobEnv, () => Promise.resolve());
      const built = copyState(bob, serve);

      const { result, warnings } = await withWarnings(() =>
        writeCommand(scratch, bob, bobEnv, async (repos) => {
          const before = await latestOf(repos, type, web, "vpc");
          await serve.setGrants(BOB_WRITES_WEB);
          // Each save asks serve, which answers under the new access.
          for (const content of [2, 3]) {
            await repos.unifiedDataRepo.save(
              type,
              web,
              dataOf("vpc", VPC_ID),
              json(content),
            );
          }
          return before;
        })
      );
      assertEquals(result, { version: 1, content: "1" });
      assertEquals(
        warnings.filter((w) => w.includes("the next command rebuilds")).length,
        1,
      );
      const seen = copyState(bob, serve);
      assertEquals(seen.copyId, built.copyId, "not reset mid-command");
      assertEquals(seen.access.built, built.access.built);
      assert(seen.access.seen !== built.access.built);
    });
  },
});

Deno.test({
  name:
    "serve access: a serve that names no access leaves the copy as it was before access fingerprints",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: BOB_BOTH,
        models: ["secret"],
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket });
      const { type, secret } = await seed(scratch, serve, alice);
      // An older serve: its replies carry no access header.
      const proxy = startProxy(serve.origin, async (_request, forward) => {
        const response = await forward();
        const headers = new Headers(response.headers);
        headers.delete(SERVE_DATASTORE_ACCESS_HEADER);
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers,
        });
      });
      try {
        const bob = await scratch.client("b", { bucket });
        const bobEnv = serveEnv(proxy, "bob-token");
        const key = () =>
          readCommand(
            scratch,
            bob,
            bobEnv,
            (repos) => latestOf(repos, type, secret, "key"),
          );
        assertEquals(await key(), { version: 1, content: "1" });
        const before = copyState(bob, proxy);
        assertEquals(before.access, {});

        await serve.setGrants(BOB_WEB);
        const after = await withWarnings(async () => {
          await key();
          return await key();
        });
        // As before this change: the copy keeps what it read.
        assertEquals(after.result, { version: 1, content: "1" });
        assertEquals(after.warnings, []);
        assertEquals(copyState(bob, proxy), before);
        assert((await filesOf(bob, secret)).length > 0);
      } finally {
        await proxy.close();
      }
    });
  },
});

/** Holds the writer lease of `root` from a Worker until `release` is called. */
async function holdLease(root: string): Promise<{ release(): Promise<void> }> {
  const worker = new Worker(
    new URL("./serve_upstream_lease_holder_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const messages: string[] = [];
  worker.onmessage = (event: MessageEvent<string>) =>
    void messages.push(event.data);
  const reply = async (expected: string) => {
    await waitFor(
      () => messages.some((m) => m === expected || m.startsWith("failed")),
      `the lease holder to answer ${expected}`,
      { timeoutMs: 60_000 },
    );
    const failed = messages.find((m) => m.startsWith("failed"));
    if (failed !== undefined) {
      worker.terminate();
      throw new Error(failed);
    }
  };
  await reply("loaded");
  worker.postMessage({ kind: "hold", root });
  await reply("held");
  return {
    async release() {
      worker.postMessage("release");
      try {
        await reply("released");
      } finally {
        worker.terminate();
      }
    },
  };
}

Deno.test({
  name:
    "serve access: while another command of the checkout writes, a change of access waits for it instead of holding up or failing a read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: BOB_WEB,
        models: ["secret"],
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket });
      const { type, web, secret } = await seed(scratch, serve, alice);

      const bob = await scratch.client("b", { bucket });
      // Short, so a read that waited for the lease fails fast.
      const bobEnv = {
        ...serveEnv(serve, "bob-token"),
        SWAMP_LOCK_TIMEOUT_MS: "2000",
      };
      const read = () =>
        readCommand(scratch, bob, bobEnv, async (repos) => ({
          vpc: await latestOf(repos, type, web, "vpc"),
          key: await latestOf(repos, type, secret, "key"),
        }));
      await read();
      await serve.setGrants(BOB_BOTH);
      await read();
      const built = copyState(bob, serve);
      assert(built.access.seen !== built.access.built, "the change was seen");

      const holder = await holdLease(
        serveUpstreamLocalRoot(bob.repoDir, serve.origin, ""),
      );
      let waited: Awaited<ReturnType<typeof withWarnings<unknown>>>;
      try {
        waited = await withWarnings(read);
      } finally {
        await holder.release();
      }
      assertEquals(waited.result, {
        vpc: { version: 1, content: "1" },
        key: null,
      });
      assertEquals(
        waited.warnings.filter((w) => w.includes("another command")).length,
        1,
      );
      assertEquals(copyState(bob, serve).copyId, built.copyId);

      // Once it has finished, the next command rebuilds the copy.
      assertEquals(await read(), {
        vpc: { version: 1, content: "1" },
        key: { version: 1, content: "1" },
      });
      assert(copyState(bob, serve).copyId !== built.copyId);
    });
  },
});

Deno.test({
  name:
    "serve access: a restart that restricts a behavior type removes its definitions from a member's copy, whose grants did not change",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: [
          ...BOB_WEB,
          { user: "bob", actions: ["read"], kind: "model", pattern: "api" },
        ],
        managedConfig: true,
      });
      const bucket = scratch.bucket();
      const alice = await scratch.client("a", { bucket, managedConfig: true });
      const type = serve.modelType;
      await writeCommand(
        scratch,
        alice,
        serveEnv(serve, "alice-token"),
        (repos) =>
          repos.definitionRepo.save(
            type,
            Definition.create({ id: API_ID, name: "api", globalArguments: {} }),
          ),
      );
      await serve.compact();

      const bob = await scratch.client("b", { bucket, managedConfig: true });
      const bobEnv = serveEnv(serve, "bob-token");
      // Only an admin may read the definitions of a restricted type.
      const api = () =>
        readCommand(
          scratch,
          bob,
          bobEnv,
          async (repos) =>
            (await repos.definitionRepo.findById(type, API_ID))?.name ?? null,
        );
      assertEquals(await api(), "api");
      const built = copyState(bob, serve);

      // Bob's grants are unchanged: only serve's restricted list moves.
      await serve.restrict([type.normalized]);
      await api();
      assertEquals(await api(), null);
      assert(copyState(bob, serve).copyId !== built.copyId);
    });
  },
});
