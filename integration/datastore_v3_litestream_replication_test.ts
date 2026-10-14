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
 * The v3 writer's Litestream sidecar against a real Litestream and a file
 * replica (swamp-club#3416, Phase 4 D1). Write commands run in-process;
 * the sidecar is a real detached supervisor with Litestream as its child.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { V3ReplicationError } from "../src/domain/datastore_v3/litestream_replication.ts";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  bytesUnder,
  commitCount,
  commitIn,
  presenceOf,
  restoredCommitCount,
  SIDECAR_TESTS_IGNORED,
  TEST_TIMINGS,
  withReplicationEnv,
  writeCommand,
} from "./datastore_v3_litestream_helpers.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  startV3ReplicationUpkeep,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  hostSupervisorCommand,
  LitestreamReplicator,
} from "../src/infrastructure/datastore_v3/litestream/litestream_replicator.ts";
import { unixLitestreamControl } from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import {
  acquireV3WriterLock,
  tryAcquireV3WriterLock,
  v3WriterFence,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";

const ignore = SIDECAR_TESTS_IGNORED;

Deno.test({
  name:
    "v3 replication: a write command's commits are in the replica when its teardown returns",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 3);
      const presence = await presenceOf(env);
      assert(
        presence !== undefined,
        "the sidecar stays up for the next command",
      );
      const local = commitCount(join(env.datastorePath, "commits.db"));
      assertEquals(local, 3);
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, presence.lineageFence),
        ),
        local,
      );
    });
  },
});

Deno.test({
  name: "v3 replication: one sync covers a burst of commits",
  ignore,
  async fn() {
    let syncs = 0;
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 8);
      assertEquals(syncs, 1);
    }, {
      deps: {
        control: {
          info: unixLitestreamControl.info,
          sync: (socket, db, deadline) => {
            syncs++;
            return unixLitestreamControl.sync(socket, db, deadline);
          },
        },
      },
    });
  },
});

Deno.test({
  name:
    "v3 replication: commands reuse one sidecar, and several holds in a command share it",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 1, { holds: 3 });
      const first = await presenceOf(env);
      await writeCommand(env, 1);
      await writeCommand(env, 1);
      const later = await presenceOf(env);
      assert(first !== undefined && later !== undefined);
      assertEquals(later.supervisorPid, first.supervisorPid);
      assertEquals(
        later.lineageFence,
        first.lineageFence,
        "consecutive fences continue the lineage",
      );
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, later.lineageFence),
        ),
        3,
      );
    });
  },
});

Deno.test({
  name:
    "v3 replication: another writer's fence restarts the lineage on a new path",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 1);
      const first = (await presenceOf(env))!;
      // Another writer takes the lease and lets it go, without replicating,
      // so it records no lineage.
      await withMockedEnv({ [V3_REPLICA_ENV]: undefined }, async () => {
        await (await acquireV3WriterLock(env.datastorePath))();
      });
      await writeCommand(env, 1);
      const second = (await presenceOf(env))!;
      assertNotEquals(second.lineageFence, first.lineageFence);
      assertNotEquals(
        second.supervisorPid,
        first.supervisorPid,
        "the sidecar was replaced",
      );
      assertEquals(hostLitestreamProcesses.isAlive(first.supervisorPid), false);
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, second.lineageFence),
        ),
        2,
      );
    });
  },
});

Deno.test({
  name:
    "v3 replication: the idle sidecar never exits while a command uses it, and exits after",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      const presence = (await presenceOf(env))!;
      const heldSince = Date.now();
      // Well past the idle timeout and many supervisor ticks.
      await waitFor(
        () => Date.now() - heldSince > 6_000,
        "the idle timeout to pass",
        {
          timeoutMs: 10_000,
        },
      );
      assert(
        hostLitestreamProcesses.isAlive(presence.supervisorPid),
        "it stays while held",
      );
      await commitIn(env, 1);
      await closeV3Datastores();
      await waitFor(
        () => !hostLitestreamProcesses.isAlive(presence.supervisorPid),
        "the sidecar to idle out once released",
        { timeoutMs: 15_000 },
      );
      assertEquals(await presenceOf(env), undefined);
    });
  },
});

Deno.test({
  name:
    "v3 replication: a frozen sidecar is replaced after the deadline, leaving one",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 1);
      const frozen = (await presenceOf(env))!;
      hostLitestreamProcesses.signal(frozen.litestreamPid!, "SIGSTOP");
      hostLitestreamProcesses.signal(frozen.supervisorPid, "SIGSTOP");
      await writeCommand(env, 1);
      const fresh = (await presenceOf(env))!;
      assertNotEquals(fresh.supervisorPid, frozen.supervisorPid);
      await waitFor(
        () =>
          !hostLitestreamProcesses.isAlive(frozen.supervisorPid) &&
          !hostLitestreamProcesses.isAlive(frozen.litestreamPid!),
        "the frozen sidecar to be gone",
      );
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, fresh.lineageFence),
        ),
        2,
      );
    }, { timings: { startWaitMs: 3_000 } });
  },
});

Deno.test({
  name:
    "v3 replication: a Litestream its supervisor left behind is killed before a new start",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 1);
      const old = (await presenceOf(env))!;
      // Only the supervisor dies; its Litestream lives on.
      hostLitestreamProcesses.signal(old.supervisorPid, "SIGKILL");
      await waitFor(
        () => !hostLitestreamProcesses.isAlive(old.supervisorPid),
        "the supervisor to die",
      );
      assert(hostLitestreamProcesses.isAlive(old.litestreamPid!));
      await writeCommand(env, 1);
      await waitFor(
        () => !hostLitestreamProcesses.isAlive(old.litestreamPid!),
        "the orphaned Litestream to be killed",
      );
      const fresh = (await presenceOf(env))!;
      assertNotEquals(fresh.supervisorPid, old.supervisorPid);
    });
  },
});

Deno.test({
  name:
    "v3 replication: a stale record naming an unrelated live pid is left alone",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      const paths = await env.paths();
      await Deno.mkdir(paths.sharedDir, { recursive: true, mode: 0o700 });
      // This test runner's parent: alive, and no sidecar.
      await Deno.writeTextFile(
        paths.presence,
        JSON.stringify({
          supervisorPid: Deno.ppid,
          litestreamPid: Deno.ppid,
          uid: Deno.uid(),
          hostname: Deno.hostname(),
          lineageFence: 1,
          replicaPath: "/nowhere",
        }),
      );
      await writeCommand(env, 1);
      assert(hostLitestreamProcesses.isAlive(Deno.ppid));
      assertNotEquals((await presenceOf(env))!.supervisorPid, Deno.ppid);
    });
  },
});

Deno.test({
  name: "v3 replication: a symlinked datastore path finds the same sidecar",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 1);
      const first = (await presenceOf(env))!;
      const link = join(env.root, "ds-link");
      await Deno.symlink(env.datastorePath, link, { type: "dir" });
      await holdV3Writer(
        { type: "filesystem", path: link },
        join(env.root, "repo2"),
      );
      await closeV3Datastores();
      assertEquals((await presenceOf(env))!.supervisorPid, first.supervisorPid);
    });
  },
});

Deno.test({
  name:
    "v3 replication: within a lineage, the next start uploads no full snapshot",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      // Enough commits that a snapshot of commits.db shows in the replica's
      // size against one command's change.
      await writeCommand(env, 40);
      const first = (await presenceOf(env))!;
      const path = replicaPathFor(env.replicaRoot, first.lineageFence);
      const dbBytes =
        (await Deno.stat(join(env.datastorePath, "commits.db"))).size;
      // The sidecar is restarted on the same lineage: a killed sidecar.
      hostLitestreamProcesses.signalGroup(first.supervisorPid, "SIGKILL");
      await waitFor(
        () => !hostLitestreamProcesses.isAlive(first.supervisorPid),
        "the kill",
      );
      const before = await bytesUnder(path);
      await writeCommand(env, 1);
      const after = await bytesUnder(path);
      assertEquals((await presenceOf(env))!.lineageFence, first.lineageFence);
      assert(
        after - before < dbBytes / 2,
        `the restart uploaded ${
          after - before
        } bytes of a ${dbBytes}-byte database`,
      );
      assertEquals(await restoredCommitCount(env, path), 41);
    });
  },
});

Deno.test({
  name: "v3 replication: two writers starting a sidecar at once leave one",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      // Two replicators stand in for two processes: each has its own locks.
      const paths = await env.paths();
      const make = () =>
        new LitestreamReplicator({
          processes: {
            ...hostLitestreamProcesses,
            launch: (launch) => {
              const pid = hostLitestreamProcesses.launch(launch);
              launched.push(pid);
              return pid;
            },
          },
          control: unixLitestreamControl,
          resolveBinary: () =>
            Promise.resolve(Deno.env.get("SWAMP_LITESTREAM_PATH")!),
          supervisor: hostSupervisorCommand(),
          timings: TEST_TIMINGS,
          now: () => Date.now(),
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          privateRoot: env.privateRoot,
        });
      const launched: number[] = [];
      const request = {
        commitsDb: paths.commitsDb,
        replica: { type: "file" as const, path: env.replicaRoot },
        fence: 1,
        assertLeaseCurrent: () => Promise.resolve(),
      };
      const [a, b] = await Promise.all([
        make().acquire(request),
        make().acquire(request),
      ]);
      const presence = (await presenceOf(env))!;
      for (const pid of launched) {
        if (pid !== presence.supervisorPid) {
          await waitFor(
            () => !hostLitestreamProcesses.isAlive(pid),
            "the losing supervisor to exit",
          );
        }
      }
      await a.release();
      await b.release();
    });
  },
});

Deno.test({
  name:
    "v3 replication: a crashed command and a recovering read keep the lineage",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 1);
      const first = (await presenceOf(env))!;
      // A command takes the next fence and ends without its teardown.
      await (await acquireV3WriterLock(env.datastorePath))();
      // A read-only command recovers the checkout under the fence after.
      const recovery = await tryAcquireV3WriterLock(env.datastorePath);
      assert(recovery !== undefined);
      await recovery();
      await writeCommand(env, 1);
      const later = (await presenceOf(env))!;
      assertEquals(later.lineageFence, first.lineageFence);
      assertEquals(later.supervisorPid, first.supervisorPid);
    });
  },
});

Deno.test({
  name:
    "v3 replication: the first start after an idle exit restores every commit (and what it uploads is measured)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 4, { bytes: 256 * 1024 });
      const first = (await presenceOf(env))!;
      const path = replicaPathFor(env.replicaRoot, first.lineageFence);
      await waitFor(
        () => !hostLitestreamProcesses.isAlive(first.supervisorPid),
        "the idle exit",
        { timeoutMs: 15_000 },
      );
      const dbBytes =
        (await Deno.stat(join(env.datastorePath, "commits.db"))).size;
      const before = await bytesUnder(path);
      await writeCommand(env, 1);
      const uploaded = await bytesUnder(path) - before;
      // Recorded for the design record: the stopping Litestream may hold the
      // last connection, so SQLite can checkpoint the WAL and the next start
      // can upload a snapshot. Every commit must restore either way.
      console.error(
        `idle restart uploaded ${uploaded} bytes of a ${dbBytes}-byte database`,
      );
      assertEquals(await restoredCommitCount(env, path), 5);
    });
  },
});

Deno.test({
  name:
    "v3 replication: serve's probe restarts a Litestream that died, and stop waits and starts nothing more",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const first = (await presenceOf(env))!;
      const upkeep = startV3ReplicationUpkeep(env.datastorePath, {
        probeIntervalMs: 200,
      });
      try {
        hostLitestreamProcesses.signalGroup(first.supervisorPid, "SIGKILL");
        await waitFor(async () => {
          const now = await presenceOf(env);
          return now !== undefined && now.supervisorPid !== first.supervisorPid;
        }, "the probe to start a new sidecar");
      } finally {
        await upkeep.stop();
      }
      const kept = (await presenceOf(env))!;
      await commitIn(env, 1);
      await closeV3Datastores();
      assertEquals(
        (await presenceOf(env))?.supervisorPid ?? kept.supervisorPid,
        kept.supervisorPid,
      );
      assertEquals(
        await restoredCommitCount(
          env,
          replicaPathFor(env.replicaRoot, kept.lineageFence),
        ),
        1,
      );
    });
  },
});

Deno.test({
  name:
    "v3 replication: serve's lease retake replaces its sidecar on the new lineage while renewal goes on",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      // The process's first acquire decides the hold: a short TTL, retaken
      // once lost, as serve's is.
      const fences = v3DatastoreFor(env.repoDir, env.config).commitStore;
      const own = await acquireV3WriterLock(env.datastorePath, {
        ttlMs: 900,
        retakeLost: true,
        fenceStore: fences,
      });
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const first = (await presenceOf(env))!;
      const upkeep = startV3ReplicationUpkeep(env.datastorePath, {
        probeIntervalMs: 60_000,
      });
      try {
        // Another process takes the lease over at the next fence, so serve's
        // hold is lost; once it lets go, serve's renewal takes a fresh lease
        // above it: a gap in this copy's fences, so a new lineage.
        const other = await plantV3WriterLease(env.datastorePath, {
          pid: Deno.ppid,
        });
        await waitFor(
          () =>
            v3WriterFence(env.datastorePath) === undefined ||
            v3WriterFence(env.datastorePath)! < other.fence,
          "serve to notice it lost the lease",
        );
        await other.release();
        await waitFor(
          async () => {
            const now = await presenceOf(env);
            return now !== undefined &&
              now.supervisorPid !== first.supervisorPid;
          },
          "the sidecar to be replaced after the retake",
          { timeoutMs: 15_000 },
        );
        assert(v3WriterFence(env.datastorePath)! > first.lineageFence);
      } finally {
        await upkeep.stop();
        await own();
      }
    });
  },
});

Deno.test({
  name:
    "v3 replication: serve's close fails when its sidecar could not be replaced",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const first = (await presenceOf(env))!;
      const upkeep = startV3ReplicationUpkeep(env.datastorePath, {
        probeIntervalMs: 200,
      });
      // From now on no sidecar can be started: the binary cannot be had.
      let attempts = 0;
      setV3ReplicationForTesting({
        privateRoot: env.privateRoot,
        timings: TEST_TIMINGS,
        resolveBinary: () => {
          attempts++;
          return Promise.reject(new Error("offline"));
        },
      });
      try {
        await commitIn(env, 1);
        hostLitestreamProcesses.signalGroup(first.supervisorPid, "SIGKILL");
        await waitFor(
          () => attempts > 0,
          "the probe's replacement to try a start",
        );
      } finally {
        await upkeep.stop();
      }
      await assertRejects(
        () => closeV3Datastores(),
        V3ReplicationError,
        "could not be replaced",
      );
    });
  },
});

const S3_ENDPOINT = Deno.env.get("SWAMP_TEST_LITESTREAM_S3_ENDPOINT");

Deno.test({
  name:
    "v3 replication: an S3 replica confirms a command's commits and keeps one sidecar (opt-in)",
  ignore: ignore || S3_ENDPOINT === undefined,
  async fn() {
    await withReplicationEnv(async (env) => {
      await withMockedEnv({
        [V3_REPLICA_ENV]: JSON.stringify({
          type: "s3",
          bucket: Deno.env.get("SWAMP_TEST_LITESTREAM_S3_BUCKET") ??
            "swamp-test",
          path: `ls-${crypto.randomUUID()}`,
          endpoint: S3_ENDPOINT,
          region: "us-east-1",
        }),
      }, async () => {
        // The emulator's credentials reach Litestream through the
        // supervisor's environment (AWS_ACCESS_KEY_ID and the rest).
        await writeCommand(env, 2);
        const first = (await presenceOf(env))!;
        await writeCommand(env, 1);
        assertEquals(
          (await presenceOf(env))!.supervisorPid,
          first.supervisorPid,
        );
      });
    });
  },
});

Deno.test("v3 replication: with the setting unset a write command starts nothing and leaves no replication state", async () => {
  const root = await Deno.makeTempDir({ prefix: "swamp-ls-off-" });
  try {
    await withMockedEnv({ [V3_REPLICA_ENV]: undefined }, async () => {
      const datastorePath = join(root, "ds");
      await initializeV3Datastore(datastorePath, "test");
      const config = { type: "filesystem" as const, path: datastorePath };
      const repoDir = join(root, "repo");
      let launches = 0;
      setV3ReplicationForTesting({
        processes: {
          ...hostLitestreamProcesses,
          launch: () => {
            launches++;
            throw new Error("nothing may start");
          },
        },
      });
      try {
        await holdV3Writer(config, repoDir);
        await closeV3Datastores();
      } finally {
        setV3ReplicationForTesting(undefined);
      }
      assertEquals(launches, 0);
      assertEquals(
        [...Deno.readDirSync(datastorePath)].some((e) =>
          e.name.includes("replication")
        ),
        false,
      );
    });
  } finally {
    await closeV3Datastores().catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
