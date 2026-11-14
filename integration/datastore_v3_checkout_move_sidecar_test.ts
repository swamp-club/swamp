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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  closeV3Datastores,
  holdV3Writer,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { v3CommitsDbPath } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  readPresence,
  replicationPathsFor,
} from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  commitCount,
  commitIn,
  killSidecarAtTeardown,
  presenceOf,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
  writeCommand,
} from "./datastore_v3_litestream_helpers.ts";

Deno.test({
  name:
    "v3 replication: a checkout moved while its sidecar runs ends with one sidecar for the copy, replicating where the copy now is (swamp-club#4702)",
  ignore: SIDECAR_TESTS_IGNORED,
  async fn() {
    await withReplicationEnv(async (env) => {
      await writeCommand(env, 2);
      const before = await presenceOf(env);
      assert(before !== undefined, "the sidecar is up before the move");

      const movedRepo = join(env.root, "repo-moved");
      const movedStore = join(env.root, "ds-moved");
      await Deno.rename(env.repoDir, movedRepo);
      await Deno.rename(env.datastorePath, movedStore);
      const moved = {
        repoDir: movedRepo,
        config: { type: "filesystem" as const, path: movedStore },
      };
      const pids = new Set<number>([before.supervisorPid]);
      try {
        await holdV3Writer(moved.config, moved.repoDir);
        await commitIn(moved, 1);
        await closeV3Datastores();

        const commitsDb = v3CommitsDbPath(movedStore, movedRepo);
        const paths = await replicationPathsFor(commitsDb, env.privateRoot);
        const after = await readPresence(paths);
        assert(after.kind === "found", "a sidecar replicates the moved copy");
        pids.add(after.record.supervisorPid);
        const live = [...pids].filter((pid) =>
          hostLitestreamProcesses.isAlive(pid)
        );
        assertEquals(live, [after.record.supervisorPid]);
        assertEquals(commitCount(commitsDb), 3);
      } finally {
        for (const pid of pids) killSidecarAtTeardown(pid);
      }
    });
  },
});
