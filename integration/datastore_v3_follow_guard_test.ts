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
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  setV3FollowWorkForTesting,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { holdsV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

/** copy work that ends only when aborted, as a restore stuck in its I/O */
function hangingFollow() {
  const state = { starts: 0, aborted: 0 };
  setV3FollowWorkForTesting((signal) => {
    state.starts++;
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        state.aborted++;
        resolve();
      }, { once: true });
    });
  });
  return state;
}

function abortedAfter(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function withDatastore(
  fn: (env: {
    datastorePath: string;
    repoDir: string;
    config: { type: "filesystem"; path: string };
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-follow-guard-" }),
  );
  const datastorePath = join(root, "ds");
  await initializeV3Datastore(datastorePath, "test");
  const repoDir = join(root, "repo");
  await Deno.mkdir(repoDir, { recursive: true });
  try {
    await fn({
      datastorePath,
      repoDir,
      config: { type: "filesystem", path: datastorePath },
    });
  } finally {
    setV3FollowWorkForTesting(undefined);
    await closeV3Datastores().catch(() => {});
    await Deno.remove(root, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test({
  name:
    "holdV3Writer follow: the lease is never tried while this copy's follow still runs, one follow serves every take, and one past its hang bound is aborted before the lease is taken",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDatastore(async (env) => {
      const follow = hangingFollow();
      // another serve, alive on this host, leads
      const leader = await plantV3WriterLease(env.datastorePath, {
        pid: Deno.ppid,
      });
      const options = {
        retakeLost: true,
        follow: true,
        ownerCheck: { as: "serve" as const, address: undefined },
        abandonFollowAfterMs: 3_600_000,
      };
      assertEquals(
        await holdV3Writer(env.config, env.repoDir, {
          ...options,
          followSignal: abortedAfter(50),
        }),
        "follower",
      );
      assertEquals(follow.starts, 1);

      // the leader is gone, but this copy's restore may still install
      await leader.release();
      assertEquals(
        await holdV3Writer(env.config, env.repoDir, {
          ...options,
          followSignal: abortedAfter(50),
        }),
        "follower",
      );
      assertEquals(follow.starts, 1, "the follow in flight is shared");
      assertEquals(follow.aborted, 0);
      assertEquals(holdsV3WriterLock(env.datastorePath), false);

      // past its bound it is taken for hung, aborted, and the lease is tried
      assertEquals(
        await holdV3Writer(env.config, env.repoDir, {
          ...options,
          abandonFollowAfterMs: 0,
          followSignal: abortedAfter(5_000),
        }),
        "writer",
      );
      assertEquals(follow.aborted, 1);
      assert(holdsV3WriterLock(env.datastorePath));
    });
  },
});
