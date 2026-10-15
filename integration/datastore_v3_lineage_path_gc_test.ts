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
 * Lineage collection on a bucket replica through the provider's replica
 * paths (swamp-club#3531), in-process and dormant: the replica is set with
 * the internal setting, the in-memory remote stands in for the bucket, and
 * the objects Litestream would write are seeded there. Shows a takeover's
 * old lineage path and records removed after the new lineage's first
 * confirmation, and chunk collection no longer deferred; without the
 * capability, both kept and collection still deferred; and a file replica
 * as before.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "../packages/testing/in_memory_remote.ts";
import type { V3ReplicaPaths } from "../src/infrastructure/datastore_v3/litestream/replica_target_resolver.ts";
import { V3ChunkCollectionDeferredError } from "../src/domain/datastore_v3/litestream_replication.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  replicaRootOf,
  V3_REPLICA_ENV,
  type V3ReplicaSetting,
} from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  assertV3ChunksCollectable,
  collectV3Lineages,
  lineageRegistryFor,
  prepareV3WriterLineage,
  publishV3Head,
  type V3Copy,
} from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";

/** Replication needs a Unix user id: unavailable on Windows. */
const ignore = Deno.build.os === "windows";

const OLD = "_litestream/000000000001/";
const NEW = "_litestream/000000000002/";

/**
 * A copy whose writer replicated lineage 1, then took over from a restore
 * and confirmed lineage 2: the state at lineage 2's first confirmation,
 * built through the writer's own publish path.
 */
async function withTakeover(
  setting: (dir: string) => V3ReplicaSetting,
  fn: (copy: V3Copy, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-lineage-gc-" }),
  );
  const datastorePath = join(dir, "ds");
  await Deno.mkdir(datastorePath);
  const copy: V3Copy = {
    datastorePath,
    repoDir: join(dir, "repo"),
    commitsDb: join(dir, "repo", ".swamp", "copies", "commits.db"),
  };
  await Deno.mkdir(join(dir, "repo", ".swamp", "copies"), { recursive: true });
  try {
    await withMockedEnv(
      { [V3_REPLICA_ENV]: JSON.stringify(setting(dir)) },
      async () => {
        await prepareV3WriterLineage(copy, 1, { restored: false });
        assertEquals(
          await publishV3Head(copy, {
            lineageFence: 1,
            writerFence: 1,
            txid: "0000000000000001",
            mark: { cursor: 1 },
          }),
          true,
        );
        await prepareV3WriterLineage(copy, 2, { restored: true });
        assertEquals(
          await publishV3Head(copy, {
            lineageFence: 2,
            writerFence: 2,
            txid: "0000000000000002",
            mark: { cursor: 2 },
          }),
          true,
        );
        await fn(copy, dir);
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// The provider's store is already scoped to its replica target's prefix, so
// the in-memory remote's unprefixed `_litestream/` stands in for any path.
const bucket = (): V3ReplicaSetting => ({
  type: "s3",
  bucket: "b",
  path: "root",
});

/** The remote's replica paths, bound to the bucket replica's root. */
function bound(remote: InMemoryRemote): V3ReplicaPaths {
  return { root: replicaRootOf(bucket()), store: remote.replicaPaths!() };
}

function seededRemote() {
  const remote = createInMemoryRemote({ replicaPaths: true });
  for (const key of ["snapshot", "ltx/0/1", "ltx/0/2"]) {
    remote.putReplicaObject!(`${OLD}${key}`, new Uint8Array([1]));
    remote.putReplicaObject!(`${NEW}${key}`, new Uint8Array([2]));
  }
  return remote;
}

async function exists(
  remote: { objectExists(key: string): Promise<boolean> },
  key: string,
): Promise<boolean> {
  return await remote.objectExists(key);
}

async function assertDeferred(copy: V3Copy): Promise<void> {
  await assertRejects(
    () => assertV3ChunksCollectable(copy),
    V3ChunkCollectionDeferredError,
    "replication lineage 000000000001 may still be restored",
  );
}

Deno.test({
  name:
    "v3 lineage paths: a takeover's old bucket lineage path and records are removed, and chunk collection runs (swamp-club#3531)",
  ignore,
  async fn() {
    await withTakeover(bucket, async (copy) => {
      const remote = seededRemote();
      await assertDeferred(copy);
      await collectV3Lineages(copy, 2, { replicaPaths: bound(remote) });
      assertEquals(await exists(remote, `${OLD}snapshot`), false);
      assertEquals(await exists(remote, `${OLD}ltx/0/2`), false);
      assertEquals(await exists(remote, `${NEW}snapshot`), true);
      assertEquals(await exists(remote, `${NEW}ltx/0/2`), true);
      const registry = lineageRegistryFor(copy.datastorePath);
      assertEquals(await registry.started(1), undefined);
      assertEquals([...await registry.fences()], [2]);
      await assertV3ChunksCollectable(copy);
    });
  },
});

Deno.test({
  name:
    "v3 lineage paths: without replica paths a bucket keeps the old lineage, and chunk collection stays deferred",
  ignore,
  async fn() {
    await withTakeover(bucket, async (copy) => {
      const remote = seededRemote();
      await collectV3Lineages(copy, 2);
      assertEquals(await exists(remote, `${OLD}snapshot`), true);
      assertEquals(
        typeof await lineageRegistryFor(copy.datastorePath).started(1),
        "object",
      );
      await assertDeferred(copy);
    });
  },
});

Deno.test({
  name:
    "v3 lineage paths: a bucket path that cannot be removed keeps its records, and the next collection removes both",
  ignore,
  async fn() {
    await withTakeover(bucket, async (copy) => {
      const remote = seededRemote();
      const replicaPaths = bound(remote);
      remote.failNext("replicaPaths");
      await collectV3Lineages(copy, 2, { replicaPaths });
      assertEquals(await exists(remote, `${OLD}snapshot`), true);
      await assertDeferred(copy);
      await collectV3Lineages(copy, 2, { replicaPaths });
      assertEquals(await exists(remote, `${OLD}snapshot`), false);
      await assertV3ChunksCollectable(copy);
    });
  },
});

Deno.test({
  name:
    "v3 lineage paths: a file replica collects its own paths as before and never uses the provider's store",
  ignore,
  async fn() {
    const replicaOf = (dir: string) => join(dir, "replica");
    await withTakeover(
      (dir) => ({ type: "file", path: replicaOf(dir) }),
      async (copy, dir) => {
        const old = replicaPathFor(replicaOf(dir), 1);
        await Deno.mkdir(old, { recursive: true });
        await Deno.writeTextFile(join(old, "snapshot"), "x");
        const remote = seededRemote();
        await collectV3Lineages(copy, 2, { replicaPaths: bound(remote) });
        assertEquals(
          await Deno.lstat(old).then(() => true, () => false),
          false,
        );
        assertEquals(await exists(remote, `${OLD}snapshot`), true);
        await assertV3ChunksCollectable(copy);
      },
    );
  },
});
