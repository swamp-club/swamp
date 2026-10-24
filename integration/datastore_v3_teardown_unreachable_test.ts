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
 * The v3 teardown once the datastore's storage is unreachable
 * (swamp-club#3802), against a real Litestream sidecar whose control answers
 * are faked: a closing sync that would wait out its deadline is given up as
 * soon as a probe of the storage cannot reach it, and a command that already
 * found the storage unreachable gives its closing sync a short deadline.
 *
 * Like the other sidecar tests, these spawn the supervisor and Litestream,
 * the components under test, and kill them afterwards.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { V3ReplicationError } from "../src/domain/datastore_v3/litestream_replication.ts";
import type { DatastoreStorage } from "../src/domain/datastore/datastore_storage.ts";
import {
  LitestreamControlError,
  unixLitestreamControl,
} from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import { setV3DatastoreFaultsForTesting } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  setV3TeardownTimingForTesting,
  UNREACHABLE_SYNC_DEADLINE_MS,
  v3CommandCommits,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { closeV3DatastoresAfterSuccess } from "../src/cli/v3_teardown.ts";
import { V3ReplicationUnavailableError } from "../src/domain/datastore_v3/litestream_replication.ts";
import {
  commitIn,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

/**
 * A deadline a sync that is given up never reaches: one that is not given
 * up fails at it, as a timeout, instead of hanging the test.
 */
const NEVER_MS = 30_000;

/** Storage whose `has` is refused, as an unreachable bucket refuses it, while `down.on`. */
function probedStorage(
  down: { on: boolean },
  probes: { count: number },
): (storage: DatastoreStorage) => DatastoreStorage {
  return (storage) =>
    new Proxy(storage, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "has") return value.bind(target);
        return (...args: unknown[]) => {
          probes.count++;
          return down.on
            ? Promise.reject(
              new Error("S3 headObject failed", {
                cause: Object.assign(new Error("connect ECONNREFUSED"), {
                  code: "ECONNREFUSED",
                }),
              }),
            )
            : value.apply(target, args);
        };
      },
    });
}

/**
 * A sync that answers only when given up, recording the signal it got, or
 * times out at its deadline as the real client does.
 */
function hangingSync(signals: (AbortSignal | undefined)[]) {
  return (
    _socket: string,
    _db: string,
    deadline: number,
    signal?: AbortSignal,
  ) => {
    signals.push(signal);
    return new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new LitestreamControlError(
            `POST /sync got no answer within ${deadline} ms`,
            true,
          ),
        );
      }, deadline);
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

Deno.test({
  name:
    "v3 teardown: a closing sync whose storage a probe cannot reach is given up as a definite failure (swamp-club#3802)",
  ignore,
  async fn() {
    const down = { on: false };
    const probes = { count: 0 };
    const signals: (AbortSignal | undefined)[] = [];
    setV3DatastoreFaultsForTesting({
      wrapStorage: probedStorage(down, probes),
    });
    setV3TeardownTimingForTesting({ probeGraceMs: 0, releaseBoundMs: 0 });
    try {
      await withReplicationEnv(async (env) => {
        await holdV3Writer(env.config, env.repoDir);
        await commitIn(env, 1);
        down.on = true;
        const error = await assertRejects(
          () => closeV3Datastores(),
          V3ReplicationError,
        );
        assert(
          error.message.includes("storage could not be reached"),
          error.message,
        );
        assertEquals(signals.length, 1);
        assertEquals(signals[0]?.aborted, true);
        assert(probes.count > 0, "the storage was probed");
      }, {
        syncDeadlineMs: NEVER_MS,
        deps: {
          control: {
            info: unixLitestreamControl.info,
            sync: hangingSync(signals),
          },
        },
      });
    } finally {
      setV3TeardownTimingForTesting(undefined);
      setV3DatastoreFaultsForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "v3 teardown: a closing sync whose storage answers the probe keeps its deadline and confirms (swamp-club#3802)",
  ignore,
  async fn() {
    const probes = { count: 0 };
    const signals: (AbortSignal | undefined)[] = [];
    setV3DatastoreFaultsForTesting({
      wrapStorage: probedStorage({ on: false }, probes),
    });
    setV3TeardownTimingForTesting({ probeGraceMs: 0, releaseBoundMs: 0 });
    try {
      await withReplicationEnv(async (env) => {
        await holdV3Writer(env.config, env.repoDir);
        await commitIn(env, 1);
        await closeV3Datastores();
        assertEquals(signals.length, 1);
        assertEquals(signals[0]?.aborted, false);
      }, {
        syncDeadlineMs: NEVER_MS,
        deps: {
          control: {
            info: unixLitestreamControl.info,
            // Answers once the probe has had its answer.
            sync: async (socket, db, deadline, signal) => {
              signals.push(signal);
              await waitFor(() => probes.count > 0, "the probe to run");
              return await unixLitestreamControl.sync(socket, db, deadline);
            },
          },
        },
      });
    } finally {
      setV3TeardownTimingForTesting(undefined);
      setV3DatastoreFaultsForTesting(undefined);
    }
  },
});

Deno.test({
  name:
    "v3 teardown: a command that found the storage unreachable gives its closing sync the short deadline and probes nothing (swamp-club#3802)",
  ignore,
  async fn() {
    const probes = { count: 0 };
    const deadlines: number[] = [];
    setV3DatastoreFaultsForTesting({
      wrapStorage: probedStorage({ on: false }, probes),
    });
    try {
      await withReplicationEnv(async (env) => {
        await holdV3Writer(env.config, env.repoDir);
        await commitIn(env, 1);
        const before = probes.count;
        await closeV3Datastores({ storageUnreachable: true });
        assertEquals(deadlines, [UNREACHABLE_SYNC_DEADLINE_MS]);
        assertEquals(probes.count, before, "nothing was probed");
      }, {
        syncDeadlineMs: NEVER_MS,
        deps: {
          control: {
            info: unixLitestreamControl.info,
            sync: (socket, db, deadline) => {
              deadlines.push(deadline);
              return unixLitestreamControl.sync(socket, db, deadline);
            },
          },
        },
      });
    } finally {
      setV3DatastoreFaultsForTesting(undefined);
    }
  },
});

/** A sidecar whose sync fails: Litestream answers with an error. */
const FAILING_SYNC = {
  control: {
    info: unixLitestreamControl.info,
    sync: () =>
      Promise.reject(new LitestreamControlError("replica write failed", false)),
  },
};

Deno.test({
  name:
    "v3 teardown: a closing sync that fails after the command committed keeps the saved-locally error (swamp-club#3882)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      assertEquals(v3CommandCommits(), {
        committed: false,
        datastorePath: env.config.path,
      });
      await commitIn(env, 1);
      assertEquals(v3CommandCommits(), { committed: true });
      await assertRejects(
        () => closeV3DatastoresAfterSuccess(),
        V3ReplicationError,
        "saved locally",
      );
    }, { syncDeadlineMs: NEVER_MS, deps: FAILING_SYNC });
  },
});

Deno.test({
  name:
    "v3 teardown: a closing sync that fails after the command committed nothing says nothing was changed (swamp-club#3882)",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir);
      const error = await assertRejects(
        () => closeV3DatastoresAfterSuccess(),
        V3ReplicationUnavailableError,
        "Nothing was changed.",
      );
      assert(!error.message.includes("saved locally"), error.message);
    }, { syncDeadlineMs: NEVER_MS, deps: FAILING_SYNC });
  },
});
