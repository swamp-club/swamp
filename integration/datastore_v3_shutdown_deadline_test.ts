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
  confirmV3CommandReplicated,
  holdV3Writer,
  startV3ReplicationUpkeep,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  commitIn,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

const NEVER_MS = 30_000;

interface SeenSync {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

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

Deno.test({
  name:
    "v3 replication: outside serve's shutdown a sync queued behind a probe's still gets its whole deadline once that one settles (swamp-club#3961)",
  ignore,
  async fn() {
    const deadlines: number[] = [];
    let probeHeld = false;
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      await commitIn(env, 1);
      const upkeep = startV3ReplicationUpkeep(env.repoDir, env.config, {
        probeIntervalMs: 100,
      });
      try {
        await waitFor(() => probeHeld, "the probe to start a sync");
        await commitIn(env, 1);
        await confirmV3CommandReplicated();
        // A later probe's sync can land after this one, so it need not be last.
        assert(deadlines.includes(500), `the deadlines were ${deadlines}`);
      } finally {
        await upkeep.stop({ waitMs: 5_000 });
      }
      await closeV3Datastores();
    }, {
      syncDeadlineMs: 500,
      deps: {
        control: {
          info: unixLitestreamControl.info,
          sync: async (socket, db, deadlineMs, signal) => {
            deadlines.push(deadlineMs);
            if (!probeHeld) {
              probeHeld = true;
              await new Promise((resolve) => setTimeout(resolve, 900));
            }
            return await unixLitestreamControl.sync(
              socket,
              db,
              NEVER_MS,
              signal,
            );
          },
        },
      },
    });
  },
});
