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
 * Serve's shutdown deadline over the v3 teardown (swamp-club#3961), against
 * a real Litestream sidecar whose sync answers are faked: the closing sync
 * gets what the deadline has left when it starts, a probe's sync the
 * upkeep's stop stops waiting for is aborted, and a closing sync queued
 * behind a probe's sync counts that wait against its own deadline.
 *
 * Like the other sidecar tests, these spawn the supervisor and Litestream,
 * the components under test, and kill them afterwards.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { V3ReplicationError } from "../src/domain/datastore_v3/litestream_replication.ts";
import {
  LitestreamControlError,
  unixLitestreamControl,
} from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import {
  setV3ClosingDeadline,
  v3ClosingDeadline,
} from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  startV3ReplicationUpkeep,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  commitIn,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

/** A deadline no sync in these tests is meant to reach. */
const NEVER_MS = 30_000;

/** A sync the test sees start. */
interface SeenSync {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/**
 * A sync that never answers: it fails at its deadline as a timeout, as the
 * real client does, or at once when its signal aborts.
 */
function hangingSync(seen: SeenSync[]) {
  return (
    _socket: string,
    _db: string,
    deadlineMs: number,
    signal?: AbortSignal,
  ) => {
    seen.push(signal === undefined ? { deadlineMs } : { deadlineMs, signal });
    return new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new LitestreamControlError(
            `POST /sync got no answer within ${deadlineMs} ms`,
            true,
          ),
        );
      }, deadlineMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(
          new LitestreamControlError(
            `POST /sync was given up: ${String(signal.reason)}`,
            false,
          ),
        );
      }, { once: true });
    });
  };
}

/** A shutdown deadline with `leftMs` left, whatever the time. */
function deadlineWith(leftMs: number) {
  return {
    remaining: (capMs?: number) =>
      capMs === undefined ? leftMs : Math.min(capMs, leftMs),
  };
}

Deno.test({
  name:
    "v3 teardown: the closing sync gets what serve's shutdown deadline has left when it starts (swamp-club#3961)",
  ignore,
  async fn() {
    const seen: SeenSync[] = [];
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      await commitIn(env, 1);
      setV3ClosingDeadline(deadlineWith(400));
      try {
        await assertRejects(() => closeV3Datastores(), V3ReplicationError);
      } finally {
        setV3ClosingDeadline(undefined);
      }
      assertEquals(seen.length, 1);
      assert(
        seen[0].deadlineMs > 0 && seen[0].deadlineMs <= 400,
        `the closing sync's deadline was ${seen[0].deadlineMs} ms`,
      );
    }, {
      syncDeadlineMs: NEVER_MS,
      deps: {
        control: { info: unixLitestreamControl.info, sync: hangingSync(seen) },
      },
    });
  },
});

Deno.test({
  name:
    "v3 teardown: closing the datastores clears serve's shutdown deadline (swamp-club#3961)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      await commitIn(env, 1);
      setV3ClosingDeadline(deadlineWith(NEVER_MS));
      try {
        await closeV3Datastores();
        assertEquals(v3ClosingDeadline(), undefined);
      } finally {
        setV3ClosingDeadline(undefined);
      }
    });
  },
});

Deno.test({
  name:
    "v3 replication: a bounded stop aborts the probe's sync it stops waiting for (swamp-club#3961)",
  ignore,
  async fn() {
    const seen: SeenSync[] = [];
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      const upkeep = startV3ReplicationUpkeep(env.repoDir, env.config, {
        probeIntervalMs: 100,
      });
      try {
        await waitFor(() => seen.length > 0, "the probe to start a sync");
      } finally {
        await upkeep.stop({ waitMs: 50 });
      }
      assertEquals(seen[0].signal?.aborted, true);
      setV3ClosingDeadline(deadlineWith(300));
      try {
        await assertRejects(() => closeV3Datastores(), V3ReplicationError);
      } finally {
        setV3ClosingDeadline(undefined);
      }
    }, {
      syncDeadlineMs: NEVER_MS,
      deps: {
        control: { info: unixLitestreamControl.info, sync: hangingSync(seen) },
      },
    });
  },
});

Deno.test({
  name:
    "v3 teardown: a closing sync queued behind a probe's sync gives up at its own deadline without syncing (swamp-club#3961)",
  ignore,
  async fn() {
    const seen: SeenSync[] = [];
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      const upkeep = startV3ReplicationUpkeep(env.repoDir, env.config, {
        probeIntervalMs: 100,
      });
      try {
        await waitFor(() => seen.length > 0, "the probe to start a sync");
        setV3ClosingDeadline(deadlineWith(300));
        const error = await assertRejects(
          () => closeV3Datastores(),
          V3ReplicationError,
        );
        assert(
          error.message.includes("an earlier sync"),
          error.message,
        );
        // The closing sync never started one of its own.
        assertEquals(seen.length, 1);
      } finally {
        setV3ClosingDeadline(undefined);
        await upkeep.stop({ waitMs: 0 });
      }
    }, {
      syncDeadlineMs: NEVER_MS,
      deps: {
        control: { info: unixLitestreamControl.info, sync: hangingSync(seen) },
      },
    });
  },
});
