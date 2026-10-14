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

import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { V3ReplicationError } from "../../../domain/datastore_v3/litestream_replication.ts";
import { replicaPathFor } from "../../../domain/datastore_v3/replication_lineage.ts";
import { withMockedEnv } from "../../persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "./replica_setting.ts";
import {
  ensureSharedDir,
  readLineage,
  replicationPathsFor,
  writeLineage,
} from "./replication_files.ts";
import {
  collectV3Lineages,
  lineageRegistryFor,
  prepareV3WriterLineage,
  recordV3LeaseFence,
  type V3Copy,
} from "./v3_copy.ts";

const AT = "2026-10-14T00:00:00.000Z";

interface Env {
  readonly copy: V3Copy;
  readonly replica: string;
  readonly root: string;
  readonly dir: string;
}

async function withCopy(fn: (env: Env) => Promise<void>): Promise<void> {
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
    await withMockedEnv(
      { [V3_REPLICA_ENV]: JSON.stringify({ type: "file", path: replica }) },
      () => fn({ copy, replica, root: `file:${replica}`, dir }),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function publish(
  env: Env,
  fence: number,
  options: { confirmed?: boolean; root?: string } = {},
): Promise<void> {
  const registry = lineageRegistryFor(env.copy.datastorePath);
  await registry.start({
    fence,
    holder: "test",
    replicaRoot: options.root ?? env.root,
    startedAt: AT,
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

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false);
}

Deno.test("prepareV3WriterLineage: a first writer claims a new lineage at its fence", async () => {
  await withCopy(async (env) => {
    await prepareV3WriterLineage(env.copy, 3, { restored: false });
    assertEquals((await lineageOf(env))?.lineageFence, 3);
    const started = await lineageRegistryFor(env.copy.datastorePath).started(3);
    assertEquals(started?.replicaRoot, env.root);
  });
});

Deno.test("prepareV3WriterLineage: continues its own published lineage at the next fence", async () => {
  await withCopy(async (env) => {
    await prepareV3WriterLineage(env.copy, 3, { restored: false });
    await prepareV3WriterLineage(env.copy, 4, { restored: false });
    const lineage = await lineageOf(env);
    assertEquals([lineage?.lineageFence, lineage?.lastFence], [3, 4]);
  });
});

Deno.test("prepareV3WriterLineage: restarts after a restore, or once another writer started a lineage", async () => {
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
});

Deno.test("prepareV3WriterLineage: refuses a lineage another writer already claimed", async () => {
  await withCopy(async (env) => {
    await publish(env, 7);
    await assertRejects(
      () => prepareV3WriterLineage(env.copy, 7, { restored: false }),
      V3ReplicationError,
      "already claimed",
    );
  });
});

Deno.test("recordV3LeaseFence: continues only a lineage nothing started after", async () => {
  await withCopy(async (env) => {
    await prepareV3WriterLineage(env.copy, 3, { restored: false });
    await recordV3LeaseFence(env.copy, 4);
    assertEquals((await lineageOf(env))?.lastFence, 4);
    await publish(env, 5);
    await recordV3LeaseFence(env.copy, 6);
    const lineage = await lineageOf(env);
    assertEquals([lineage?.lineageFence, lineage?.lastFence], [3, 4]);
  });
});

Deno.test("collectV3Lineages: removes replaced lineages under the root, never another root's", async () => {
  await withCopy(async (env) => {
    const registry = lineageRegistryFor(env.copy.datastorePath);
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
    assertEquals(await registry.started(1), undefined);
    assertEquals((await registry.started(3))?.replicaRoot, "file:/elsewhere");
    assertEquals((await registry.started(4))?.replicaRoot, env.root);
    assertEquals((await lineageOf(env))?.previousLineages, []);
  });
});

Deno.test("collectV3Lineages: leaves a symlinked lineage path and its records alone", async () => {
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
      (await lineageRegistryFor(env.copy.datastorePath).started(1))?.fence,
      1,
    );
  });
});

Deno.test("collectV3Lineages: does nothing unless the lineage is the current state", async () => {
  await withCopy(async (env) => {
    await publish(env, 1, { confirmed: true });
    await Deno.mkdir(replicaPathFor(env.replica, 1), { recursive: true });
    await publish(env, 2);
    await collectV3Lineages(env.copy, 2);
    assertEquals(await exists(replicaPathFor(env.replica, 1)), true);
  });
});
