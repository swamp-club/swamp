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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  closeV3Datastores,
  confirmV3Replicated,
  holdV3Writer,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { V3ReplicationError } from "../src/domain/datastore_v3/litestream_replication.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import type { ReplicaReader } from "../src/infrastructure/datastore_v3/litestream/litestream_replicator.ts";
import { readReplicaMaxTxid } from "../src/infrastructure/datastore_v3/litestream/replica_snapshot.ts";
import { restoreAndCheck } from "../src/infrastructure/datastore_v3/litestream/litestream_restorer.ts";
import {
  commitIn,
  presenceOf,
  type ReplicationEnv,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

/**
 * signals the sidecar's whole process group, as a systemd stop does to every
 * process in the unit's cgroup, and waits for Litestream's own final sync and
 * exit
 */
async function signalSidecarWithServe(env: ReplicationEnv): Promise<void> {
  const presence = await presenceOf(env);
  if (presence?.litestreamPid === undefined) {
    throw new Error("no sidecar is running");
  }
  const litestream = presence.litestreamPid;
  hostLitestreamProcesses.signalGroup(presence.supervisorPid, "SIGTERM");
  await waitFor(
    () => !hostLitestreamProcesses.isAlive(litestream),
    "Litestream exits on SIGTERM",
    { timeoutMs: 15_000 },
  );
}

function countingReader() {
  const calls = { maxTxid: 0, restore: 0 };
  const reader: ReplicaReader = {
    maxTxid: (request) => {
      calls.maxTxid++;
      return readReplicaMaxTxid(request);
    },
    restore: (request) => {
      calls.restore++;
      return restoreAndCheck(request);
    },
  };
  return { calls, reader };
}

Deno.test({
  name:
    "closeV3Datastores: commits Litestream synced as it was signalled with the process are confirmed from the replica",
  ignore,
  async fn() {
    const counting = countingReader();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      await confirmV3Replicated(env.datastorePath);
      // a background commit nothing confirmed before the stop
      await commitIn(env, 1);
      await signalSidecarWithServe(env);
      await closeV3Datastores();
      assertEquals(counting.calls.restore, 1);
    }, { deps: { replicaReader: counting.reader } });
  },
});

Deno.test({
  name:
    "closeV3Datastores: with nothing committed since the last confirmed sync, a gone sidecar needs no replica read",
  ignore,
  async fn() {
    const counting = countingReader();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 2);
      await confirmV3Replicated(env.datastorePath);
      await signalSidecarWithServe(env);
      await closeV3Datastores();
      assertEquals(counting.calls, { maxTxid: 0, restore: 0 });
    }, { deps: { replicaReader: counting.reader } });
  },
});

Deno.test({
  name:
    "closeV3Datastores: a commit made after the sidecar exited is still reported as unconfirmed",
  ignore,
  async fn() {
    const counting = countingReader();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      await confirmV3Replicated(env.datastorePath);
      await signalSidecarWithServe(env);
      await commitIn(env, 1);
      await assertRejects(
        () => closeV3Datastores(),
        V3ReplicationError,
        "Litestream sidecar failed",
      );
      assertEquals(counting.calls.restore, 1);
    }, { deps: { replicaReader: counting.reader } });
  },
});

Deno.test({
  name:
    "closeV3Datastores: a replica that cannot be read leaves the closing sync's error",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      await confirmV3Replicated(env.datastorePath);
      await commitIn(env, 1);
      await signalSidecarWithServe(env);
      await assertRejects(
        () => closeV3Datastores(),
        V3ReplicationError,
        "Litestream sidecar failed",
      );
    }, {
      deps: {
        replicaReader: {
          maxTxid: () => Promise.resolve(undefined),
          restore: () => Promise.reject(new Error("not reached")),
        },
      },
    });
  },
});

function countCompactions(env: ReplicationEnv): { calls: number } {
  const handle = v3DatastoreFor(env.repoDir, env.config);
  const counted = { calls: 0 };
  const compactIfDue = handle.compactIfDue.bind(handle);
  handle.compactIfDue = (signal) => {
    counted.calls++;
    return compactIfDue(signal);
  };
  return counted;
}

Deno.test({
  name:
    "closeV3Datastores: skips the closing compaction once the sidecar is gone, so it commits nothing no replica holds",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      await confirmV3Replicated(env.datastorePath);
      const compactions = countCompactions(env);
      await signalSidecarWithServe(env);
      await closeV3Datastores();
      assertEquals(compactions.calls, 0);
    });
  },
});

Deno.test({
  name:
    "closeV3Datastores: still runs the closing compaction while the sidecar answers",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      await confirmV3Replicated(env.datastorePath);
      const compactions = countCompactions(env);
      await closeV3Datastores();
      assertEquals(compactions.calls, 1);
    });
  },
});
