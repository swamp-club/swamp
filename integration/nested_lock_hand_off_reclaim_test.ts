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

// A run lends its per-model locks to a hop (a shell command, a dispatch
// attempt). When the hop ends, whatever it left running must stop skipping
// those locks while the run writes (swamp-club#3111). Wires the real lock
// files written by acquireModelLocks, the process marker's hand-offs, the
// real global lock a structural command holds, and its real drain, with no
// subprocess: the nested swamp is a drain over a LockHolderMarker built on
// the env the hop was lent.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  acquireModelLocks,
  datastoreGlobalLockOptions,
  type ModelLockResult,
  resolveDatastoreForRepo,
  runUnderModelLocks,
  waitForPerModelLocks,
} from "../src/cli/repo_context.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../src/domain/datastore/datastore_config.ts";
import { LockTimeoutError } from "../src/domain/datastore/distributed_lock.ts";
import {
  type LockHolderEnvStore,
  LockHolderMarker,
  processLockHolderMarker,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_TOKENS,
  withRemoteLockHolder,
} from "../src/domain/datastore/lock_holder_marker.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-hand-off-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

type FilesystemDatastore = Exclude<
  DatastoreConfig,
  { type: string; datastorePath: string }
>;

interface Fixture {
  datastore: { path: string; namespace?: string };
  /** The locks one run took on one model, and what its reclaim printed. */
  locks: ModelLockResult;
  reclaimLines: string[];
  /** The global lock a structural command on this datastore takes. */
  globalLock: () => FileLock;
}

/** A repo with one run holding one model's lock, torn down afterwards. */
async function withHeldLock(
  env: Record<string, string | undefined>,
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  await withTempDir(async (repoDir) => {
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    await withMockedEnv(
      { [SWAMP_LOCK_HOLDER_TOKENS]: undefined, ...env },
      async () => {
        const reclaimLines: string[] = [];
        const locks = await acquireModelLocks(
          datastoreConfig,
          [{ modelType: "test/hand-off", modelId: crypto.randomUUID() }],
          repoDir,
          undefined,
          undefined,
          (line) => reclaimLines.push(line),
        );
        try {
          await fn({
            datastore: datastoreConfig,
            locks,
            reclaimLines,
            globalLock: () =>
              new FileLock(datastoreConfig.path, {
                ...datastoreGlobalLockOptions(datastoreConfig),
                ttlMs: 60_000,
              }),
          });
        } finally {
          await locks.release();
        }
      },
    );
  });
}

/**
 * The env of a swamp a shell hop of this process started with `lent`: the
 * hop's lock list, under this process as its ancestor.
 */
function shellChild(lent: Record<string, string>): Record<string, string> {
  return { ...lent, [SWAMP_LOCK_ANCESTOR_PIDS]: String(Deno.pid) };
}

/** The marker of a nested swamp started with `env`. */
function nestedSwamp(env: Record<string, string>): LockHolderMarker {
  const values = new Map(Object.entries(env));
  const store: LockHolderEnvStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
  const marker = new LockHolderMarker(store, 1);
  marker.publish();
  return marker;
}

/** One drain of a nested swamp with `env`, as a structural command runs it. */
function drain(
  fixture: Fixture,
  env: Record<string, string>,
  options: {
    lines?: string[];
    publishSkipping?: (lockIds: readonly string[]) => Promise<void>;
  } = {},
): Promise<readonly string[]> {
  return waitForPerModelLocks(
    fixture.datastore.path,
    fixture.datastore.namespace,
    {
      lockHolderMarker: nestedSwamp(env),
      pollIntervalMs: 5,
      progressWriter: (line) => options.lines?.push(line),
      publishSkipping: options.publishSkipping,
    },
  );
}

const heldNonce = (fixture: Fixture): string =>
  fixture.locks.lentLocks.lockIds()[0];

Deno.test("lock hand-off: once the hop ends, a swamp it left running waits on the lock it used to skip", async () => {
  await withHeldLock({}, async (fixture) => {
    let lent: Record<string, string> = {};
    await runUnderModelLocks(fixture.locks, async () => {
      const hop = await processLockHolderMarker.beginChildHandOff();
      lent = shellChild(hop.lent);
      const lentNonce = heldNonce(fixture);
      // While the hop runs, its nested structural command skips the lock.
      assertEquals(await drain(fixture, lent), [lentNonce]);

      await hop.end();
      assertNotEquals(heldNonce(fixture), lentNonce);
    });

    // The hop is over; the same swamp, still running, now has to wait.
    const lines: string[] = [];
    let drained = false;
    const draining = drain(fixture, lent, { lines }).then((skipped) => {
      drained = true;
      return skipped;
    });
    await waitFor(
      () => lines.some((line) => line.includes("Waiting for 1 per-model")),
      "the abandoned drain to start waiting",
    );
    assertEquals(drained, false);

    await fixture.locks.release();
    assertEquals(await draining, []);
  });
});

Deno.test("lock hand-off: the run waits for a structural command still working under the lock, then proceeds", async () => {
  await withHeldLock({}, async (fixture) => {
    await runUnderModelLocks(fixture.locks, async () => {
      const hop = await processLockHolderMarker.beginChildHandOff();
      const lentNonce = heldNonce(fixture);

      // The nested structural command takes the global lock, skips the
      // run's lock and starts work.
      const global = fixture.globalLock();
      await global.acquire();
      const skipped = await drain(fixture, shellChild(hop.lent), {
        publishSkipping: (lockIds) => global.publishSkipping(lockIds),
      });
      assertEquals(skipped, [lentNonce]);
      assertEquals((await global.inspect())?.skipping, [lentNonce]);

      // The hop returns with that command still working.
      let ended = false;
      const ending = hop.end().then(() => {
        ended = true;
      });
      await waitFor(
        () =>
          fixture.reclaimLines.some((line) => line.includes("still working")),
        "the run to wait on the structural command",
      );
      assertEquals(ended, false);
      // Re-keyed already, so nothing new can skip it meanwhile.
      assertNotEquals(heldNonce(fixture), lentNonce);

      await global.release();
      await ending;
    });
  });
});

Deno.test("lock hand-off: the run fails instead of writing when the structural command outlasts the lock timeout", async () => {
  await withHeldLock({ SWAMP_LOCK_TIMEOUT_MS: "20" }, async (fixture) => {
    await runUnderModelLocks(fixture.locks, async () => {
      const hop = await processLockHolderMarker.beginChildHandOff();
      const global = fixture.globalLock();
      await global.acquire();
      try {
        await drain(fixture, shellChild(hop.lent), {
          publishSkipping: (lockIds) => global.publishSkipping(lockIds),
        });
        await assertRejects(() => hop.end(), LockTimeoutError);
      } finally {
        await global.release();
      }
    });
  });
});

Deno.test("lock hand-off: a structural command that finds its skipped lock re-keyed withdraws it and waits, so neither waits on the other", async () => {
  await withHeldLock({}, async (fixture) => {
    await runUnderModelLocks(fixture.locks, async () => {
      const hop = await processLockHolderMarker.beginChildHandOff();
      const lentNonce = heldNonce(fixture);
      const global = fixture.globalLock();
      await global.acquire();

      // The hop ends between the command publishing what it skips and its
      // confirming scan.
      const published: string[][] = [];
      let ending: Promise<void> | undefined;
      let drained = false;
      const draining = drain(fixture, shellChild(hop.lent), {
        publishSkipping: async (lockIds) => {
          published.push([...lockIds]);
          await global.publishSkipping(lockIds);
          if (ending === undefined) {
            ending = hop.end();
            await waitFor(
              () => heldNonce(fixture) !== lentNonce,
              "the run to re-key its lock",
            );
          }
        },
      }).then((skipped) => {
        drained = true;
        return skipped;
      });

      // The command gave the lock up before waiting on it, so the run's
      // reclaim finishes while the command is still draining.
      await waitFor(() => ending !== undefined, "the hop to end");
      await ending;
      assertEquals(published, [[lentNonce], []]);
      assertEquals((await global.inspect())?.skipping, undefined);
      assertEquals(drained, false);

      await fixture.locks.release();
      assertEquals(await draining, []);
      await global.release();
    });
  });
});

Deno.test("lock hand-off: a lock is re-keyed only when the last of its concurrent hops ends", async () => {
  await withHeldLock({}, async (fixture) => {
    await runUnderModelLocks(fixture.locks, async () => {
      const one = await processLockHolderMarker.beginChildHandOff();
      const two = await processLockHolderMarker.beginChildHandOff();
      const lentNonce = heldNonce(fixture);

      await one.end();
      // The second hop's nested command still skips the lock.
      assertEquals(heldNonce(fixture), lentNonce);
      assertEquals(await drain(fixture, shellChild(two.lent)), [lentNonce]);

      await two.end();
      assertNotEquals(heldNonce(fixture), lentNonce);
    });
  });
});

Deno.test("lock hand-off: a re-dispatch is lent a new nonce, so the first attempt's swamp no longer matches", async () => {
  await withHeldLock({}, async (fixture) => {
    await runUnderModelLocks(fixture.locks, async () => {
      const dispatch = processLockHolderMarker.remoteHandOff();

      const first = await dispatch.begin();
      const firstIds = first.lent?.lockIds ?? [];
      assertEquals(firstIds, [heldNonce(fixture)]);
      // The worker is lost; the attempt's hand-off ends before the retry.
      await first.end();

      const retry = await dispatch.begin();
      const retryIds = retry.lent?.lockIds ?? [];
      assertEquals(retryIds, [heldNonce(fixture)]);
      assert(!retryIds.includes(firstIds[0]));

      // The lost runner's nested swamp was told the first nonce, on a
      // worker on this host and on one elsewhere; both now wait.
      const waiting: Promise<readonly string[]>[] = [];
      for (const workerHost of [hostname(), "another-host"]) {
        const lines: string[] = [];
        waiting.push(drain(
          fixture,
          withRemoteLockHolder({}, first.lent, workerHost),
          { lines },
        ));
        await waitFor(
          () => lines.some((line) => line.includes("Waiting for 1 per-model")),
          `the lost runner's drain on ${workerHost} to wait`,
        );
      }
      // The retry's own nested swamp skips the lock.
      assertEquals(
        await drain(fixture, withRemoteLockHolder({}, retry.lent, hostname())),
        retryIds,
      );
      await retry.end();
      await fixture.locks.release();
      await Promise.all(waiting);
    });
  });
});
