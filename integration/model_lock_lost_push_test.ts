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

// On an extension datastore (S3, GCS) each clone allocates the next data
// version from its own cache, and the model lock is what keeps two clones
// from allocating the same one. After `swamp datastore lock release --force`
// the old holder used to push anyway, over the version the new holder wrote
// under the same key: both runs exited 0 and one write was lost
// (swamp-club#3373). The old holder now refuses its push and fails.

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import type {
  DistributedLock,
  LockInfo,
  LockOptions,
} from "../src/domain/datastore/distributed_lock.ts";
import {
  ModelLockLostError,
  type WrittenVersion,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const modelType = ModelType.create("test/model-lock-lost");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-model-lock-lost-" });
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

/** Clone A's process; clone B's is pid + 1 on the same host. */
const PROCESS_A = { holder: "sam@host", hostname: "host", pid: 4100 };

/**
 * One bucket's lock objects: every clone's locks read and write it, as
 * S3Lock and GcsLock do the bucket. Both clones run in this test's process;
 * each stamps its lock bodies with the pid of the process it stands for.
 * `blind` locks read nothing, as a backend that cannot report its holder.
 */
class LockTable {
  readonly entries = new Map<string, LockInfo>();

  lockFor(pid: number, blind = false) {
    return (options?: LockOptions): DistributedLock => {
      const key = `${options?.namespace ?? ""}/${
        options?.lockKey ?? ".datastore.lock"
      }`;
      let nonce: string | undefined;
      const release = () => {
        if (
          nonce !== undefined && this.entries.get(key)?.nonce === nonce
        ) {
          this.entries.delete(key);
        }
        nonce = undefined;
        return Promise.resolve();
      };
      const acquire = () => {
        const current = this.entries.get(key);
        if (current) {
          return Promise.reject(
            new Error(`${key} is held by pid ${current.pid}`),
          );
        }
        nonce = crypto.randomUUID();
        this.entries.set(key, {
          ...PROCESS_A,
          pid,
          acquiredAt: new Date().toISOString(),
          ttlMs: 30_000,
          nonce,
        });
        return Promise.resolve();
      };
      return {
        acquire,
        release,
        withLock: async <T>(fn: () => Promise<T>) => {
          await acquire();
          try {
            return await fn();
          } finally {
            await release();
          }
        },
        inspect: () =>
          Promise.resolve(blind ? null : this.entries.get(key) ?? null),
        forceRelease: (expected: string) => {
          if (this.entries.get(key)?.nonce !== expected) {
            return Promise.resolve(false);
          }
          this.entries.delete(key);
          return Promise.resolve(true);
        },
      };
    };
  }

  /** `swamp datastore lock release --force --model …`. */
  breakglass(modelId: string): void {
    const keys = [...this.entries.keys()].filter((k) => k.includes(modelId));
    assertEquals(keys.length, 1, "the model lock should be held");
    this.entries.delete(keys[0]);
  }
}

async function initRepo(repoDir: string, typeName: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
}

type Unlocked = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

/**
 * Takes the model lock in `repoDir` (pulling) and saves `body` as a new
 * version of data "x", leaving the push to the caller: `flush` publishes
 * the version and releases the lock, `close` closes the catalog after.
 */
async function lockAndSave(repoDir: string, modelId: string, body: string) {
  const ctx: Unlocked = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  const lock = await acquireModelLocks(
    ctx.datastoreConfig,
    [{ modelType: modelType.normalized, modelId }],
    repoDir,
    ctx.syncService,
    ctx.repoContext.catalogStore,
    undefined,
    { repoContext: ctx.repoContext },
  );
  if (lock.synced) ctx.repoContext.catalogStore.invalidate();
  const saved = await ctx.repoContext.unifiedDataRepo.save(
    modelType,
    modelId,
    item(),
    new TextEncoder().encode(body),
  );
  const written: WrittenVersion[] = [{
    modelType: modelType.normalized,
    modelId,
    dataName: "x",
    version: saved.version,
  }];
  return {
    version: saved.version,
    flush: () => lock.flush(written),
    /** An unlocked push of everything dirty, as `workflow run` ends with. */
    pushUnlocked: async () => {
      await ctx.syncService!.pushChanged();
    },
    close: async () => {
      await flushDatastoreSync();
      ctx.repoContext.catalogStore.close();
    },
  };
}

async function saveAndPush(repoDir: string, modelId: string, body: string) {
  const run = await lockAndSave(repoDir, modelId, body);
  try {
    await run.flush();
  } finally {
    await run.close();
  }
  return run.version;
}

function item(): Data {
  return Data.create({
    name: "x",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource", modelName: "m1" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

/** The bodies of the remote's committed objects under the model. */
function remoteBodies(remote: InMemoryRemote, modelId: string): string[] {
  const decoder = new TextDecoder();
  return [...remote.files()]
    .filter(([key]) => key.includes(modelId))
    .map(([, bytes]) => decoder.decode(bytes))
    .filter((body) => body.startsWith("{"));
}

interface Clones {
  remote: InMemoryRemote;
  locks: LockTable;
  repoA: string;
  repoB: string;
  modelId: string;
}

/** Two clones of one repo on one remote and one lock table. */
async function withClones(
  twoPhaseSync: boolean,
  fn: (clones: Clones) => Promise<void>,
  options: { blindA?: boolean; bSameProcess?: boolean } = {},
): Promise<void> {
  const remote = createInMemoryRemote({
    capabilities: twoPhaseSync ? { twoPhaseSync: true } : {},
  });
  const locks = new LockTable();
  const typeA = registerTestDatastoreType(remote, {
    createLock: locks.lockFor(PROCESS_A.pid, options.blindA),
  });
  const typeB = registerTestDatastoreType(remote, {
    createLock: locks.lockFor(
      options.bSameProcess ? PROCESS_A.pid : PROCESS_A.pid + 1,
    ),
  });
  try {
    await withTempDir(async (dir) => {
      const repoA = join(dir, "a");
      const repoB = join(dir, "b");
      await initRepo(repoA, typeA.typeName);
      await initRepo(repoB, typeB.typeName);
      await fn({
        remote,
        locks,
        repoA,
        repoB,
        modelId: crypto.randomUUID(),
      });
    });
  } finally {
    typeA.dispose();
    typeB.dispose();
  }
}

for (const twoPhaseSync of [true, false]) {
  Deno.test(`acquireModelLocks: a holder whose lock was force-released and taken refuses to push and keeps the other run's version (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        const bVersion = await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        assertEquals(bVersion, a.version, "both clones allocate one version");

        const error = await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(error.code, "model_lock_lost");
        assertEquals(error.lost[0].heldBy, undefined);
        // The refusal pulled B's version over A's, so a later unlocked push
        // from A (a workflow's end-of-run push) does not overwrite it.
        await a.pushUnlocked();
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
      assertEquals(c.locks.entries.size, 0, "B's push released its lock");

      // A's next run pulls B's version over its own and publishes a new one.
      const next = await saveAndPush(c.repoA, c.modelId, '{"by":"a2"}');
      assertEquals(next, a.version + 1);
      assertEquals(
        remoteBodies(c.remote, c.modelId).sort(),
        ['{"by":"a2"}', '{"by":"b"}'],
      );
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock another process holds names it and pushes nothing (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      const b = await (async () => {
        c.locks.breakglass(c.modelId);
        return await lockAndSave(c.repoB, c.modelId, '{"by":"b"}');
      })();
      try {
        const error = await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(error.lost[0].heldBy?.pid, PROCESS_A.pid + 1);
        assert(error.message.includes("Nothing was pushed"));
        assertEquals(remoteBodies(c.remote, c.modelId), []);
        assertEquals(c.locks.entries.size, 1, "A left B's lock in place");
        await b.flush();
      } finally {
        await a.close();
        await b.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock was force-released and not retaken pushes nothing (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await assertRejects(() => a.flush(), ModelLockLostError);
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), []);
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock is still its own pushes (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      await saveAndPush(c.repoA, c.modelId, '{"by":"a"}');
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"a"}']);
      assertEquals(c.locks.entries.size, 0);
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock another run of the same process took refuses to push (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      const b = await (async () => {
        c.locks.breakglass(c.modelId);
        return await lockAndSave(c.repoB, c.modelId, '{"by":"b"}');
      })();
      try {
        const error = await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(error.lost[0].heldBy?.pid, PROCESS_A.pid);
        assertEquals(remoteBodies(c.remote, c.modelId), []);
        await b.flush();
      } finally {
        await a.close();
        await b.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
    }, { bSameProcess: true });
  });

  Deno.test(`acquireModelLocks: a lock that cannot report its holder is not checked, as before (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await a.flush();
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"a"}']);
    }, { blindA: true });
  });
}
