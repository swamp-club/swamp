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
 * The writer's check of its own replica, and the new lineage it leads to
 * (swamp-club#3935), against a real Litestream and a file replica.
 *
 * A broken lineage is built the way the reported one looked to a reader: a
 * lineage Litestream restores without complaint into a database that fails
 * SQLite's integrity check, while the writer's own copy is intact. These
 * tests spawn the supervisor (from its entry file) and Litestream, like the
 * other sidecar tests, and kill every one they start.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import {
  ensurePrivateDir,
  ensureSharedDir,
  readCopyState,
  readLineage,
  readReplicaVerification,
  replicationPathsFor,
  writeCopyState,
  writeReplicaVerification,
} from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import { verifyReplica } from "../src/infrastructure/datastore_v3/litestream/replica_verifier.ts";
import { lineageRegistryFor } from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  startV3ReplicationUpkeep,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { v3WriterFence } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import {
  commitCount,
  commitIn,
  LITESTREAM_BINARY,
  presenceOf,
  type ReplicationEnv,
  restoredCommitCount,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
  writeCommand,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

/** Waits for the env's sidecar to idle out, so nothing writes its lineage. */
async function sidecarGone(env: ReplicationEnv): Promise<void> {
  await waitFor(
    async () => await presenceOf(env) === undefined,
    "the sidecar to idle out",
    { timeoutMs: 20_000 },
  );
}

/**
 * Replaces the files of lineage `fence` with a whole lineage of a copy of
 * the writer's database whose index on the commits table has a damaged
 * root page: Litestream restores it cleanly, and SQLite's integrity check
 * fails on it. Returns the TXID that lineage reaches.
 */
async function breakLineage(
  env: ReplicationEnv,
  fence: number,
): Promise<string> {
  const scratch = join(env.root, "broken");
  await Deno.mkdir(scratch);
  const db = join(scratch, "commits.db");
  const source = (await env.paths()).commitsDb;
  await Deno.copyFile(source, db);
  await Deno.copyFile(`${source}-wal`, `${db}-wal`).catch(() => {});
  // Closing the only connection checkpoints the WAL into the file.
  const conn = new DatabaseSync(db);
  let rootpage: number;
  let pageSize: number;
  try {
    rootpage = (conn.prepare(
      "SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND " +
        "tbl_name = 'commits' AND rootpage > 1 LIMIT 1",
    ).get() as { rootpage: number }).rootpage;
    pageSize = (conn.prepare("PRAGMA page_size").get() as {
      page_size: number;
    }).page_size;
  } finally {
    conn.close();
  }
  // An index b-tree page retyped as a table leaf (0x0d).
  const file = await Deno.open(db, { read: true, write: true });
  try {
    await file.seek((rootpage - 1) * pageSize, Deno.SeekMode.Start);
    await file.write(new Uint8Array([0x0d]));
  } finally {
    file.close();
  }
  const replica = join(scratch, "replica");
  const config = join(scratch, "litestream.yml");
  await Deno.writeTextFile(
    config,
    `dbs:\n  - path: "${db}"\n    replica:\n      type: file\n      path: "${replica}"\n`,
  );
  const child = new Deno.Command(LITESTREAM_BINARY!, {
    args: ["replicate", "-config", config],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await waitFor(
      async () => (await ltxFiles(replica)).length > 0,
      "Litestream to replicate the broken copy",
      { timeoutMs: 15_000 },
    );
  } finally {
    child.kill("SIGTERM");
    await child.status;
  }
  const lineage = replicaPathFor(env.replicaRoot, fence);
  await Deno.remove(lineage, { recursive: true });
  await copyTree(replica, lineage);
  const txids = (await ltxFiles(lineage)).map((name) =>
    name.split("-")[1].replace(".ltx", "")
  );
  return txids.sort().at(-1)!;
}

/** The paths of Litestream's local L0 files beside `commitsDb`. */
async function localL0Files(commitsDb: string): Promise<string[]> {
  const dir = join(dirname(commitsDb), ".commits.db-litestream", "ltx", "0");
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    found.push(join(dir, entry.name));
  }
  return found;
}

/** Whether process `pid` still runs (`kill -0`). */
async function processAlive(pid: number): Promise<boolean> {
  const result = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}

/** The LTX file names under `dir`, recursively. */
async function ltxFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) found.push(...await ltxFiles(path));
      else if (entry.name.endsWith(".ltx")) found.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found;
}

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) await copyTree(source, target);
    else await Deno.copyFile(source, target);
  }
}

Deno.test({
  name:
    "v3 replica check: the sidecar finds its lineage restorable, a broken one is recorded, and the next write starts a new lineage every commit restores from (swamp-club#3935)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 3);
      const paths = await env.paths();
      const first = (await readLineage(paths))!.lineageFence;
      // The real supervisor checks what its writer acknowledged.
      await waitFor(
        async () => {
          const verdict = await readReplicaVerification(paths);
          return verdict?.lineageFence === first && verdict.ok;
        },
        "the sidecar to find its lineage restorable",
        { timeoutMs: 20_000 },
      );
      await sidecarGone(env);

      const txid = await breakLineage(env, first);
      const copy = (await readCopyState(paths))!;
      await writeCopyState(paths, { ...copy, txid });
      const verdict = await verifyReplica({
        paths,
        lineageFence: first,
        replicaType: "file",
        binary: LITESTREAM_BINARY!,
        now: () => Date.now(),
        signal: AbortSignal.timeout(30_000),
      });
      assertEquals(verdict?.ok, false);
      assertStringIncludes(verdict!.error!, "integrity check");

      // The next writer restarts from its intact copy, at its own fence.
      await writeCommand(env, 2);
      const next = (await readLineage(paths))!;
      assert(next.lineageFence > first);
      // Once the new lineage is confirmed, collection removes the broken one.
      await assertRejects(
        () => Deno.stat(replicaPathFor(env.replicaRoot, first)),
        Deno.errors.NotFound,
      );
      assert(
        typeof await lineageRegistryFor(env.datastorePath).started(
          next.lineageFence,
        ) === "object",
      );
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, next.lineageFence),
        ),
        commitCount(paths.commitsDb),
      );
    });
  },
});

Deno.test({
  name:
    "v3 replica check: serve moves its lease to a new fence and restarts a lineage found broken, while it keeps serving (swamp-club#3935)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 2);
      const paths = await env.paths();
      const before = (await presenceOf(env))!;
      const fenceBefore = v3WriterFence(env.datastorePath)!;
      const upkeep = startV3ReplicationUpkeep(env.repoDir, env.config, {
        probeIntervalMs: 200,
      });
      try {
        await writeReplicaVerification(paths, {
          lineageFence: before.lineageFence,
          txid: "0000000000000001",
          checkedAt: new Date().toISOString(),
          ok: false,
          error: "the restored database failed SQLite's integrity check",
        });
        await waitFor(
          async () =>
            (await readLineage(paths))!.lineageFence > before.lineageFence &&
            (await presenceOf(env))?.lineageFence !== before.lineageFence,
          "serve to restart the lineage on a new sidecar",
          { timeoutMs: 20_000 },
        );
        assert(v3WriterFence(env.datastorePath)! > fenceBefore);
        // Serve keeps writing on the new fence.
        await commitIn(env, 1);
      } finally {
        await upkeep.stop();
      }
      const lineage = (await readLineage(paths))!.lineageFence;
      await closeV3Datastores();
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, lineage),
        ),
        commitCount(paths.commitsDb),
      );
    });
  },
});

Deno.test({
  name:
    "v3 replica check: a write that restarts a broken lineage under a live sidecar starts Litestream afresh, though the old lineage's first L0 files expired (swamp-club#3935)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      // Each command syncs: local L0 files at several TXIDs.
      for (let i = 0; i < 3; i++) await writeCommand(env, 1);
      const paths = await env.paths();
      const first = (await readLineage(paths))!.lineageFence;
      assert(await presenceOf(env) !== undefined);
      assert((await localL0Files(paths.commitsDb)).length > 1);
      // Retention expired the first local L0 file, as on any long-lived
      // copy; the sidecar still runs, so the WAL stays where Litestream
      // left it.
      const expired = (await localL0Files(paths.commitsDb)).filter((file) =>
        file.includes("0000000000000001-")
      );
      assertEquals(expired.length, 1);
      await Deno.remove(expired[0]);
      await writeReplicaVerification(paths, {
        lineageFence: first,
        txid: "0000000000000001",
        checkedAt: new Date().toISOString(),
        ok: false,
        error: "the restored database failed SQLite's integrity check",
      });
      await writeCommand(env, 2);
      const next = (await readLineage(paths))!.lineageFence;
      assert(next > first);
      assertEquals(
        await restoredCommitCount(env, replicaPathFor(env.replicaRoot, next)),
        commitCount(paths.commitsDb),
      );
    });
  },
});

Deno.test({
  name:
    "v3 replica check: a restore that stalls past the deadline ends the check without a verdict (swamp-club#3935)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.realPath(
      await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-verify-stall-" }),
    );
    try {
      const commitsDb = join(dir, "commits.db");
      const paths = await replicationPathsFor(commitsDb, join(dir, "priv"));
      await ensureSharedDir(paths);
      await ensurePrivateDir(paths);
      await writeCopyState(paths, {
        replicaRoot: "file:/r",
        lineageFence: 2,
        txid: "0000000000000005",
      });
      // A Litestream whose restore never finishes, recording its pid.
      const pidFile = join(dir, "restore.pid");
      const stall = join(dir, "litestream");
      await Deno.writeTextFile(
        stall,
        `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 3600\n`,
      );
      await Deno.chmod(stall, 0o755);
      await assertRejects(() =>
        verifyReplica({
          paths,
          lineageFence: 2,
          replicaType: "file",
          binary: stall,
          now: () => Date.now(),
          signal: new AbortController().signal,
          deadlineMs: 300,
        })
      );
      // Only the deadline ends it: the stalled restore was killed.
      const pid = Number((await Deno.readTextFile(pidFile)).trim());
      await waitFor(
        async () => !await processAlive(pid),
        "the stalled restore to be killed",
      );
      assertEquals(await readReplicaVerification(paths), undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
