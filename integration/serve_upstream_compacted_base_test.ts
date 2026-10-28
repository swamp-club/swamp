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
 * A serve-mode checkout of a datastore serve has compacted
 * (swamp-club#4006): a fresh copy, or one left behind the compaction point,
 * loads serve's compacted base, filtered to what its caller may read, and
 * reads on through the feed. Against a real serve in a Worker, opened the
 * production way.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import { OBSERVED_BASE_STAGING_PREFIX } from "../src/infrastructure/datastore_v3/serve_catch_up.ts";
import { ServeUpstreamDivergedError } from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
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
  serveEnv,
  startProxy,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const VPC_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a13";
const DB_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a14";
const KEY_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a15";

/** Alice is a member; bob may read behavior web and its data, nothing else. */
const SCOPED: readonly GrantSpec[] = [
  ...MEMBER,
  { user: "bob", actions: ["read"], kind: "model", pattern: "web" },
  { user: "bob", actions: ["read"], kind: "data", pattern: "web" },
];

/** Saves `count` versions of `name` on `modelId`, one command each. */
async function saveVersions(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  type: ModelType,
  modelId: string,
  name: string,
  id: string,
  from: number,
  to: number,
): Promise<void> {
  for (let i = from; i <= to; i++) {
    await writeCommand(
      scratch,
      client,
      env,
      (repos) =>
        repos.unifiedDataRepo.save(type, modelId, dataOf(name, id), json(i)),
    );
  }
}

/** The data records a checkout holds, by path, without their save time. */
async function dataRecords(repoDir: string): Promise<Map<string, string>> {
  const records = new Map<string, string>();
  for (const path of (await datastoreRecords(repoDir)).keys()) {
    if (!path.startsWith("data/")) continue;
    const text = await Deno.readTextFile(join(swampPath(repoDir), path));
    records.set(path, text.replace(/^createdAt: .*$/m, "createdAt: <saved>"));
  }
  return records;
}

/** The staging files a base load left in `dir`. */
function stagingFiles(dir: string): string[] {
  return [...Deno.readDirSync(dir)].map((entry) => entry.name).filter((name) =>
    name.startsWith(OBSERVED_BASE_STAGING_PREFIX)
  );
}

/** Rows of the follower copy's `commits.db` at `root`. */
function copyRows(root: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(root, "commits.db"), { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

Deno.test({
  name:
    "compacted base: a fresh checkout of a compacted datastore catches up, reads what a checkout that followed the feed reads, and writes the next version",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;
      await saveVersions(scratch, a, env, type, web, "vpc", VPC_ID, 1, 3);
      await saveVersions(scratch, a, env, type, web, "db", DB_ID, 1, 1);
      await writeCommand(
        scratch,
        a,
        env,
        (repos) => repos.unifiedDataRepo.delete(type, web, "db"),
      );
      const point = await serve.compact();
      assert(point > 0);

      const b = await scratch.client("b", { bucket });
      const read = (client: Client) =>
        readCommand(scratch, client, env, async (repos) => ({
          vpc: await latestOf(repos, type, web, "vpc"),
          db: await latestOf(repos, type, web, "db"),
          names: (await repos.unifiedDataRepo.findAllForModel(type, web))
            .map((data) => `${data.name}@${data.version}`).sort(),
        }));
      const expected = {
        vpc: { version: 3, content: "3" },
        db: null,
        names: ["vpc@3"],
      };
      assertEquals(await read(a), expected);
      assertEquals(await read(b), expected);
      assertEquals(await dataRecords(b.repoDir), await dataRecords(a.repoDir));

      const root = serveUpstreamLocalRoot(b.repoDir, serve.origin, "");
      assert(
        (copyRows(root, "SELECT point FROM compaction")[0].point as number) >=
          point,
        "the copy holds serve's base",
      );
      assertEquals(stagingFiles(root), []);

      // The copy carries serve's version marks: b's next save is version 4,
      // and serve takes it.
      await saveVersions(scratch, b, env, type, web, "vpc", VPC_ID, 4, 4);
      assertEquals(await read(a), {
        vpc: { version: 4, content: "4" },
        db: null,
        names: ["vpc@4"],
      });
      // The removed db's version is never handed out again.
      await saveVersions(scratch, b, env, type, web, "db", DB_ID, 2, 2);
      assertEquals((await read(a)).names, ["db@2", "vpc@4"]);
      assertEquals(bucket.touched(), []);
    });
  },
});

Deno.test({
  name:
    "compacted base: a copy left behind the compaction point catches up through the base, then the feed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket });
      const c = await scratch.client("c", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;
      await saveVersions(scratch, a, env, type, web, "vpc", VPC_ID, 1, 1);
      const latest = (client: Client) =>
        readCommand(
          scratch,
          client,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        );
      assertEquals(await latest(c), { version: 1, content: "1" });

      // c falls behind: serve compacts past its cursor, then takes more.
      await saveVersions(scratch, a, env, type, web, "vpc", VPC_ID, 2, 3);
      await serve.compact();
      await saveVersions(scratch, a, env, type, web, "vpc", VPC_ID, 4, 4);

      assertEquals(await latest(c), { version: 4, content: "4" });
      assertEquals(await dataRecords(c.repoDir), await dataRecords(a.repoDir));
      await saveVersions(scratch, c, env, type, web, "vpc", VPC_ID, 5, 5);
      assertEquals(await latest(a), { version: 5, content: "5" });
    });
  },
});

Deno.test({
  name:
    "compacted base: a member with scoped grants gets only what it may read, and never a compacted record of another behavior",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: SCOPED, models: ["secret"] });
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket });
      const aliceEnv = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const { web, secret } = serve.models;
      await saveVersions(scratch, a, aliceEnv, type, web, "vpc", VPC_ID, 1, 2);
      await saveVersions(
        scratch,
        a,
        aliceEnv,
        type,
        secret,
        "key",
        KEY_ID,
        1,
        1,
      );
      await serve.compact();

      const b = await scratch.client("b", { bucket });
      const bobEnv = serveEnv(serve, "bob-token");
      assertEquals(
        await readCommand(scratch, b, bobEnv, async (repos) => ({
          vpc: await latestOf(repos, type, web, "vpc"),
          key: await latestOf(repos, type, secret, "key"),
        })),
        { vpc: { version: 2, content: "2" }, key: null },
      );
      // Nothing of the secret behavior is in bob's copy, nor its files.
      const root = serveUpstreamLocalRoot(b.repoDir, serve.origin, "");
      const held = [
        ...copyRows(root, "SELECT partition FROM compacted_partitions"),
        ...copyRows(root, "SELECT partition FROM base_records"),
        ...copyRows(root, "SELECT partition FROM base_versions"),
        ...copyRows(root, "SELECT owner AS partition FROM base_files"),
      ].map((row) => String(row.partition));
      assert(held.some((partition) => partition.includes(web)));
      assertEquals(held.filter((partition) => partition.includes(secret)), []);
      const records = [...(await datastoreRecords(b.repoDir)).keys()];
      assertEquals(records.filter((path) => path.includes(secret)), []);
    });
  },
});

Deno.test({
  name:
    "compacted base: a load cut off part-way leaves the copy as it was, and the next command loads it whole",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket });
      const type = serve.modelType;
      const web = serve.models.web;
      await saveVersions(
        scratch,
        a,
        serveEnv(serve, "alice-token"),
        type,
        web,
        "vpc",
        VPC_ID,
        1,
        3,
      );
      await serve.compact();

      // The base comes one entry a page, and its second page fails once.
      let pages = 0;
      let failures = 1;
      const proxy = startProxy(serve.origin, async (request) => {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/base")) return undefined;
        if (++pages === 2 && failures-- > 0) {
          return Response.json({ code: "internal_error", message: "cut" }, {
            status: 500,
          });
        }
        url.searchParams.set("limit", "1");
        const response = await fetch(
          `${serve.origin}${url.pathname}${url.search}`,
          {
            headers: request.headers,
          },
        );
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      });
      try {
        const b = await scratch.client("b", { bucket });
        const env = serveEnv(proxy, "alice-token");
        const latest = () =>
          readCommand(
            scratch,
            b,
            env,
            (repos) => latestOf(repos, type, web, "vpc"),
          );
        await assertRejects(latest);
        const root = serveUpstreamLocalRoot(b.repoDir, proxy.origin, "");
        assertEquals(copyRows(root, "SELECT point FROM compaction"), [
          { point: 0 },
        ]);
        assertEquals(copyRows(root, "SELECT COUNT(*) AS n FROM base_records"), [
          { n: 0 },
        ]);
        assertEquals(stagingFiles(root), []);

        assertEquals(await latest(), { version: 3, content: "3" });
        assert(pages > 3, "the base was paged");
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "compacted base: after a base load, an address moved to another serve's datastore is still refused by its log id",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serveA = await scratch.serve();
      const serveB = await scratch.serve();
      const bucket = scratch.bucket();
      let target = serveA.origin;
      const proxy = startProxy(() => target);
      try {
        const env = serveEnv(proxy, "alice-token");
        const a = await scratch.client("a", { bucket });
        await saveVersions(
          scratch,
          a,
          env,
          serveA.modelType,
          serveA.models.web,
          "vpc",
          VPC_ID,
          1,
          2,
        );
        await serveA.compact();
        const b = await scratch.client("b", { bucket });
        const read = () =>
          readCommand(
            scratch,
            b,
            env,
            (repos) =>
              latestOf(repos, serveA.modelType, serveA.models.web, "vpc"),
          );
        assertEquals(await read(), { version: 2, content: "2" });

        target = serveB.origin;
        const error = await assertRejects(read, ServeUpstreamDivergedError);
        assertEquals(error.divergence.kind, "other-log");
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "compacted base: a datastore serve has claimed still loads into a serve-mode copy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      const web = serve.models.web;
      await saveVersions(scratch, a, env, type, web, "vpc", VPC_ID, 1, 2);
      await serve.compact({ claim: true });

      const b = await scratch.client("b", { bucket });
      assertEquals(
        await readCommand(
          scratch,
          b,
          env,
          (repos) => latestOf(repos, type, web, "vpc"),
        ),
        { version: 2, content: "2" },
      );
      await saveVersions(scratch, b, env, type, web, "vpc", VPC_ID, 3, 3);
      assertEquals(bucket.touched(), []);
    });
  },
});
