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
import type { ReplicaPathStore } from "../../../domain/datastore/replica_path_store.ts";
import { UserError } from "../../../domain/errors.ts";
import { initializeLogging } from "../../logging/logger.ts";
import { withMockedEnv } from "../../persistence/path_test_helpers.ts";
import { isNetworkFailure } from "../network_failure.ts";
import {
  V3RestoredDatabaseCorruptError,
  V3RestoredDatabaseRefusedError,
  V3RestoreError,
} from "./litestream_restorer.ts";
import {
  replicaUnreachableAfterFailure,
  RESTORE_PROBE_ENV_VAR,
  restoreProbeMs,
  restoreWhileWatched,
  setV3RestoreWatchForTesting,
  V3ReplicaUnreachableError,
} from "./restore_watch.ts";

await initializeLogging({});

/** A refusal from the network, as a dropped connection gives. */
function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
    code: "ECONNREFUSED",
  });
}

/** A store whose listings answer as `answer` says, counting them. */
function scriptedStore(answer: (call: number) => Promise<string[]>) {
  let calls = 0;
  const store: ReplicaPathStore = {
    list: () => answer(++calls),
    removePath: () => Promise.reject(new Error("never removes")),
  };
  return { store, calls: () => calls };
}

/** A restore that waits until its signal aborts or `release` is called. */
function pendingRestore() {
  let release: () => void = () => {};
  let seen: AbortSignal | undefined;
  const restore = (signal: AbortSignal | undefined) => {
    seen = signal;
    return new Promise<string>((resolve, reject) => {
      release = () => resolve("restored");
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  return { restore, release: () => release(), signal: () => seen };
}

async function withWatchTiming(
  fn: () => Promise<void>,
  intervalMs = 0,
): Promise<void> {
  setV3RestoreWatchForTesting({
    timing: { graceMs: 0, probeMs: 50, intervalMs },
  });
  try {
    await fn();
  } finally {
    setV3RestoreWatchForTesting(undefined);
  }
}

Deno.test("restoreWhileWatched: two listings in a row the network refuses stop the restore with a network-classified error (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const { store, calls } = scriptedStore(() => Promise.reject(refused()));
    const restore = pendingRestore();
    const error = await assertRejects(
      () => restoreWhileWatched(store, restore.restore),
      V3ReplicaUnreachableError,
    );
    assertEquals(calls(), 2);
    assertEquals(restore.signal()?.aborted, true);
    assert(isNetworkFailure(error), "the error is a network failure");
  });
});

Deno.test("restoreWhileWatched: a listing that never answers, ignoring its signal, counts as a failure at its deadline (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const { store, calls } = scriptedStore(() => new Promise(() => {}));
    const restore = pendingRestore();
    await assertRejects(
      () => restoreWhileWatched(store, restore.restore),
      V3ReplicaUnreachableError,
    );
    assertEquals(calls(), 2);
  });
});

Deno.test("restoreWhileWatched: one failed listing followed by answers lets the restore finish (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const { store, calls } = scriptedStore((call) =>
      call === 1 ? Promise.reject(refused()) : Promise.resolve([])
    );
    const restore = pendingRestore();
    const restoring = restoreWhileWatched(store, restore.restore);
    await waitFor(() => calls() >= 4, "the watch to list past the failure");
    restore.release();
    assertEquals(await restoring, "restored");
    assertEquals(restore.signal()?.aborted, false);
  });
});

Deno.test("restoreWhileWatched: once a listing answered, listings that only run past their bound never stop the restore; refusals still do (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const slow = scriptedStore((call) =>
      call === 1 ? Promise.resolve([]) : new Promise(() => {})
    );
    const restore = pendingRestore();
    const restoring = restoreWhileWatched(slow.store, restore.restore);
    await waitFor(() => slow.calls() >= 4, "the watch to list past its bound");
    restore.release();
    assertEquals(await restoring, "restored");

    const cut = scriptedStore((call) =>
      call === 1 ? Promise.resolve([]) : Promise.reject(refused())
    );
    await assertRejects(
      () => restoreWhileWatched(cut.store, pendingRestore().restore),
      V3ReplicaUnreachableError,
    );
  });
});

Deno.test("restoreWhileWatched: listings refused other than by the network never stop the restore (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const { store, calls } = scriptedStore(() =>
      Promise.reject(new Error("AccessDenied"))
    );
    const restore = pendingRestore();
    const restoring = restoreWhileWatched(store, restore.restore);
    await waitFor(() => calls() >= 4, "the watch to list several times");
    restore.release();
    assertEquals(await restoring, "restored");
  });
});

Deno.test("restoreWhileWatched: the restore's own error is thrown as it is (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const { store } = scriptedStore(() => Promise.resolve([]));
    const failure = new Error("litestream failed");
    const thrown = await assertRejects(() =>
      restoreWhileWatched(store, () => Promise.reject(failure))
    );
    assertEquals(thrown, failure);
  });
});

Deno.test("restoreWhileWatched: without a store the restore runs unwatched, with no signal (swamp-club#3893)", async () => {
  const restore = pendingRestore();
  const restoring = restoreWhileWatched(undefined, restore.restore);
  restore.release();
  assertEquals(await restoring, "restored");
  assertEquals(restore.signal(), undefined);
});

Deno.test("replicaUnreachableAfterFailure: a listing the network refuses after a failed restore names the replica unreachable; a refusal or no store does not (swamp-club#3893)", async () => {
  await withWatchTiming(async () => {
    const failed = new Error("litestream failed");
    const cut = scriptedStore(() => Promise.reject(refused()));
    const error = await replicaUnreachableAfterFailure(cut.store, failed);
    assert(error instanceof V3ReplicaUnreachableError);
    assert(isNetworkFailure(error), "the error is a network failure");
    const hung = scriptedStore(() => new Promise(() => {}));
    assert(
      await replicaUnreachableAfterFailure(hung.store, failed) instanceof
        V3ReplicaUnreachableError,
    );
    const denied = scriptedStore(() =>
      Promise.reject(new Error("AccessDenied"))
    );
    assertEquals(
      await replicaUnreachableAfterFailure(denied.store, failed),
      undefined,
    );
    const fine = scriptedStore(() => Promise.resolve([]));
    assertEquals(
      await replicaUnreachableAfterFailure(fine.store, failed),
      undefined,
    );
    assertEquals(
      await replicaUnreachableAfterFailure(undefined, failed),
      undefined,
    );
  });
});

Deno.test("restoreWhileWatched: a listing the network refuses is followed by the interval, not a second listing at once, so one blip never stops a restore (swamp-club#4092)", async () => {
  await withWatchTiming(async () => {
    const { store, calls } = scriptedStore(() => Promise.reject(refused()));
    const restore = pendingRestore();
    const restoring = restoreWhileWatched(store, restore.restore);
    await waitFor(() => calls() >= 1, "the first listing");
    // The second listing is an interval away; the restore ends first.
    restore.release();
    assertEquals(await restoring, "restored");
    assertEquals(calls(), 1);
    assertEquals(restore.signal()?.aborted, false);
  }, 60_000);
});

Deno.test("restoreWhileWatched: two listings the network refuses an interval apart stop the restore (swamp-club#4092)", async () => {
  await withWatchTiming(async () => {
    const { store, calls } = scriptedStore(() => Promise.reject(refused()));
    const restore = pendingRestore();
    await assertRejects(
      () => restoreWhileWatched(store, restore.restore),
      V3ReplicaUnreachableError,
    );
    assertEquals(calls(), 2);
  }, 20);
});

Deno.test("restoreProbeMs: SWAMP_V3_RESTORE_PROBE_MS sets the listing bound; unset or not a positive integer leaves 4 s (swamp-club#4092)", () => {
  const probe = (value: string | undefined) =>
    withMockedEnv({ [RESTORE_PROBE_ENV_VAR]: value }, () => restoreProbeMs());
  assertEquals(probe(undefined), 4_000);
  assertEquals(probe("15000"), 15_000);
  assertEquals(probe("0"), 4_000);
  assertEquals(probe("-5"), 4_000);
  assertEquals(probe("soon"), 4_000);
  assertEquals(probe(""), 4_000);
});

Deno.test("replicaUnreachableAfterFailure: bounds its listing by SWAMP_V3_RESTORE_PROBE_MS when no test timing is set (swamp-club#4092)", async () => {
  const hung = scriptedStore(() => new Promise(() => {}));
  // With the default 4 s bound the hung listing would hold this test 4 s;
  // the variable's 20 ms ends it at once.
  const error = await withMockedEnv(
    { [RESTORE_PROBE_ENV_VAR]: "20" },
    () => replicaUnreachableAfterFailure(hung.store, new Error("failed")),
  );
  assert(error instanceof V3ReplicaUnreachableError);
  assertEquals(hung.calls(), 1);
});

Deno.test("replicaUnreachableAfterFailure: a restore failure not about reaching storage lists nothing and is not named unreachable (swamp-club#4092)", async () => {
  await withWatchTiming(async () => {
    for (
      const failure of [
        new UserError("the datastore config was refused"),
        new V3RestoredDatabaseRefusedError("the restored schema is newer"),
        new V3RestoredDatabaseCorruptError("integrity check failed"),
      ]
    ) {
      const cut = scriptedStore(() => Promise.reject(refused()));
      assertEquals(
        await replicaUnreachableAfterFailure(cut.store, failure),
        undefined,
        failure.name,
      );
      assertEquals(cut.calls(), 0, failure.name);
    }
  });
});

Deno.test("replicaUnreachableAfterFailure: Litestream failing to download, a V3RestoreError, is still followed by a listing (swamp-club#4092)", async () => {
  await withWatchTiming(async () => {
    const cut = scriptedStore(() => Promise.reject(refused()));
    const error = await replicaUnreachableAfterFailure(
      cut.store,
      new V3RestoreError("litestream could not restore lineage 000000000001"),
    );
    assert(error instanceof V3ReplicaUnreachableError);
    assertEquals(cut.calls(), 1);
  });
});
