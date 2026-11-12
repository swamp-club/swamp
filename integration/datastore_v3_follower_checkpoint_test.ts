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

// these spawn the real supervisor and Litestream: only a real sidecar start
// shows which auto-checkpoint each connection had when it began

import { assert, assertEquals } from "@std/assert";
import type { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import { leaseOp } from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  MODEL_TYPE,
  modelCommit,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { applyV3LeaderChanges } from "../src/infrastructure/datastore_v3/serve_feed.ts";
import { storeConnectionsAt } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  holdV3Writer,
  startV3ReplicationUpkeep,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import {
  presenceOf,
  type ReplicationEnv,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

const SERVE = { as: "serve", address: undefined } as const;

function autoCheckpointOf(db: DatabaseSync): number {
  return (db.prepare("PRAGMA wal_autocheckpoint").get() as {
    wal_autocheckpoint: number;
  }).wal_autocheckpoint;
}

/** each connection's auto-checkpoint at every sidecar launch */
function launchRecorder() {
  let commitsDb: string | undefined;
  const atLaunch: number[][] = [];
  return {
    atLaunch,
    watch(path: string) {
      commitsDb = path;
    },
    deps: {
      processes: {
        ...hostLitestreamProcesses,
        launch: (
          launch: Parameters<typeof hostLitestreamProcesses.launch>[0],
        ) => {
          atLaunch.push(
            commitsDb === undefined
              ? []
              : storeConnectionsAt(commitsDb).map(autoCheckpointOf),
          );
          return hostLitestreamProcesses.launch(launch);
        },
      },
    },
  };
}

/** a leader's commits, as its feed sends them: one partition, seqs from `from` */
function leaderChanges(from: number, count: number, fence: number) {
  const partition = partitionOf({
    kind: "model",
    type: MODEL_TYPE,
    id: "6f1e2d3c-4b5a-4968-8a7b-6c5d4e3f2a1b",
  });
  return Array.from({ length: count }, (_, i) => {
    const seq = from + i;
    return {
      cursor: seq,
      commit: modelCommit(seq, [leaseOp({ holder: "serve", fence })], {
        partition,
        fence,
        txnId: `leader-${seq}`,
      }).toJSON(),
    };
  });
}

async function follow(env: ReplicationEnv) {
  // another serve, alive on this host, leads
  const leader = await plantV3WriterLease(env.datastorePath, {
    pid: Deno.ppid,
  });
  const role = await holdV3Writer(env.config, env.repoDir, {
    retakeLost: true,
    follow: true,
    ownerCheck: SERVE,
  });
  assertEquals(role, "follower");
  return leader;
}

Deno.test({
  name:
    "v3 follower checkpointing: a serve follower's copy keeps SQLite's default auto-checkpoint, so applying the leader's feed checkpoints its WAL (swamp-club#4679)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      const leader = await follow(env);
      try {
        const handle = v3DatastoreFor(env.repoDir, env.config);
        const connections = storeConnectionsAt(handle.commitsDbPath);
        assert(connections.length > 0);
        assertEquals(connections.map(autoCheckpointOf), [1000]);
        const before = (await Deno.stat(handle.commitsDbPath)).size;
        // past SQLite's 1000-frame auto-checkpoint
        for (let from = 1; from <= 700; from += 100) {
          await applyV3LeaderChanges(
            env.repoDir,
            env.config,
            leaderChanges(from, 100, leader.fence),
          );
        }
        assertEquals(handle.commitStore.highWaterMark().cursor, 700);
        // frames moved into the file: the WAL does not grow without bound
        assert((await Deno.stat(handle.commitsDbPath)).size > before);
      } finally {
        await leader.release();
      }
    });
  },
});

Deno.test({
  name:
    "v3 follower checkpointing: take() and a sidecar replacement turn auto-checkpoint off on every connection before the sidecar starts, while the feed applies (swamp-club#4679)",
  ignore,
  async fn() {
    const recorder = launchRecorder();
    await withReplicationEnv(async (env) => {
      const leader = await follow(env);
      const handle = v3DatastoreFor(env.repoDir, env.config);
      recorder.watch(handle.commitsDbPath);
      await applyV3LeaderChanges(
        env.repoDir,
        env.config,
        leaderChanges(1, 50, leader.fence),
      );
      await leader.release();
      // the feed keeps applying while the takeover runs
      let taking = true;
      let applied = 0;
      const feed = (async () => {
        let from = 51;
        while (taking) {
          await applyV3LeaderChanges(
            env.repoDir,
            env.config,
            leaderChanges(from, 5, leader.fence),
          ).then(() => applied++, () => {});
          from += 5;
          await new Promise((done) => setTimeout(done, 0));
        }
      })();
      let role: string;
      try {
        role = await holdV3Writer(env.config, env.repoDir, {
          retakeLost: true,
          follow: true,
          ownerCheck: SERVE,
        });
      } finally {
        taking = false;
        await feed;
      }
      assertEquals(role, "writer");
      assert(applied > 0);
      assert(recorder.atLaunch.length >= 1);
      const first = (await presenceOf(env))!;
      // a replacement: the probe finds the sidecar gone and starts another
      const upkeep = startV3ReplicationUpkeep(env.repoDir, env.config, {
        probeIntervalMs: 200,
      });
      try {
        hostLitestreamProcesses.signalGroup(first.supervisorPid, "SIGKILL");
        await waitFor(async () => {
          const now = await presenceOf(env);
          return now !== undefined && now.supervisorPid !== first.supervisorPid;
        }, "the probe to replace the sidecar");
      } finally {
        await upkeep.stop();
      }
      assert(recorder.atLaunch.length >= 2);
      for (const connections of recorder.atLaunch) {
        assert(connections.length > 0);
        assertEquals(connections.filter((value) => value !== 0), []);
      }
    }, { deps: recorder.deps });
  },
});

Deno.test({
  name:
    "v3 follower checkpointing: a serve that leads at boot starts its sidecar with auto-checkpoint off on every connection (swamp-club#4679)",
  ignore,
  async fn() {
    const recorder = launchRecorder();
    await withReplicationEnv(async (env) => {
      recorder.watch((await env.paths()).commitsDb);
      const role = await holdV3Writer(env.config, env.repoDir, {
        retakeLost: true,
        follow: true,
        ownerCheck: SERVE,
      });
      assertEquals(role, "writer");
      assert(recorder.atLaunch.length >= 1);
      for (const connections of recorder.atLaunch) {
        assert(connections.length > 0);
        assertEquals(connections.filter((value) => value !== 0), []);
      }
    }, { deps: recorder.deps });
  },
});
