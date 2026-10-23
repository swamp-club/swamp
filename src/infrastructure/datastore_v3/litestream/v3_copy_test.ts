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

import { ReplicaRoot } from "../../../domain/datastore_v3/replica_root.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  V3ReplicaRootMismatchError,
  V3ReplicationError,
} from "../../../domain/datastore_v3/litestream_replication.ts";
import { replicaPathFor } from "../../../domain/datastore_v3/replication_lineage.ts";
import { currentLineage } from "../../../domain/datastore_v3/published_lineage.ts";
import { withMockedEnv } from "../../persistence/path_test_helpers.ts";
import {
  replicaRootOf,
  V3_REPLICA_ENV,
  type V3ReplicaSetting,
} from "./replica_setting.ts";
import type { ReplicaPathStore } from "../../../domain/datastore/replica_path_store.ts";
import {
  ensureSharedDir,
  readCopyState,
  readLineage,
  replicationPathsFor,
  writeLineage,
} from "./replication_files.ts";
import { BlobRef } from "../../../domain/datastore_v3/blob_ref.ts";
import {
  blobPut,
  modelCommit,
} from "../../../domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../sqlite_commit_store.ts";
import {
  collectV3Lineages,
  lineageRegistryFor,
  makeV3CopyCurrent,
  prepareV3WriterLineage,
  publishV3Head,
  recordV3LeaseFence,
  type V3Copy,
  V3LineageOutrankedError,
} from "./v3_copy.ts";

const AT = "2026-10-14T00:00:00.000Z";

/** Litestream replication needs a Unix user id: unavailable on Windows. */
const UNIX = Deno.build.os !== "windows";

interface Env {
  readonly copy: V3Copy;
  readonly replica: string;
  readonly root: string;
  readonly dir: string;
}

async function withCopy(
  fn: (env: Env) => Promise<void>,
  options: { readonly setting?: V3ReplicaSetting } = {},
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-copy-" }),
  );
  const replica = join(dir, "replica");
  const datastorePath = join(dir, "ds");
  await Deno.mkdir(datastorePath);
  const copy = {
    datastorePath,
    repoDir: join(dir, "repo"),
    commitsDb: join(dir, "repo", ".swamp", "copies", "commits.db"),
  };
  try {
    const setting = options.setting ??
      { type: "file" as const, path: replica };
    await withMockedEnv(
      { [V3_REPLICA_ENV]: JSON.stringify(setting) },
      () => fn({ copy, replica, root: replicaRootOf(setting).value, dir }),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function publish(
  env: Env,
  fence: number,
  options: { confirmed?: boolean; root?: string; follows?: number } = {},
): Promise<void> {
  const registry = lineageRegistryFor(env.copy.datastorePath);
  await registry.start({
    fence,
    holder: "test",
    replicaRoot: options.root ?? env.root,
    startedAt: AT,
    // A lineage this swamp began: it names what it follows.
    ...(options.follows !== undefined
      ? { follows: options.follows, chained: true as const }
      : {}),
  });
  if (options.confirmed === true) {
    await registry.publishHead({
      fence,
      txid: "0000000000000001",
      writerFence: fence,
      mark: { cursor: 0 },
      publishedAt: AT,
    });
    await registry.confirm({
      fence,
      txid: "0000000000000001",
      confirmedAt: AT,
    });
  }
}

async function lineageOf(env: Env) {
  return await readLineage(await pathsOf(env));
}

async function pathsOf(env: Env) {
  await Deno.mkdir(dirname(env.copy.commitsDb), { recursive: true });
  const paths = await replicationPathsFor(env.copy.commitsDb);
  await ensureSharedDir(paths);
  return paths;
}

/** The start record of the lineage at `fence`, if one parses. */
async function startOf(env: Env, fence: number) {
  const started = await lineageRegistryFor(env.copy.datastorePath).started(
    fence,
  );
  return typeof started === "object" ? started : undefined;
}

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false);
}

Deno.test({
  name:
    "prepareV3WriterLineage: a first writer claims a new lineage at its fence",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 3, { restored: false });
      assertEquals((await lineageOf(env))?.lineageFence, 3);
      const started = await startOf(env, 3);
      assertEquals(started?.replicaRoot, env.root);
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: continues its own published lineage at the next fence",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 3, { restored: false });
      await prepareV3WriterLineage(env.copy, 4, { restored: false });
      const lineage = await lineageOf(env);
      assertEquals([lineage?.lineageFence, lineage?.lastFence], [3, 4]);
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: restarts after a restore, or once another writer started a lineage",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 3, { restored: false });
      await prepareV3WriterLineage(env.copy, 4, { restored: true });
      assertEquals((await lineageOf(env))?.lineageFence, 4);
      await publish(env, 5);
      await prepareV3WriterLineage(env.copy, 6, { restored: false });
      const lineage = await lineageOf(env);
      assertEquals(lineage?.lineageFence, 6);
      assertEquals(lineage?.previousLineages.map((old) => old.fence), [3, 4]);
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: refuses a lineage another writer already claimed",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 7);
      await assertRejects(
        () => prepareV3WriterLineage(env.copy, 7, { restored: false }),
        V3ReplicationError,
        "already claimed",
      );
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: refuses to start a lineage below one a newer writer started (swamp-club#3565)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 4, { confirmed: true });
      for (const restored of [true, false]) {
        const error = await assertRejects(
          () => prepareV3WriterLineage(env.copy, 3, { restored }),
          V3ReplicationError,
          "was started by a newer writer than this one, at fence 3",
        );
        assert(error.cause instanceof V3LineageOutrankedError);
      }
      assertEquals(await startOf(env, 3), undefined, "nothing was started");
      // Another root's newer lineage is refused, never forked beside
      // (swamp-club#3801), and nothing is started.
      await publish(env, 9, { root: "file:/elsewhere" });
      for (const restored of [true, false]) {
        await assertRejects(
          () => prepareV3WriterLineage(env.copy, 5, { restored }),
          V3ReplicaRootMismatchError,
          "was started under replica root file:/elsewhere",
        );
      }
      assertEquals(await startOf(env, 5), undefined, "nothing was started");
      // Once a lineage of its own outranks it, it is history.
      await publish(env, 10);
      await prepareV3WriterLineage(env.copy, 11, { restored: true });
      assertEquals((await lineageOf(env))?.lineageFence, 11);
    });
  },
});

Deno.test({
  name: "recordV3LeaseFence: continues only a lineage nothing started after",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 3, { restored: false });
      await recordV3LeaseFence(env.copy, 4);
      assertEquals((await lineageOf(env))?.lastFence, 4);
      await publish(env, 5);
      await recordV3LeaseFence(env.copy, 6);
      const lineage = await lineageOf(env);
      assertEquals([lineage?.lineageFence, lineage?.lastFence], [3, 4]);
    });
  },
});

Deno.test({
  name:
    "collectV3Lineages: removes replaced lineages under the root, never another root's",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      for (const fence of [1, 2]) {
        await publish(env, fence, { confirmed: true });
        await Deno.mkdir(replicaPathFor(env.replica, fence), {
          recursive: true,
        });
      }
      // A lineage another replica root started, below the current one.
      await publish(env, 3, { confirmed: true, root: "file:/elsewhere" });
      await publish(env, 4, { confirmed: true });
      await Deno.mkdir(replicaPathFor(env.replica, 4), { recursive: true });
      // This copy's own record, abandoned lineages under both roots.
      await writeLineage(await pathsOf(env), {
        replicaRoot: env.root,
        lineageFence: 4,
        lastFence: 4,
        previousLineages: [
          { replicaRoot: env.root, fence: 2 },
          { replicaRoot: "file:/elsewhere", fence: 3 },
        ],
      });
      await collectV3Lineages(env.copy, 4);
      assertEquals(await exists(replicaPathFor(env.replica, 1)), false);
      assertEquals(await exists(replicaPathFor(env.replica, 2)), false);
      assertEquals(await exists(replicaPathFor(env.replica, 4)), true);
      assertEquals(await startOf(env, 1), undefined);
      assertEquals((await startOf(env, 3))?.replicaRoot, "file:/elsewhere");
      assertEquals((await startOf(env, 4))?.replicaRoot, env.root);
      assertEquals((await lineageOf(env))?.previousLineages, []);
    });
  },
});

Deno.test({
  name:
    "collectV3Lineages: leaves a symlinked lineage path and its records alone",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      const outside = join(env.dir, "outside");
      await Deno.mkdir(outside);
      await Deno.mkdir(join(env.replica, "_litestream"), { recursive: true });
      await Deno.symlink(outside, replicaPathFor(env.replica, 1), {
        type: "dir",
      });
      await publish(env, 1, { confirmed: true });
      await publish(env, 2, { confirmed: true });
      await collectV3Lineages(env.copy, 2);
      assertEquals(await exists(outside), true);
      assertEquals(
        (await startOf(env, 1))?.fence,
        1,
      );
    });
  },
});

Deno.test({
  name:
    "collectV3Lineages: does nothing unless the lineage is the current state",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await Deno.mkdir(replicaPathFor(env.replica, 1), { recursive: true });
      await publish(env, 2);
      await collectV3Lineages(env.copy, 2);
      assertEquals(await exists(replicaPathFor(env.replica, 1)), true);
    });
  },
});

Deno.test({
  name:
    "collectV3Lineages: leaves a lineage whose start does not parse, records included",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await Deno.mkdir(replicaPathFor(env.replica, 1), { recursive: true });
      // Its root cannot be told: it may be another replica's.
      await Deno.writeTextFile(
        join(
          env.copy.datastorePath,
          "_control",
          "lineage",
          "000000000001",
          "started.json",
        ),
        "{torn",
      );
      await publish(env, 2, { confirmed: true });
      await collectV3Lineages(env.copy, 2);
      assertEquals(await exists(replicaPathFor(env.replica, 1)), true);
      assertEquals(
        await lineageRegistryFor(env.copy.datastorePath).started(1),
        "unreadable",
      );
    });
  },
});

/** A bucket replica, as a provider's replica target would set it. */
const BUCKET_REPLICA: V3ReplicaSetting = {
  type: "s3",
  bucket: "bucket",
  path: "team/root",
};

/** A provider's replica paths that records every call. */
function recordingStore(
  options: {
    readonly listed?: string[];
    readonly failRemove?: ReadonlySet<string>;
    readonly failList?: boolean;
  } = {},
) {
  const removed: string[] = [];
  const store: ReplicaPathStore = {
    list: () =>
      options.failList === true
        ? Promise.reject(new Error("listing failed"))
        : Promise.resolve([...(options.listed ?? [])]),
    removePath: (fence) => {
      if (options.failRemove?.has(fence)) {
        return Promise.reject(new Error("removal failed"));
      }
      removed.push(fence);
      return Promise.resolve();
    },
  };
  return { store, removed };
}

Deno.test({
  name:
    "collectV3Lineages: a bucket replica removes replaced lineages through the provider's store, never another root's",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await publish(env, 2, { confirmed: true });
      await publish(env, 3, { confirmed: true, root: "file:/elsewhere" });
      await publish(env, 4, { confirmed: true });
      await writeLineage(await pathsOf(env), {
        replicaRoot: env.root,
        lineageFence: 4,
        lastFence: 4,
        previousLineages: [{ replicaRoot: env.root, fence: 2 }],
      });
      const { store, removed } = recordingStore();
      await collectV3Lineages(env.copy, 4, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(removed, ["000000000001", "000000000002"]);
      assertEquals(await startOf(env, 1), undefined);
      assertEquals(await startOf(env, 2), undefined);
      assertEquals((await startOf(env, 3))?.replicaRoot, "file:/elsewhere");
      assertEquals((await startOf(env, 4))?.replicaRoot, env.root);
      assertEquals((await lineageOf(env))?.previousLineages, []);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: a bucket path that cannot be removed keeps its records, and the others are collected",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      for (const fence of [1, 2, 3]) {
        await publish(env, fence, { confirmed: true });
      }
      const { store, removed } = recordingStore({
        failRemove: new Set(["000000000001"]),
      });
      await collectV3Lineages(env.copy, 3, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(removed, ["000000000002"]);
      assertEquals((await startOf(env, 1))?.fence, 1);
      assertEquals(await startOf(env, 2), undefined);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: a bucket replica without replica paths keeps every path and record",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await publish(env, 2, { confirmed: true });
      await collectV3Lineages(env.copy, 2);
      assertEquals((await startOf(env, 1))?.fence, 1);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: removes only unrecorded bucket paths below the current lineage, rebuilt from their fence",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 3, { confirmed: true, root: "file:/elsewhere" });
      await publish(env, 4, { confirmed: true });
      // A key the registry does not read still marks fence 2 as recorded.
      const stray = join(
        env.copy.datastorePath,
        "_control",
        "lineage",
        "000000000002",
      );
      await Deno.mkdir(stray, { recursive: true });
      await Deno.writeTextFile(join(stray, "stray.json"), "{}");
      const { store, removed } = recordingStore({
        listed: [
          "000000000001",
          "000000000002",
          "000000000003",
          "000000000004",
          "000000000005",
          "1",
          "junk",
          "000000000000",
          "000000000001-other",
          "../_blobs",
        ],
      });
      await collectV3Lineages(env.copy, 4, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(removed, ["000000000001"]);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: a failed listing of bucket paths is logged, and the records are still collected",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await publish(env, 2, { confirmed: true });
      const { store, removed } = recordingStore({ failList: true });
      await collectV3Lineages(env.copy, 2, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(removed, ["000000000001"]);
      assertEquals(await startOf(env, 1), undefined);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: a store bound to another replica root is never used, and every path and record is kept",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await publish(env, 2, { confirmed: true });
      const { store, removed } = recordingStore({ listed: ["000000000001"] });
      await collectV3Lineages(env.copy, 2, {
        replicaPaths: { root: "s3::other-bucket:team/root", store },
      });
      assertEquals(removed, []);
      assertEquals((await startOf(env, 1))?.fence, 1);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: a file replica removes its own paths and never calls the provider's store",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await Deno.mkdir(replicaPathFor(env.replica, 1), { recursive: true });
      await publish(env, 2, { confirmed: true });
      const { store, removed } = recordingStore({ listed: ["000000000001"] });
      await collectV3Lineages(env.copy, 2, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(await exists(replicaPathFor(env.replica, 1)), false);
      assertEquals(await startOf(env, 1), undefined);
      assertEquals(removed, []);
    });
  },
});

Deno.test({
  name:
    "publishV3Head: a fenced process's late head moves neither the lineage's head nor the copy back",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 5, { restored: false });
      const at = (writerFence: number, txid: string) =>
        publishV3Head(env.copy, {
          lineageFence: 5,
          writerFence,
          txid,
          mark: { cursor: Number.parseInt(txid, 16) },
        });
      assertEquals(await at(7, "0000000000000020"), true);
      assertEquals(await at(6, "0000000000000018"), false);
      const current = currentLineage(
        await lineageRegistryFor(env.copy.datastorePath).read(
          ReplicaRoot.of(env.root),
        ),
        ReplicaRoot.of(env.root),
      );
      assertEquals(current?.head?.writerFence, 7);
      assertEquals(
        (await readCopyState(await pathsOf(env)))?.txid,
        "0000000000000020",
      );
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: two decisions at one fence in one process both succeed (swamp-club#3491)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      // Serve's retake beside a writer's hold, both at the retaken fence.
      await Promise.all([
        prepareV3WriterLineage(env.copy, 3, { restored: true }),
        prepareV3WriterLineage(env.copy, 3, { restored: true }),
      ]);
      const lineage = await lineageOf(env);
      assertEquals([lineage?.lineageFence, lineage?.lastFence], [3, 3]);
      assertEquals((await startOf(env, 3))?.replicaRoot, env.root);
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: refuses a fence that went back to one this copy began a lineage at (swamp-club#3491)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 3, { restored: false });
      await prepareV3WriterLineage(env.copy, 4, { restored: false });
      await assertRejects(
        () => prepareV3WriterLineage(env.copy, 3, { restored: true }),
        V3ReplicationError,
        "went back to fence 3",
      );
      const lineage = await lineageOf(env);
      assertEquals([lineage?.lineageFence, lineage?.lastFence], [3, 4]);
    });
  },
});

Deno.test({
  name:
    "prepareV3WriterLineage: refuses its fence when another replica root claimed it (swamp-club#3491)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await writeLineage(await pathsOf(env), {
        replicaRoot: env.root,
        lineageFence: 7,
        lastFence: 7,
        previousLineages: [],
      });
      await publish(env, 7, { root: "file:/elsewhere" });
      await assertRejects(
        () => prepareV3WriterLineage(env.copy, 7, { restored: false }),
        V3ReplicationError,
        "under another replica root",
      );
    });
  },
});

Deno.test({
  name:
    "publishV3Head: a late head on an older lineage never moves copy.json back (swamp-club#3491)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await prepareV3WriterLineage(env.copy, 5, { restored: false });
      const at = (lineageFence: number, writerFence: number, txid: string) =>
        publishV3Head(env.copy, {
          lineageFence,
          writerFence,
          txid,
          mark: { cursor: Number.parseInt(txid, 16) },
        });
      await at(5, 5, "0000000000000004");
      // A fenced process of this checkout, still on lineage 3, publishes late.
      await publish(env, 3);
      await at(3, 3, "0000000000000009");
      const held = await readCopyState(await pathsOf(env));
      assertEquals([held?.lineageFence, held?.txid], [5, "0000000000000004"]);
    });
  },
});

/** A shared commits.db in the datastore, holding one commit. */
async function sharedWithOneCommit(env: Env): Promise<void> {
  const store = SqliteCommitStore.open(
    join(env.copy.datastorePath, "commits.db"),
  );
  try {
    await store.append(
      modelCommit(1, [
        await blobPut(
          "x",
          1,
          BlobRef.create({ sha256: "a".repeat(64), size: 1 }),
        ),
      ]),
    );
  } finally {
    await store.close();
  }
}

Deno.test({
  name:
    "makeV3CopyCurrent: a writer seeds a new copy from the shared commits.db only while no lineage was ever confirmed (swamp-club#3491)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await sharedWithOneCommit(env);
      // Confirmed under another replica root, with nothing under this one:
      // the shared commits are no longer the state, and that lineage would
      // decide it, so the copy is refused and nothing is seeded
      // (swamp-club#3801).
      await publish(env, 2, { confirmed: true, root: "file:/elsewhere" });
      await assertRejects(
        () => makeV3CopyCurrent(env.copy, { mode: "write", lockWaitMs: 1_000 }),
        V3ReplicaRootMismatchError,
      );
      assertEquals(await exists(env.copy.commitsDb), false);
      await lineageRegistryFor(env.copy.datastorePath).remove(2);
      const seeded = await makeV3CopyCurrent(env.copy, {
        mode: "write",
        lockWaitMs: 1_000,
      });
      assertEquals(seeded.restored?.lineageFence, undefined);
      const copy = SqliteCommitStore.open(env.copy.commitsDb);
      try {
        assertEquals((await copy.history()).storedCommits, 1);
      } finally {
        await copy.close();
      }
    });
  },
});

const S3_PROXIED: V3ReplicaSetting = {
  type: "s3",
  bucket: "bucket",
  path: "prefix",
  endpoint: "http://localhost:47441",
};

Deno.test({
  name:
    "prepareV3WriterLineage: a lineage another spelling of the S3 endpoint started is this replica's, never forked beside (swamp-club#3801)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      // The writer reached the bucket directly, this checkout through a
      // proxy: one replica.
      await publish(env, 9, {
        confirmed: true,
        root: "s3:http://localhost:47411/:bucket:prefix",
      });
      for (const restored of [true, false]) {
        const error = await assertRejects(
          () => prepareV3WriterLineage(env.copy, 5, { restored }),
          V3ReplicationError,
        );
        assert(error.cause instanceof V3LineageOutrankedError);
      }
      assertEquals(await startOf(env, 5), undefined, "nothing was started");
      // Above it, the lineage continues the one chain.
      await prepareV3WriterLineage(env.copy, 10, { restored: true });
      assertEquals(
        (await startOf(env, 10))?.replicaRoot,
        "s3:http://localhost:47441:bucket:prefix",
      );
    }, { setting: S3_PROXIED });
  },
});

Deno.test({
  name:
    "makeV3CopyCurrent: a reader is refused, never shown an empty datastore, when another bucket or path started the newest lineage (swamp-club#3801)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 3, {
        confirmed: true,
        root: "s3:http://localhost:47441:bucket:elsewhere",
      });
      for (const mode of ["read", "write"] as const) {
        await assertRejects(
          () => makeV3CopyCurrent(env.copy, { mode, lockWaitMs: 1_000 }),
          Error,
          "was started under replica root s3:http://localhost:47441:bucket:elsewhere",
        );
      }
      assertEquals(await exists(env.copy.commitsDb), false);
    }, { setting: S3_PROXIED });
  },
});

/** BUCKET_REPLICA's bucket and path, reached through a proxy. */
const PROXIED_BUCKET_ROOT = "s3:http://proxy:47441:bucket:team/root";

Deno.test({
  name:
    "prepareV3WriterLineage: a new lineage's start names the current lineage it continues (swamp-club#3801)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 3, { confirmed: true, root: PROXIED_BUCKET_ROOT });
      await prepareV3WriterLineage(env.copy, 5, { restored: true });
      assertEquals((await startOf(env, 5))?.follows, 3);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: lineages a fork before swamp-club#3801 left under two endpoint spellings are kept in every later collection (swamp-club#3801)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      // A swamp before the fix collected each side down to one lineage:
      // two spellings that never saw each other.
      await publish(env, 3, { confirmed: true });
      await publish(env, 4, { confirmed: true, root: PROXIED_BUCKET_ROOT });
      // The first lineage after the fix continued the highest of them.
      await publish(env, 6, { confirmed: true, follows: 4 });
      const first = recordingStore();
      await collectV3Lineages(env.copy, 6, {
        replicaPaths: { root: env.root, store: first.store },
      });
      assertEquals(first.removed, ["000000000004"], "6 continues 4, not 3");
      // A later lineage's first confirmation collects again.
      await publish(env, 8, { confirmed: true, follows: 6 });
      const second = recordingStore();
      await collectV3Lineages(env.copy, 8, {
        replicaPaths: { root: env.root, store: second.store },
      });
      assertEquals(second.removed, ["000000000006"]);
      assert(await startOf(env, 3) !== undefined, "3 is kept");
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: with one history, lineages of every endpoint spelling below the current one are collected (swamp-club#3801)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 1, { confirmed: true });
      await publish(env, 5, {
        confirmed: true,
        root: PROXIED_BUCKET_ROOT,
        follows: 1,
      });
      await publish(env, 6, { confirmed: true, follows: 5 });
      const { store, removed } = recordingStore();
      await collectV3Lineages(env.copy, 6, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(removed, ["000000000001", "000000000005"]);
      assertEquals(await startOf(env, 1), undefined);
      assertEquals(await startOf(env, 5), undefined);
    }, { setting: BUCKET_REPLICA });
  },
});

Deno.test({
  name:
    "collectV3Lineages: an upgraded checkout's lineage an older swamp superseded without seeing it is kept (swamp-club#3801)",
  ignore: !UNIX,
  async fn() {
    await withCopy(async (env) => {
      await publish(env, 3, { confirmed: true });
      // The upgraded checkout, through its proxy, continued 3.
      await publish(env, 5, {
        confirmed: true,
        root: PROXIED_BUCKET_ROOT,
        follows: 3,
      });
      // An older swamp, blind to 5, continued its own 3.
      await publish(env, 6, { confirmed: true });
      await publish(env, 7, { confirmed: true, follows: 6 });
      const { store, removed } = recordingStore();
      await collectV3Lineages(env.copy, 7, {
        replicaPaths: { root: env.root, store },
      });
      assertEquals(removed, ["000000000003", "000000000006"]);
      assert(await startOf(env, 5) !== undefined, "5 is kept");
    }, { setting: BUCKET_REPLICA });
  },
});
