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
import { readNewestSnapshotTxid } from "../src/infrastructure/datastore_v3/litestream/replica_snapshot.ts";
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

async function verifyLeftovers(
  paths: { sharedDir: string; privateDir: string },
): Promise<string[]> {
  const found: string[] = [];
  for (const dir of [paths.sharedDir, paths.privateDir]) {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.name.startsWith("verify-")) found.push(join(dir, entry.name));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return found;
}

async function sidecarConfig(
  env: ReplicationEnv,
  paths: Awaited<ReturnType<ReplicationEnv["paths"]>>,
  fence: number,
): Promise<string> {
  await ensurePrivateDir(paths);
  await Deno.writeTextFile(
    paths.config,
    `dbs:\n  - path: "${paths.commitsDb}"\n    replica:\n      type: file\n      path: "${
      replicaPathFor(env.replicaRoot, fence)
    }"\n`,
    { mode: 0o600 },
  );
  return paths.config;
}

async function sidecarGone(env: ReplicationEnv): Promise<void> {
  await waitFor(
    async () => await presenceOf(env) === undefined,
    "the sidecar to idle out",
    { timeoutMs: 20_000 },
  );
}

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
    // wait for a snapshot: a new snapshot is what starts the writer's next
    // check
    await waitFor(
      async () => (await ltxFiles(join(replica, "ltx", "9"))).length > 0,
      "Litestream to replicate and snapshot the broken copy",
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

async function localL0Files(commitsDb: string): Promise<string[]> {
  const dir = join(dirname(commitsDb), ".commits.db-litestream", "ltx", "0");
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    found.push(join(dir, entry.name));
  }
  return found;
}

async function processAlive(pid: number): Promise<boolean> {
  const result = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}

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
      await waitFor(
        async () => {
          const verdict = await readReplicaVerification(paths);
          return verdict?.lineageFence === first && verdict.ok;
        },
        "the sidecar to find its lineage restorable",
        { timeoutMs: 20_000 },
      );
      await sidecarGone(env);
      assertEquals(await verifyLeftovers(paths), []);

      const txid = await breakLineage(env, first);
      const copy = (await readCopyState(paths))!;
      await writeCopyState(paths, { ...copy, txid });
      const snapshot = await readNewestSnapshotTxid({
        binary: LITESTREAM_BINARY!,
        config: await sidecarConfig(env, paths, first),
        source: paths.commitsDb,
        replicaType: "file",
        signal: AbortSignal.timeout(30_000),
      });
      assert(snapshot !== undefined);
      const verdict = await verifyReplica({
        paths,
        lineageFence: first,
        replicaType: "file",
        binary: LITESTREAM_BINARY!,
        now: () => Date.now(),
        signal: AbortSignal.timeout(30_000),
        snapshotTxid: snapshot,
      });
      assertEquals(verdict?.ok, false);
      assertStringIncludes(verdict!.error!, "integrity check");
      assertEquals(verdict?.snapshotTxid, snapshot);
      assertEquals(await verifyLeftovers(paths), []);

      await writeCommand(env, 2);
      const next = (await readLineage(paths))!;
      assert(next.lineageFence > first);
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
    "v3 replica check: the real sidecar lists its replica's snapshot and records the one its check read through (swamp-club#4261)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 3);
      const paths = await env.paths();
      await waitFor(
        async () => (await readReplicaVerification(paths))?.ok === true,
        "the sidecar to check its new lineage",
        { timeoutMs: 20_000 },
      );
      // the first listing can run before Litestream writes the first snapshot;
      // the next acknowledgement is then checked once the snapshot is seen
      if ((await readReplicaVerification(paths))?.snapshotTxid === undefined) {
        await writeCommand(env, 1);
      }
      await waitFor(
        async () =>
          (await readReplicaVerification(paths))?.snapshotTxid !== undefined,
        "a check that read through the lineage's snapshot",
        { timeoutMs: 20_000 },
      );
      await sidecarGone(env);
      assertEquals(await verifyLeftovers(paths), []);

      // A verdict names only a snapshot its restore read through: one newer
      // than the restored TXID is left out, so the next check sees it as new.
      const { lineageFence, txid } = (await readCopyState(paths))!;
      const check = (snapshotTxid: string) =>
        verifyReplica({
          paths,
          lineageFence,
          replicaType: "file",
          binary: LITESTREAM_BINARY!,
          now: () => Date.now(),
          signal: AbortSignal.timeout(30_000),
          snapshotTxid,
        });
      const newer = (BigInt(`0x${txid}`) + 1n).toString(16).padStart(16, "0");
      assertEquals((await check(newer))?.snapshotTxid, undefined);
      assertEquals((await check(txid))?.snapshotTxid, txid);
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
      const pidFile = join(dir, "restore.pid");
      const stall = join(dir, "litestream");
      await Deno.writeTextFile(
        stall,
        `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 3600\n`,
      );
      await Deno.chmod(stall, 0o755);
      // The deadline's own error, so a stub that never ran cannot pass as one
      // the deadline killed.
      const rejection = await assertRejects(
        () =>
          verifyReplica({
            paths,
            lineageFence: 2,
            replicaType: "file",
            binary: stall,
            now: () => Date.now(),
            signal: new AbortController().signal,
            deadlineMs: 300,
          }),
        DOMException,
      );
      assertEquals(rejection.name, "TimeoutError");
      // only the deadline ends it: one firing first kills the stub before it
      // records its pid; never read an empty pid file as 0, since kill -0 0
      // targets our own process group
      const recorded = await Deno.readTextFile(pidFile)
        .then((text) => text.trim())
        .catch((error) => {
          if (error instanceof Deno.errors.NotFound) return "";
          throw error;
        });
      if (recorded !== "") {
        const pid = Number(recorded);
        await waitFor(
          async () => !await processAlive(pid),
          "the stalled restore to be killed",
        );
      }
      assertEquals(await readReplicaVerification(paths), undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "v3 replica check: the restore goes beside commits.db, not under /tmp, and a restore that fails or is cancelled leaves nothing (swamp-club#4261)",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Under /tmp: the replication paths include a control socket, and
    // macOS TMPDIR is too long for one.
    const dir = await Deno.realPath(
      await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-verify-where-" }),
    );
    try {
      const commitsDb = join(dir, "ds", "commits.db");
      await Deno.mkdir(dirname(commitsDb));
      const paths = await replicationPathsFor(commitsDb, join(dir, "priv"));
      await ensureSharedDir(paths);
      await ensurePrivateDir(paths);
      await writeCopyState(paths, {
        replicaRoot: "file:/r",
        lineageFence: 2,
        txid: "0000000000000005",
      });
      const recorded = join(dir, "restore-target");
      const stub = (tail: string) =>
        `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\n` +
        `echo "$2" > "${recorded}"\n` +
        `touch "$2" "$2.tmp" "$2-wal" "$2-shm"\n${tail}\n`;
      const failing = join(dir, "litestream-fails");
      await Deno.writeTextFile(failing, stub("echo boom >&2; exit 1"));
      const stalling = join(dir, "litestream-stalls");
      await Deno.writeTextFile(stalling, stub("exec sleep 3600"));
      for (const file of [failing, stalling]) await Deno.chmod(file, 0o755);

      for (
        const [binary, deadlineMs] of [[failing, 30_000], [
          stalling,
          500,
        ]] as const
      ) {
        await Deno.remove(recorded).catch(() => {});
        await assertRejects(() =>
          verifyReplica({
            paths,
            lineageFence: 2,
            replicaType: "file",
            binary,
            now: () => Date.now(),
            signal: new AbortController().signal,
            deadlineMs,
          })
        );
        const target = (await Deno.readTextFile(recorded)).trim();
        assertEquals(dirname(target), paths.sharedDir);
        assertEquals(await verifyLeftovers(paths), []);
        assertEquals(await readReplicaVerification(paths), undefined);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "v3 replica check: the snapshot listing reads the pinned Litestream's newest snapshot from a real replica (swamp-club#4261)",
  ignore,
  async fn() {
    const dir = await Deno.realPath(
      await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-verify-ltx-" }),
    );
    try {
      const db = join(dir, "commits.db");
      const conn = new DatabaseSync(db);
      try {
        conn.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x BLOB);");
        conn.exec("INSERT INTO t VALUES (randomblob(4096));");
      } finally {
        conn.close();
      }
      const replica = join(dir, "replica");
      const config = join(dir, "litestream.yml");
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
          async () => (await ltxFiles(join(replica, "ltx", "9"))).length > 0,
          "Litestream to write the lineage's first snapshot",
          { timeoutMs: 15_000 },
        );
      } finally {
        child.kill("SIGTERM");
        await child.status;
      }
      const newest = (await ltxFiles(join(replica, "ltx", "9")))
        .map((name) => name.split("-")[1].replace(".ltx", ""))
        .sort()
        .at(-1);
      assertEquals(
        await readNewestSnapshotTxid({
          binary: LITESTREAM_BINARY!,
          config,
          source: db,
          replicaType: "file",
          signal: AbortSignal.timeout(30_000),
        }),
        newest,
      );
      assertEquals(
        await readNewestSnapshotTxid({
          binary: LITESTREAM_BINARY!,
          config: join(dir, "missing.yml"),
          source: db,
          replicaType: "file",
          signal: AbortSignal.timeout(30_000),
        }),
        undefined,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
