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

// Two runs in one process hold per-model locks at the same time, as parallel
// workflow steps or concurrent `swamp serve` runs do. A nested swamp started
// by run A must skip A's lock and still wait on B's (swamp-club#2955). Wires
// the real lock files written by acquireModelLocks, the process marker's
// held-lock scopes, and the env a child swamp would inherit, with no
// subprocess: the child is a LockHolderMarker over that env.

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import {
  acquireModelLocks,
  type ModelLockResult,
  resolveDatastoreForRepo,
  runUnderModelLocks,
} from "../src/cli/repo_context.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import {
  type LockHolderEnvStore,
  LockHolderMarker,
  type LockOwner,
  type LockRelation,
  processLockHolderMarker,
  runAdoptingForwardedLocks,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../src/domain/datastore/lock_holder_marker.ts";
import { DispatchParamsSchema } from "../src/domain/remote/protocol.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { buildRunnerEnvironment } from "../src/worker/dispatch_handler.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-nested-lock-tokens-" });
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

async function initRepo(repoDir: string): Promise<void> {
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
}

/** The per-model lock files under `datastorePath`, by the model id they lock. */
async function lockFilesByModel(
  datastorePath: string,
  modelIds: readonly string[],
): Promise<Map<string, { path: string; owner: LockOwner }>> {
  const locks = new Map<string, { path: string; owner: LockOwner }>();
  for await (
    const entry of walk(datastorePath, {
      includeDirs: false,
      match: [/\.lock$/],
    })
  ) {
    const modelId = modelIds.find((id) => entry.path.includes(id));
    if (modelId === undefined) continue;
    const owner = JSON.parse(await Deno.readTextFile(entry.path)) as LockOwner;
    locks.set(modelId, { path: entry.path, owner });
  }
  return locks;
}

/** How a child swamp started with `childEnv` sees each locked model. */
function childRelations(
  childEnv: Record<string, string>,
  locks: Map<string, { owner: LockOwner }>,
  childHost?: string,
): Record<string, LockRelation> {
  const values = new Map(Object.entries(childEnv));
  const store: LockHolderEnvStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
  const child = childHost === undefined
    ? new LockHolderMarker(store, 1)
    : new LockHolderMarker(store, 1, () => childHost);
  child.publish();
  const relation = child.lockRelation();
  return Object.fromEntries(
    [...locks].map(([modelId, lock]) => [modelId, relation(lock.owner)]),
  );
}

Deno.test("nested lock holder tokens: a child of run A skips A's lock and waits on run B's", async () => {
  await withTempDir(async (repoDir) => {
    await initRepo(repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    const modelA = crypto.randomUUID();
    const modelB = crypto.randomUUID();

    await withMockedEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: undefined }, async () => {
      const lockA = await acquireModelLocks(datastoreConfig, [
        { modelType: "test/nested-lock", modelId: modelA },
      ], repoDir);
      const lockB = await acquireModelLocks(datastoreConfig, [
        { modelType: "test/nested-lock", modelId: modelB },
      ], repoDir);
      try {
        // Each run spawns its child while both runs hold their locks.
        const spawnFrom = (lock: ModelLockResult) =>
          runUnderModelLocks(lock, () =>
            Promise.resolve({
              [SWAMP_LOCK_ANCESTOR_PIDS]: String(Deno.pid),
              ...processLockHolderMarker.childLockEnv(),
            }));
        const [envA, envB] = await Promise.all([
          spawnFrom(lockA),
          spawnFrom(lockB),
        ]);
        const locks = await lockFilesByModel(datastoreConfig.path, [
          modelA,
          modelB,
        ]);

        assertEquals(childRelations(envA, locks), {
          [modelA]: "ancestor",
          [modelB]: "ancestor-other-run",
        });
        assertEquals(childRelations(envB, locks), {
          [modelA]: "ancestor-other-run",
          [modelB]: "ancestor",
        });

        // A child started outside any scope (an extension's own
        // Deno.Command) gets no list and skips both, as before.
        assertEquals(
          childRelations(
            { [SWAMP_LOCK_ANCESTOR_PIDS]: String(Deno.pid) },
            locks,
          ),
          { [modelA]: "ancestor", [modelB]: "ancestor" },
        );

        // A lock file without a nonce (an older swamp's) matches on the pid.
        const { path, owner } = locks.get(modelB)!;
        const { nonce: _nonce, ...withoutNonce } = owner;
        await Deno.writeTextFile(path, JSON.stringify(withoutNonce));
        const relaxed = await lockFilesByModel(datastoreConfig.path, [modelB]);
        assertEquals(childRelations(envA, relaxed), { [modelB]: "ancestor" });
      } finally {
        await lockB.flush();
        await lockA.flush();
      }
    });
  });
});

/**
 * The env of a swamp started by a shell step in a dispatch runner, for a
 * worker (`workerPid`) that is not a descendant of this process. `lockHolder`
 * crosses the wire as a dispatch would carry it.
 */
function nestedEnvOnWorker(
  lockHolder: unknown,
  workerPid: number,
  workerHost?: string,
): Record<string, string> {
  const dispatch = DispatchParamsSchema.parse(JSON.parse(JSON.stringify({
    dispatchId: "d-1",
    leaseId: "l-1",
    execution: {
      protocolVersion: 1,
      modelType: "test/nested-lock",
      modelId: "m-1",
      methodName: "execute",
      globalArgs: {},
      methodArgs: {},
      definitionMeta: { id: "m-1", name: "nested", version: 1, tags: {} },
    },
    bundleFingerprint: "builtin:test",
    // An orchestrator's own lock variables never reach the runner this way.
    environmentSnapshot: { [SWAMP_LOCK_ANCESTOR_PIDS]: String(Deno.pid) },
    lockHolder,
  })));
  const runnerEnv = new Map(Object.entries(buildRunnerEnvironment(
    { [SWAMP_LOCK_ANCESTOR_PIDS]: String(workerPid) },
    dispatch.environmentSnapshot,
    undefined,
    dispatch.lockHolder,
    workerHost,
  )));
  // The runner publishes its chain, then its shell step spawns the swamp.
  const runner = new LockHolderMarker({
    get: (key) => runnerEnv.get(key),
    set: (key, value) => {
      runnerEnv.set(key, value);
    },
  }, workerPid + 1);
  runner.publish();
  return {
    [SWAMP_LOCK_ANCESTOR_PIDS]: runnerEnv.get(SWAMP_LOCK_ANCESTOR_PIDS)!,
    ...runner.childLockEnv(),
  };
}

Deno.test("nested lock holder tokens: a swamp under a same-host worker skips its dispatched step's lock only (swamp-club#2983)", async () => {
  await withTempDir(async (repoDir) => {
    await initRepo(repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    const modelA = crypto.randomUUID();
    const modelB = crypto.randomUUID();
    const models = [modelA, modelB];
    // A worker started on its own: this process is not above it.
    const workerPid = Deno.pid + 1;
    const lockFor = (modelId: string) =>
      acquireModelLocks(datastoreConfig, [
        { modelType: "test/nested-lock", modelId },
      ], repoDir);

    await withMockedEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: undefined }, async () => {
      let lockA = await lockFor(modelA);
      const lockB = await lockFor(modelB);
      try {
        // The orchestrator dispatches step A while both steps hold locks.
        const lockHolder = await runUnderModelLocks(
          lockA,
          () => Promise.resolve(processLockHolderMarker.remoteLockHolder()),
        );
        const locks = await lockFilesByModel(datastoreConfig.path, models);

        assertEquals(
          childRelations(nestedEnvOnWorker(lockHolder, workerPid), locks),
          { [modelA]: "ancestor", [modelB]: "ancestor-other-run" },
        );

        // Without the hand-off it waits on both.
        assertEquals(
          childRelations(nestedEnvOnWorker(undefined, workerPid), locks),
          { [modelA]: "other", [modelB]: "other" },
        );

        // A worker on another host sharing the datastore skips the step's
        // lock on its nonce alone; the orchestrator is no ancestor there, so
        // its other lock is any other process's (swamp-club#3096).
        const onAnotherHost = nestedEnvOnWorker(
          lockHolder,
          workerPid,
          "another-host",
        );
        assertEquals(
          childRelations(onAnotherHost, locks, "another-host"),
          { [modelA]: "ancestor", [modelB]: "other" },
        );

        // The step's lock is released and the model locked again while the
        // nested swamp still runs: the new lock is not the one it may skip.
        await lockA.flush();
        lockA = await lockFor(modelA);
        const relocked = await lockFilesByModel(datastoreConfig.path, [modelA]);
        assertEquals(
          childRelations(nestedEnvOnWorker(lockHolder, workerPid), relocked),
          { [modelA]: "ancestor-other-run" },
        );
        assertEquals(
          childRelations(onAnotherHost, relocked, "another-host"),
          { [modelA]: "other" },
        );
      } finally {
        await lockB.flush();
        await lockA.flush();
      }
    });
  });
});

// A swamp whose own shell step started it holds no lock for the step it
// dispatches, or holds one alongside: the locks handed down to it travel
// with the dispatch, so a nested swamp on the worker skips those as well
// (swamp-club#3096).
Deno.test("nested lock holder tokens: a dispatch hands on the locks handed down to the orchestrator", async () => {
  await withTempDir(async (repoDir) => {
    await initRepo(repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    const upstreamModel = crypto.randomUUID();
    const stepModel = crypto.randomUUID();
    const otherModel = crypto.randomUUID();
    const models = [upstreamModel, stepModel, otherModel];
    const workerPid = Deno.pid + 1;
    const lockFor = (modelId: string) =>
      acquireModelLocks(datastoreConfig, [
        { modelType: "test/nested-lock", modelId },
      ], repoDir);

    const upstreamLock = await lockFor(upstreamModel);
    const stepLock = await lockFor(stepModel);
    const otherLock = await lockFor(otherModel);
    try {
      const locks = await lockFilesByModel(datastoreConfig.path, models);
      // The swamp above the orchestrator named its step's lock for it.
      const inherited = `${Deno.pid + 2}:${
        locks.get(upstreamModel)!.owner.nonce
      }`;
      await withMockedEnv(
        { [SWAMP_LOCK_HOLDER_TOKENS]: inherited },
        async () => {
          const expected = {
            [upstreamModel]: "ancestor",
            [stepModel]: "ancestor",
            [otherModel]: "other",
          };
          const lockHolder = await runUnderModelLocks(
            stepLock,
            () => Promise.resolve(processLockHolderMarker.remoteLockHolder()),
          );
          assertEquals(
            childRelations(
              nestedEnvOnWorker(lockHolder, workerPid, "another-host"),
              locks,
              "another-host",
            ),
            expected,
          );
          // Dispatched from outside any lock scope, it still hands them on.
          assertEquals(
            childRelations(
              nestedEnvOnWorker(
                processLockHolderMarker.remoteLockHolder(),
                workerPid,
                "another-host",
              ),
              locks,
              "another-host",
            ),
            { ...expected, [stepModel]: "other" },
          );
        },
      );
    } finally {
      await Promise.all([
        upstreamLock.flush(),
        stepLock.flush(),
        otherLock.flush(),
      ]);
    }
  });
});

// A step of a run hosted by `swamp serve` runs `swamp model method run
// --server` back into the same serve. The requested run starts in a request
// handler, outside the step's scope, so the client forwards the lock list it
// inherited and serve adopts it (swamp-club#2982). The client is a
// LockHolderMarker over the step's child env, and the request handler is
// plain code outside the step's scope.
Deno.test("nested lock holder tokens: a child of a run requested through --server skips the calling step's lock", async () => {
  await withTempDir(async (repoDir) => {
    await initRepo(repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    const stepModel = crypto.randomUUID();
    const requestedModel = crypto.randomUUID();
    const otherModel = crypto.randomUUID();
    const models = [stepModel, requestedModel, otherModel];

    await withMockedEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: undefined }, async () => {
      const lockFor = (modelId: string) =>
        acquireModelLocks(datastoreConfig, [
          { modelType: "test/nested-lock", modelId },
        ], repoDir);
      let stepLock = await lockFor(stepModel);
      const [requestedLock, otherLock] = await Promise.all(
        [requestedModel, otherModel].map(lockFor),
      );
      const childEnv = () => ({
        [SWAMP_LOCK_ANCESTOR_PIDS]: String(Deno.pid),
        ...processLockHolderMarker.childLockEnv(),
      });
      // The step and an unrelated run stay in their scopes, waiting, while
      // the request is handled.
      let finish = () => {};
      const waiting = new Promise<void>((resolve) => finish = resolve);
      let clientEnv: Record<string, string> = {};
      const step = runUnderModelLocks(stepLock, () => {
        clientEnv = childEnv();
        return waiting;
      });
      const otherRun = runUnderModelLocks(otherLock, () => waiting);
      /** How a child of the requested run sees each lock. */
      const requestedRunChild = async (forwarded: string | undefined) =>
        childRelations(
          await runAdoptingForwardedLocks(
            forwarded,
            () =>
              runUnderModelLocks(
                requestedLock,
                () => Promise.resolve(childEnv()),
              ),
          ),
          locks,
        );
      const waitsOnStep = {
        [stepModel]: "ancestor-other-run",
        [requestedModel]: "ancestor",
        [otherModel]: "ancestor-other-run",
      };
      let locks = new Map<string, { path: string; owner: LockOwner }>();
      try {
        locks = await lockFilesByModel(datastoreConfig.path, models);
        const clientValues = new Map(Object.entries(clientEnv));
        const client = new LockHolderMarker({
          get: (key) => clientValues.get(key),
          set: (key, value) => {
            clientValues.set(key, value);
          },
        }, 1);
        client.publish();
        const forwarded = client.forwardedLockTokens();
        const stepNonce = locks.get(stepModel)!.owner.nonce!;
        const otherNonce = locks.get(otherModel)!.owner.nonce!;
        assertEquals(forwarded, `${Deno.pid}:${stepNonce}`);

        // Without the forwarded list the child waits on the calling step.
        assertEquals(await requestedRunChild(undefined), waitsOnStep);

        assertEquals(await requestedRunChild(forwarded), {
          [stepModel]: "ancestor",
          [requestedModel]: "ancestor",
          [otherModel]: "ancestor-other-run",
        });

        // A nonce no lock file carries changes nothing. The step's nonce
        // is adopted whichever pid the list names it for: the caller may be
        // another swamp between the step and the client, or one on another
        // host (swamp-club#3096). A lock serve holds for another run is
        // adopted only when named.
        assertEquals(
          await requestedRunChild(`${Deno.pid}:${crypto.randomUUID()}`),
          waitsOnStep,
        );
        assertEquals(
          await requestedRunChild(`${Deno.pid + 1}:${stepNonce}`),
          {
            [stepModel]: "ancestor",
            [requestedModel]: "ancestor",
            [otherModel]: "ancestor-other-run",
          },
        );
        assertEquals(
          await requestedRunChild(`${Deno.pid}:${otherNonce}`),
          {
            [stepModel]: "ancestor-other-run",
            [requestedModel]: "ancestor",
            [otherModel]: "ancestor",
          },
        );

        finish();
        await Promise.all([step, otherRun]);
        // The step has ended and released its lock. A run that outlives the
        // request still carries the old nonce, which the model's next lock
        // does not match.
        await stepLock.flush();
        stepLock = await lockFor(stepModel);
        locks = await lockFilesByModel(datastoreConfig.path, models);
        assertEquals(await requestedRunChild(forwarded), waitsOnStep);
      } finally {
        finish();
        await Promise.all([step, otherRun]);
        await Promise.all([
          stepLock.flush(),
          requestedLock.flush(),
          otherLock.flush(),
        ]);
      }
    });
  });
});
