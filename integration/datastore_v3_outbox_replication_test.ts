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
 * The commit outbox while replicating (swamp-club#3490): it lives beside the
 * checkout's own copy of `commits.db`, its fence chain records the lease a
 * writer takes once the copy is current, and a dead writer's entry is landed
 * by the next writer of that copy.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import { createCommitLogUnitOfWork } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import {
  v3CommitsDbPath,
  v3OutboxPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { v3WriterFence } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import {
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

await initializeLogging({});

const ignore = SIDECAR_TESTS_IGNORED;

/** A pid no process has: above every platform's pid limit. */
const GONE_PID = 99_999_999;

Deno.test({
  name:
    "v3 outbox while replicating: beside the checkout's copy, its chain records the writer's lease, and a dead writer's entry lands on the next hold",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      const handle = v3DatastoreFor(env.repoDir, env.config);
      const copy = v3CommitsDbPath(env.datastorePath, env.repoDir);
      assert(dirname(copy) !== env.datastorePath, "a copy of its own");
      assertEquals(handle.outbox.path, v3OutboxPath(copy));
      const fence = v3WriterFence(env.datastorePath)!;
      assertEquals((await handle.outbox.chain())?.lastFence, fence);

      // A writer of this copy prepares a commit and dies before its append.
      const id = crypto.randomUUID();
      const unit = createCommitLogUnitOfWork(() => Promise.resolve(), {
        sink: {
          head: (ns, p) => handle.commitStore.head(ns, p),
          append: () => Promise.reject(new Error("killed")),
          outbox: {
            headIdentity: (ns, p) => handle.commitStore.headIdentity(ns, p),
            prepare: (preparation) => handle.outbox.prepare(preparation),
            remove: () => Promise.resolve(),
            sweepState: () => handle.outbox.sweepState(Date.now()),
          },
        },
        chunkStore: handle.chunkStore,
        namespace: SOLO_NAMESPACE,
        writer: { host: Deno.hostname(), pid: GONE_PID, instance: "dead" },
        fence,
        signal: new AbortController().signal,
      });
      await unit.stageOps([
        new AutoDefinitionChanges(id).write(
          recordKeyOf(["auto-definitions", `${id}.yaml`]),
          new TextEncoder().encode("prepared"),
        ),
      ]);
      await unit.checkpoint().catch(() => {});
      assertEquals(await handle.outbox.hasEntries(), true);
      await closeV3Datastores();

      await holdV3Writer(env.config, env.repoDir);
      const next = v3DatastoreFor(env.repoDir, env.config);
      const landed = await next.commitStore.readPartition(
        "",
        partitionOf({ kind: "definition", id }),
        1,
        10,
      );
      assertEquals(landed.length, 1);
      assertEquals(landed[0].commit.fence, v3WriterFence(env.datastorePath));
      assertEquals(await next.outbox.hasEntries(), false);
      assertEquals(
        (await next.outbox.chain())?.lastFence,
        v3WriterFence(env.datastorePath),
      );
      await closeV3Datastores();
    });
  },
});
