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

// Parallel runs in one process each hold a per-model lock and each start a
// nested structural command. Each nested drain skips its own run's lock and
// waits on the others', which are held until their own nested commands
// exit, so without help they all wait until the lock timeout
// (swamp-club#2981). Wires the real lock files written by acquireModelLocks,
// the process marker's held-lock scopes, the env each child swamp would
// inherit, and the drain-wait markers on disk, with no subprocess: each
// child is a LockHolderMarker over that env.

import { assertEquals, assertInstanceOf } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  acquireModelLocks,
  type ModelLockResult,
  resolveDatastoreForRepo,
  runUnderModelLocks,
  waitForPerModelLocks,
} from "../src/cli/repo_context.ts";
import {
  type FilesystemDatastoreConfig,
  isCustomDatastoreConfig,
} from "../src/domain/datastore/datastore_config.ts";
import { LockWaitCycleError } from "../src/domain/datastore/distributed_lock.ts";
import {
  type LockHolderEnvStore,
  LockHolderMarker,
  processLockHolderMarker,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../src/domain/datastore/lock_holder_marker.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DRAIN_WAITS_DIR } from "../src/infrastructure/persistence/drain_wait_store.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const MODEL_TYPE = "test/drain-wait-cycle";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-drain-wait-cycle-" });
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

async function initRepo(repoDir: string): Promise<FilesystemDatastoreConfig> {
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  if (isCustomDatastoreConfig(datastoreConfig)) {
    throw new Error("expected a filesystem datastore");
  }
  return datastoreConfig;
}

/** One run of the parent process: the lock it holds, released at most once. */
interface Run {
  readonly modelId: string;
  readonly lock: ModelLockResult;
  release(): Promise<void>;
}

async function startRun(
  datastoreConfig: FilesystemDatastoreConfig,
  repoDir: string,
): Promise<Run> {
  const modelId = crypto.randomUUID();
  const lock = await acquireModelLocks(datastoreConfig, [
    { modelType: MODEL_TYPE, modelId },
  ], repoDir);
  let released = false;
  return {
    modelId,
    lock,
    release: async () => {
      if (!released) {
        released = true;
        await lock.release();
      }
    },
  };
}

/**
 * The lock-holder marker of a swamp started from within the scopes of
 * `runs`, outermost first: it inherits the locks those runs hold.
 */
async function childOf(
  pid: number,
  ...runs: Run[]
): Promise<LockHolderMarker> {
  const spawn = (remaining: Run[]): Promise<Record<string, string>> =>
    remaining.length === 0
      ? Promise.resolve({
        [SWAMP_LOCK_ANCESTOR_PIDS]: String(Deno.pid),
        ...processLockHolderMarker.childLockEnv(),
      })
      : runUnderModelLocks(remaining[0].lock, () => spawn(remaining.slice(1)));
  const values = new Map(Object.entries(await spawn(runs)));
  const store: LockHolderEnvStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
  const child = new LockHolderMarker(store, pid);
  child.publish();
  return child;
}

/** A nested structural command's drain, and how it ended once it has. */
interface Drain {
  outcome: { error?: unknown } | undefined;
  readonly done: Promise<void>;
}

function startDrain(
  datastoreConfig: FilesystemDatastoreConfig,
  child: LockHolderMarker,
): Drain {
  const drain: Drain = {
    outcome: undefined,
    done: waitForPerModelLocks(
      datastoreConfig.path,
      datastoreConfig.namespace,
      { lockHolderMarker: child, pollIntervalMs: 5, progressWriter: () => {} },
    ).then(
      () => {
        drain.outcome = {};
      },
      (error) => {
        drain.outcome = { error };
      },
    ),
  };
  return drain;
}

async function markerFiles(
  datastoreConfig: FilesystemDatastoreConfig,
): Promise<string[]> {
  const names: string[] = [];
  try {
    const dir = join(
      datastoreConfig.path,
      datastoreConfig.namespace ?? "",
      DRAIN_WAITS_DIR,
    );
    for await (const entry of Deno.readDir(dir)) {
      names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names;
}

/**
 * Starts one nested drain per run, waits until all but one have given way,
 * ends the runs whose commands failed, and returns the drains.
 */
async function drainUnderParallelRuns(
  datastoreConfig: FilesystemDatastoreConfig,
  runs: Run[],
): Promise<Drain[]> {
  const drains: Drain[] = [];
  for (const [i, run] of runs.entries()) {
    drains.push(startDrain(datastoreConfig, await childOf(i + 1, run)));
  }
  await waitFor(
    () =>
      drains.filter((d) => d.outcome !== undefined).length >=
        runs.length - 1,
    "all but one nested drain to give way",
    { timeoutMs: 20_000 },
  );
  // A step whose nested command failed ends and releases its lock.
  for (const [i, drain] of drains.entries()) {
    if (drain.outcome !== undefined) {
      await runs[i].release();
    }
  }
  await Promise.all(drains.map((d) => d.done));
  return drains;
}

Deno.test("nested drain wait cycle: of two parallel runs' nested commands one gives way and the other proceeds", async () => {
  await withTempDir(async (repoDir) => {
    const datastoreConfig = await initRepo(repoDir);
    await withMockedEnv({
      [SWAMP_LOCK_HOLDER_TOKENS]: undefined,
      SWAMP_LOCK_TIMEOUT_MS: "30000",
    }, async () => {
      const runs = [
        await startRun(datastoreConfig, repoDir),
        await startRun(datastoreConfig, repoDir),
      ];
      try {
        const drains = await drainUnderParallelRuns(datastoreConfig, runs);

        const failed = drains.filter((d) => d.outcome?.error !== undefined);
        assertEquals(failed.length, 1);
        const error = failed[0].outcome?.error;
        assertInstanceOf(error, LockWaitCycleError);
        assertEquals(error.code, "lock_wait_cycle");
        assertEquals(error.opponentPid, Deno.pid);
        // It names the other run's lock, the one it could not outwait.
        const winner = runs[drains.findIndex((d) => !failed.includes(d))];
        assertEquals(error.message.includes(winner.modelId), true);
        assertEquals(await markerFiles(datastoreConfig), []);
      } finally {
        await Promise.all(runs.map((run) => run.release()));
      }
    });
  });
});

Deno.test("nested drain wait cycle: of three parallel runs' nested commands exactly one proceeds", async () => {
  await withTempDir(async (repoDir) => {
    const datastoreConfig = await initRepo(repoDir);
    await withMockedEnv({
      [SWAMP_LOCK_HOLDER_TOKENS]: undefined,
      SWAMP_LOCK_TIMEOUT_MS: "30000",
    }, async () => {
      const runs = [
        await startRun(datastoreConfig, repoDir),
        await startRun(datastoreConfig, repoDir),
        await startRun(datastoreConfig, repoDir),
      ];
      try {
        const drains = await drainUnderParallelRuns(datastoreConfig, runs);

        const errors = drains.map((d) => d.outcome?.error)
          .filter((error) => error !== undefined);
        assertEquals(errors.length, 2);
        for (const error of errors) {
          assertInstanceOf(error, LockWaitCycleError);
        }
        assertEquals(await markerFiles(datastoreConfig), []);
      } finally {
        await Promise.all(runs.map((run) => run.release()));
      }
    });
  });
});

Deno.test("nested drain wait cycle: a command nested deeper in the same run is waited for, not failed", async () => {
  await withTempDir(async (repoDir) => {
    const datastoreConfig = await initRepo(repoDir);
    await withMockedEnv({
      [SWAMP_LOCK_HOLDER_TOKENS]: undefined,
      SWAMP_LOCK_TIMEOUT_MS: "30000",
    }, async () => {
      // The outer run starts a structural command, and also a model method
      // run (the inner run) that starts one of its own.
      const outer = await startRun(datastoreConfig, repoDir);
      const inner = await startRun(datastoreConfig, repoDir);
      const unrelated = await startRun(datastoreConfig, repoDir);
      try {
        const shallow = startDrain(datastoreConfig, await childOf(1, outer));
        const deep = startDrain(
          datastoreConfig,
          await childOf(2, outer, inner),
        );
        // Both wait on the unrelated lock; the shallow one also waits on
        // the inner run's lock, which the deep one skips.
        const markersPublished = async () =>
          (await markerFiles(datastoreConfig))
            .filter((name) => name.endsWith(".json")).length === 2;
        await waitFor(markersPublished, "both drains to publish their wait", {
          timeoutMs: 20_000,
        });

        await unrelated.release();
        await deep.done;
        assertEquals(deep.outcome, {});
        assertEquals(shallow.outcome, undefined);

        // The deep command exits, so the inner run ends.
        await inner.release();
        await shallow.done;
        assertEquals(shallow.outcome, {});
        assertEquals(await markerFiles(datastoreConfig), []);
      } finally {
        await Promise.all(
          [outer, inner, unrelated].map((run) => run.release()),
        );
      }
    });
  });
});
