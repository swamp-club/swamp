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
import { resolve } from "@std/path";
import { V3ReplicationError } from "../src/domain/datastore_v3/litestream_replication.ts";
import {
  LitestreamControlError,
  unixLitestreamControl,
} from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import {
  confirmV3Replicated,
  holdV3Writer,
  onV3CommitOutcome,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  LeaderCommitHealth,
  wireLeaderCommitHealth,
} from "../src/serve/leader_commit_health.ts";
import {
  commitIn,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

await initializeLogging({});

const ignore = SIDECAR_TESTS_IGNORED;

/** the sidecar's reply when the leader's volume is full */
const SIDECAR_DISK_FULL =
  "sync database: db sync: sync: stage-write ltx file /home/swamp/team/.swamp/_datastore_v3_copies/d7e8ab35878e173a/.commits.db-litestream/ltx/0/0000000000000020-0000000000000020.ltx.tmp: disk full: write page index: write page index element: write /home/swamp/team/.swamp/_datastore_v3_copies/d7e8ab35878e173a/.commits.db-litestream/ltx/0/0000000000000020-0000000000000020.ltx.tmp: no space left on device";

/** the bucket's failure, which every node shares */
const SIDECAR_BUCKET_DOWN =
  "sync database: replica sync: write ltx file: googleapi: Error 503: We encountered an internal error. Please try again., backendError";

function failingSync(reply: { error: string | undefined }) {
  return (
    socket: string,
    db: string,
    deadlineMs: number,
    signal?: AbortSignal,
  ) =>
    reply.error === undefined
      ? unixLitestreamControl.sync(socket, db, deadlineMs, signal)
      : Promise.reject(
        new LitestreamControlError(
          `POST /sync answered 500: ${reply.error}`,
          false,
          { sidecarError: reply.error },
        ),
      );
}

async function leaderOver(
  datastorePath: string,
  run: (health: LeaderCommitHealth) => Promise<void>,
): Promise<string[]> {
  const health = new LeaderCommitHealth({ windowMs: 0 });
  const steps: string[] = [];
  const wired = wireLeaderCommitHealth({
    datastorePath: resolve(datastorePath),
    leads: () => true,
    onCommitOutcome: onV3CommitOutcome,
    stopRenewal: () => {
      steps.push("stop-renewal");
      return Promise.resolve();
    },
    stepDown: () => {
      steps.push("step-down");
      return Promise.resolve();
    },
    health,
  });
  try {
    await run(health);
    await wired.steppedDown();
    return steps;
  } finally {
    wired.stop();
  }
}

Deno.test({
  name:
    "leader commit health: replication failing because the sidecar cannot write on this node's full disk trips the leader, though every commit landed locally",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const reply: { error: string | undefined } = { error: undefined };
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      const steps = await leaderOver(env.datastorePath, async (health) => {
        await commitIn(env, 1);
        await confirmV3Replicated(env.datastorePath);
        reply.error = SIDECAR_DISK_FULL;
        for (let attempt = 1; attempt <= 3; attempt++) {
          // SQLite still commits and applies into the space its WAL holds
          await commitIn(env, 1);
          await v3DatastoreFor(env.repoDir, env.config).catchUp();
          await assertRejects(
            () => confirmV3Replicated(env.datastorePath),
            V3ReplicationError,
          );
          assertEquals(
            health.cannotCommit() !== undefined,
            attempt === 3,
            `after failed sync ${attempt}`,
          );
        }
        assertEquals(health.cannotCommit()?.cause, "storage_full");
      });
      assertEquals(steps, ["stop-renewal", "step-down"]);
    }, {
      deps: {
        control: { info: unixLitestreamControl.info, sync: failingSync(reply) },
      },
    });
  },
});

Deno.test({
  name:
    "leader commit health: replication failing because the bucket is down never trips the leader, and a replicated commit starts the run again",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const reply: { error: string | undefined } = { error: undefined };
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      const steps = await leaderOver(env.datastorePath, async (health) => {
        reply.error = SIDECAR_BUCKET_DOWN;
        for (let attempt = 0; attempt < 4; attempt++) {
          await commitIn(env, 1);
          await assertRejects(
            () => confirmV3Replicated(env.datastorePath),
            V3ReplicationError,
          );
        }
        assertEquals(health.cannotCommit(), undefined);

        reply.error = SIDECAR_DISK_FULL;
        for (let attempt = 0; attempt < 2; attempt++) {
          await commitIn(env, 1);
          await assertRejects(() => confirmV3Replicated(env.datastorePath));
        }
        reply.error = undefined;
        await commitIn(env, 1);
        await confirmV3Replicated(env.datastorePath);
        reply.error = SIDECAR_DISK_FULL;
        await commitIn(env, 1);
        await assertRejects(() => confirmV3Replicated(env.datastorePath));
        assertEquals(health.cannotCommit(), undefined);
      });
      assertEquals(steps, []);
    }, {
      deps: {
        control: { info: unixLitestreamControl.info, sync: failingSync(reply) },
      },
    });
  },
});
